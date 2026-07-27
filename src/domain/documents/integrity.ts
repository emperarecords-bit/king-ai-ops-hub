import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, isNotNull } from 'drizzle-orm';
import { type RunSourceSnapshot, type TenantContext } from '@/types/domain';
import { AppError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { documentChunks, documentVersions, documents, knowledgeSources, runDocumentVersions, runs } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { type ObjectStore, keyBelongsToTenant } from './object-store';
import { chunkText } from './documents';

/**
 * Documents increment 1, Stage D7 — read-only integrity audit + BOUNDED, audited repair operations. The
 * audit never mutates institutional evidence; repairs are explicit and may never silently rewrite
 * historical source text, expected hash, dispatch snapshots, or Knowledge judgments.
 */

export type IntegrityCategory =
  | 'byte_exact_object_missing'
  | 'byte_exact_hash_mismatch'
  | 'indexed_without_chunks'
  | 'current_pointer_non_indexed'
  | 'current_pointer_other_document'
  | 'current_pointer_cross_tenant'
  | 'chunk_wrong_version_or_workspace'
  | 'chunk_content_hash_mismatch'
  | 'duplicate_unavailable_placeholder'
  | 'duplicate_non_unavailable_version'
  | 'unavailable_with_content'
  | 'reconstructed_without_chunks'
  | 'knowledge_pointer_inconsistent'
  | 'run_reference_inconsistent'
  | 'orphan_object'
  | 'version_without_document';

export type RepairRecommendation = 'reverify_object' | 'rebuild_chunks_from_bytes' | 'restore_run_reference' | 'mark_object_unavailable' | 'reconnect_document' | 'reclassify' | 'operator_review';

export interface IntegrityFinding {
  category: IntegrityCategory;
  versionId?: string;
  documentId?: string;
  detail: string;
  repair: RepairRecommendation;
}

export interface IntegrityReport {
  projectId: string;
  byCategory: Record<IntegrityCategory, number>;
  findings: IntegrityFinding[];
  versionsScanned: number;
  objectsScanned: number;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}
function emptyCounts(): Record<IntegrityCategory, number> {
  return {
    byte_exact_object_missing: 0, byte_exact_hash_mismatch: 0, indexed_without_chunks: 0, current_pointer_non_indexed: 0,
    current_pointer_other_document: 0, current_pointer_cross_tenant: 0, chunk_wrong_version_or_workspace: 0, chunk_content_hash_mismatch: 0,
    duplicate_unavailable_placeholder: 0, duplicate_non_unavailable_version: 0, unavailable_with_content: 0, reconstructed_without_chunks: 0,
    knowledge_pointer_inconsistent: 0, run_reference_inconsistent: 0, orphan_object: 0, version_without_document: 0,
  };
}

/** Run every read-only integrity check for a workspace and return findings + bounded repair
 *  recommendations. Never mutates anything. */
export async function auditDocumentIntegrity(tx: DbTx, ctx: TenantContext, store: ObjectStore): Promise<IntegrityReport> {
  const byCategory = emptyCounts();
  const findings: IntegrityFinding[] = [];
  const add = (f: IntegrityFinding) => {
    byCategory[f.category] += 1;
    findings.push(f);
  };

  const docs = await tx.select({ id: documents.id, currentVersionId: documents.currentVersionId }).from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));
  const docIds = new Set(docs.map((d) => d.id));

  const versions = await tx
    .select({ id: documentVersions.id, documentId: documentVersions.documentId, orgId: documentVersions.orgId, projectId: documentVersions.projectId, sha256: documentVersions.sha256, contentFidelity: documentVersions.contentFidelity, indexStatus: documentVersions.indexStatus, objectKey: documentVersions.objectKey })
    .from(documentVersions)
    .where(and(eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId)));

  const versionById = new Map(versions.map((v) => [v.id, v]));
  const knownKeys = new Set<string>();
  const shaByKind = new Map<string, { unavailable: number; other: number }>(); // (docId|sha) → counts

  // Chunk counts per version.
  const chunks = await tx.select({ id: documentChunks.id, versionId: documentChunks.documentVersionId, documentId: documentChunks.documentId, orgId: documentChunks.orgId, projectId: documentChunks.projectId, content: documentChunks.content, contentHash: documentChunks.contentHash }).from(documentChunks).where(and(eq(documentChunks.orgId, ctx.orgId), eq(documentChunks.projectId, ctx.projectId)));
  const chunkCountByVersion = new Map<string, number>();
  for (const c of chunks) {
    if (c.versionId) chunkCountByVersion.set(c.versionId, (chunkCountByVersion.get(c.versionId) ?? 0) + 1);
    // chunk-content hash consistency
    if (c.versionId && c.contentHash && c.contentHash !== sha256Hex(Buffer.from(c.content, 'utf8'))) {
      add({ category: 'chunk_content_hash_mismatch', versionId: c.versionId, detail: 'chunk content_hash does not match its text', repair: 'operator_review' });
    }
    // chunk belongs to a version of the WRONG document/workspace
    if (c.versionId) {
      const v = versionById.get(c.versionId);
      if (v && (v.documentId !== c.documentId || v.orgId !== c.orgId || v.projectId !== c.projectId)) {
        add({ category: 'chunk_wrong_version_or_workspace', versionId: c.versionId, documentId: c.documentId, detail: 'chunk linked to a version of a different document/workspace', repair: 'operator_review' });
      }
    }
  }

  for (const v of versions) {
    // version whose document is gone (FK cascade normally prevents this)
    if (!docIds.has(v.documentId)) add({ category: 'version_without_document', versionId: v.id, documentId: v.documentId, detail: 'version references a missing logical document', repair: 'operator_review' });

    // duplicate (doc, sha) tracking
    const k = `${v.documentId}|${v.sha256}`;
    const cur = shaByKind.get(k) ?? { unavailable: 0, other: 0 };
    if (v.contentFidelity === 'unavailable') cur.unavailable += 1;
    else cur.other += 1;
    shaByKind.set(k, cur);

    const chunkN = chunkCountByVersion.get(v.id) ?? 0;
    if (v.contentFidelity === 'unavailable') {
      if (chunkN > 0 || v.objectKey) add({ category: 'unavailable_with_content', versionId: v.id, documentId: v.documentId, detail: 'unavailable version has chunks or an object', repair: 'operator_review' });
    } else if (v.contentFidelity === 'reconstructed_text') {
      if (chunkN === 0) add({ category: 'reconstructed_without_chunks', versionId: v.id, documentId: v.documentId, detail: 'reconstructed_text version has no chunks', repair: 'operator_review' });
    } else if (v.contentFidelity === 'byte_exact') {
      if (v.indexStatus === 'indexed' && chunkN === 0) add({ category: 'indexed_without_chunks', versionId: v.id, documentId: v.documentId, detail: 'indexed byte_exact version has no chunks', repair: 'rebuild_chunks_from_bytes' });
      if (!v.objectKey) {
        add({ category: 'byte_exact_object_missing', versionId: v.id, documentId: v.documentId, detail: 'byte_exact version has no object key', repair: 'mark_object_unavailable' });
      } else {
        knownKeys.add(v.objectKey);
        try {
          const bytes = await store.get(v.objectKey);
          if (sha256Hex(bytes) !== v.sha256) add({ category: 'byte_exact_hash_mismatch', versionId: v.id, documentId: v.documentId, detail: 'retained object hash != recorded version hash', repair: 'mark_object_unavailable' });
        } catch {
          add({ category: 'byte_exact_object_missing', versionId: v.id, documentId: v.documentId, detail: 'retained object missing/unreadable', repair: 'mark_object_unavailable' });
        }
      }
    }
  }
  for (const [k, c] of shaByKind) {
    if (c.unavailable > 1) add({ category: 'duplicate_unavailable_placeholder', detail: `>1 unavailable placeholder for ${k}`, repair: 'operator_review' });
    if (c.other > 1) add({ category: 'duplicate_non_unavailable_version', detail: `>1 retained version for ${k}`, repair: 'operator_review' });
  }

  // Current-pointer invariants.
  for (const d of docs) {
    if (!d.currentVersionId) continue;
    const v = versionById.get(d.currentVersionId);
    if (!v) {
      // pointer to a version not in this workspace's set (possibly cross-tenant / missing)
      const foreign = (await tx.select({ orgId: documentVersions.orgId, projectId: documentVersions.projectId, documentId: documentVersions.documentId }).from(documentVersions).where(eq(documentVersions.id, d.currentVersionId)).limit(1))[0];
      if (foreign && (foreign.orgId !== ctx.orgId || foreign.projectId !== ctx.projectId)) add({ category: 'current_pointer_cross_tenant', documentId: d.id, detail: 'current pointer references another workspace', repair: 'operator_review' });
      else if (foreign && foreign.documentId !== d.id) add({ category: 'current_pointer_other_document', documentId: d.id, detail: 'current pointer references another document', repair: 'operator_review' });
      else add({ category: 'current_pointer_non_indexed', documentId: d.id, detail: 'current pointer references a missing version', repair: 'operator_review' });
      continue;
    }
    if (v.documentId !== d.id) add({ category: 'current_pointer_other_document', documentId: d.id, versionId: v.id, detail: 'current pointer references a version of another document', repair: 'operator_review' });
    else if (v.indexStatus !== 'indexed') add({ category: 'current_pointer_non_indexed', documentId: d.id, versionId: v.id, detail: 'current pointer references a non-indexed version', repair: 'operator_review' });
  }

  // Knowledge pointer consistency: bound version's hash must match the cited hash.
  const ks = await tx.select({ id: knowledgeSources.id, documentVersionId: knowledgeSources.documentVersionId, sourceVersionHash: knowledgeSources.sourceVersionHash }).from(knowledgeSources).where(and(eq(knowledgeSources.orgId, ctx.orgId), eq(knowledgeSources.projectId, ctx.projectId), isNotNull(knowledgeSources.documentVersionId)));
  for (const s of ks) {
    const v = versionById.get(s.documentVersionId!);
    if (!v) add({ category: 'knowledge_pointer_inconsistent', detail: 'knowledge source points to a missing version', repair: 'operator_review' });
    else if (s.sourceVersionHash && v.sha256 !== s.sourceVersionHash) add({ category: 'knowledge_pointer_inconsistent', versionId: v.id, detail: 'knowledge source version hash disagrees with cited hash', repair: 'operator_review' });
  }

  // Run reference consistency: every normalized run→version row should be reflected in the run's snapshot.
  const runRefs = await tx.select({ runId: runDocumentVersions.runId, versionId: runDocumentVersions.documentVersionId }).from(runDocumentVersions).where(and(eq(runDocumentVersions.orgId, ctx.orgId), eq(runDocumentVersions.projectId, ctx.projectId)));
  const runSnapCache = new Map<string, Set<string>>();
  for (const r of runRefs) {
    let snapVersions = runSnapCache.get(r.runId);
    if (!snapVersions) {
      const run = (await tx.select({ retrievedSources: runs.retrievedSources }).from(runs).where(eq(runs.id, r.runId)).limit(1))[0];
      const snaps = (run?.retrievedSources as RunSourceSnapshot[] | null) ?? [];
      snapVersions = new Set(snaps.map((s) => s.documentVersionId).filter((x): x is string => !!x));
      runSnapCache.set(r.runId, snapVersions);
    }
    if (snapVersions.size > 0 && !snapVersions.has(r.versionId)) {
      add({ category: 'run_reference_inconsistent', versionId: r.versionId, detail: 'normalized run reference not present in the run snapshot', repair: 'operator_review' });
    }
  }

  // Orphan objects (referenced by no document.object_key and no version).
  let objectsScanned = 0;
  if (typeof store.list === 'function') {
    for (const d of await tx.select({ objectKey: documents.objectKey }).from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), isNotNull(documents.objectKey)))) {
      if (d.objectKey) knownKeys.add(d.objectKey);
    }
    try {
      const keys = await store.list(`org/${ctx.orgId}/project/${ctx.projectId}/`);
      objectsScanned = keys.length;
      for (const key of keys) {
        if (!keyBelongsToTenant(key, ctx)) continue;
        if (!knownKeys.has(key)) add({ category: 'orphan_object', detail: `object ${key} referenced by no document or version`, repair: 'operator_review' });
      }
    } catch {
      /* store list unavailable this run */
    }
  }

  return { projectId: ctx.projectId, byCategory, findings, versionsScanned: versions.length, objectsScanned };
}

// ---- Bounded, audited repair operations ---------------------------------------------------------

/** Re-verify a byte_exact version's retained object against its recorded hash. Read-only result. */
export async function reverifyObject(tx: DbTx, ctx: TenantContext, store: ObjectStore, versionId: string): Promise<{ ok: boolean; state: 'verified' | 'hash_mismatch' | 'missing' | 'not_byte_exact' }> {
  const v = (await tx.select({ sha256: documentVersions.sha256, objectKey: documentVersions.objectKey, contentFidelity: documentVersions.contentFidelity }).from(documentVersions).where(and(eq(documentVersions.id, versionId), eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId))).limit(1))[0];
  if (!v || v.contentFidelity !== 'byte_exact' || !v.objectKey) return { ok: false, state: 'not_byte_exact' };
  try {
    const bytes = await store.get(v.objectKey);
    return sha256Hex(bytes) === v.sha256 ? { ok: true, state: 'verified' } : { ok: false, state: 'hash_mismatch' };
  } catch {
    return { ok: false, state: 'missing' };
  }
}

/**
 * Rebuild the version-specific chunks of a byte_exact version FROM its exact retained bytes. Preserves the
 * version identity and hash (the bytes and thus the derived chunks are unchanged); only used when the
 * chunks were lost. Never rewrites historical text. Audited.
 */
export async function rebuildVersionChunksFromBytes(tx: DbTx, ctx: TenantContext, store: ObjectStore, versionId: string): Promise<{ rebuilt: boolean; chunks: number }> {
  const v = (await tx.select({ id: documentVersions.id, documentId: documentVersions.documentId, sha256: documentVersions.sha256, objectKey: documentVersions.objectKey, contentFidelity: documentVersions.contentFidelity }).from(documentVersions).where(and(eq(documentVersions.id, versionId), eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId))).limit(1))[0];
  if (!v || v.contentFidelity !== 'byte_exact' || !v.objectKey) throw new AppError('validation', 'Only a byte_exact version with a retained object can rebuild chunks.');
  const existing = (await tx.select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentVersionId, versionId))).length;
  if (existing > 0) return { rebuilt: false, chunks: existing }; // never duplicate existing chunks
  const bytes = await store.get(v.objectKey);
  if (sha256Hex(bytes) !== v.sha256) throw new AppError('conflict', 'Retained object hash no longer matches — cannot rebuild as byte_exact.');
  const contents = chunkText(bytes.toString('utf8'));
  if (contents.length > 0) {
    await tx.insert(documentChunks).values(contents.map((content, i) => ({ orgId: ctx.orgId, projectId: ctx.projectId, documentId: v.documentId, documentVersionId: versionId, chunkIndex: i, content, parserVersion: 'chunk-v1', contentHash: sha256Hex(Buffer.from(content, 'utf8')) })));
  }
  await writeAudit(tx, ctx, { action: 'document.version_chunks_rebuilt', entityType: 'document', entityId: v.documentId, detail: { versionId, chunks: contents.length } });
  return { rebuilt: true, chunks: contents.length };
}

/**
 * Restore a missing normalized run→version relationship from the run's IMMUTABLE snapshot. Additive only —
 * it reads the historical snapshot (never rewrites it) and inserts the missing reference rows. Audited.
 */
export async function restoreRunReferenceFromSnapshot(tx: DbTx, ctx: TenantContext, runId: string): Promise<{ versionLevel: number; chunkLevel: number }> {
  const run = (await tx.select({ retrievedSources: runs.retrievedSources }).from(runs).where(and(eq(runs.id, runId), eq(runs.orgId, ctx.orgId), eq(runs.projectId, ctx.projectId))).limit(1))[0];
  if (!run) throw new AppError('not_found', 'Run not found.');
  const snaps = (run.retrievedSources as RunSourceSnapshot[] | null) ?? [];
  let versionLevel = 0;
  let chunkLevel = 0;
  const versionSeen = new Set<string>();
  for (const s of snaps) {
    if (!s.documentVersionId) continue;
    // Only restore for versions that still exist in this workspace (never fabricate a reference).
    const v = (await tx.select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.id, s.documentVersionId), eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId))).limit(1))[0];
    if (!v) continue;
    if (!versionSeen.has(s.documentVersionId)) {
      versionSeen.add(s.documentVersionId);
      const ins = await tx.insert(runDocumentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId, documentVersionId: s.documentVersionId, chunkIndex: -1, rank: s.rank ?? null, disclosureSnapshot: s.disclosure }).onConflictDoNothing().returning({ id: runDocumentVersions.id });
      if (ins.length > 0) versionLevel += 1;
    }
    const insC = await tx.insert(runDocumentVersions).values({ orgId: ctx.orgId, projectId: ctx.projectId, runId, documentVersionId: s.documentVersionId, chunkIndex: s.chunkIndex, rank: s.rank ?? null, disclosureSnapshot: s.disclosure, retrievalReason: 'restore' }).onConflictDoNothing().returning({ id: runDocumentVersions.id });
    if (insC.length > 0) chunkLevel += 1;
  }
  if (versionLevel > 0 || chunkLevel > 0) await writeAudit(tx, ctx, { action: 'document.run_reference_restored', entityType: 'run', entityId: runId, detail: { versionLevel, chunkLevel } });
  return { versionLevel, chunkLevel };
}
