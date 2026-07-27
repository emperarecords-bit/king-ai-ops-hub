import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { type RunSourceSnapshot, type TenantContext } from '@/types/domain';
import { AppError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { documentChunks, documentVersionTombstones, documentVersions, documents, knowledgeSources, runDocumentVersions, runs } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { type ObjectStore } from './object-store';

/**
 * Documents increment 1, Stage D5/D6 — the retention/purge contract and the legacy-object cleanup
 * assessment. Archive and PURGE are separate: archive stops current retrieval but preserves every version,
 * object, chunk, and relationship; purge is a privileged destructive operation that must begin with a
 * retention assessment and be RE-checked inside the destructive transaction.
 *
 * Principle: purge authorization is a current judgment, not a reusable token.
 */

export type PurgeDecision =
  | 'purge_permitted'
  | 'purge_blocked_by_current_use'
  | 'purge_blocked_by_institutional_evidence'
  | 'purge_blocked_by_retention_policy'
  | 'purge_assessment_incomplete'
  | 'purge_already_completed';

export type BlockerCategory = 'current_version_pointer' | 'knowledge_source' | 'run_normalized_reference' | 'run_snapshot' | 'retention_policy';

export interface PurgeAssessment {
  versionId: string;
  decision: PurgeDecision;
  /** Blocking relationship categories + counts. Never includes restricted content — ids/counts only. */
  blockers: { category: BlockerCategory; count: number }[];
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Count the run immutable-snapshot JSON references to a version (the backstop when normalized references
 *  may be incomplete — e.g. runs assembled before Stage C2 or under legacy mode). */
async function runSnapshotReferences(tx: DbTx, ctx: TenantContext, versionId: string): Promise<number> {
  const rows = await tx.select({ retrievedSources: runs.retrievedSources }).from(runs).where(and(eq(runs.orgId, ctx.orgId), eq(runs.projectId, ctx.projectId)));
  let n = 0;
  for (const r of rows) {
    const snaps = (r.retrievedSources as RunSourceSnapshot[] | null) ?? [];
    if (snaps.some((s) => s.documentVersionId === versionId)) n += 1;
  }
  return n;
}

/**
 * Assess whether a version may be purged. Blocks on a current-version pointer (current use), any
 * institutional evidence (Knowledge citation, normalized run reference, or immutable run snapshot), or a
 * configured retention hold. Returns precise decision + blocking categories/counts. Purely read-only.
 */
export async function assessPurge(tx: DbTx, ctx: TenantContext, versionId: string): Promise<PurgeAssessment> {
  const tomb = (await tx.select({ id: documentVersionTombstones.id }).from(documentVersionTombstones).where(and(eq(documentVersionTombstones.versionId, versionId), eq(documentVersionTombstones.orgId, ctx.orgId), eq(documentVersionTombstones.projectId, ctx.projectId))).limit(1))[0];
  if (tomb) return { versionId, decision: 'purge_already_completed', blockers: [] };

  const v = (await tx.select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.id, versionId), eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId))).limit(1))[0];
  if (!v) return { versionId, decision: 'purge_assessment_incomplete', blockers: [] };

  const currentPtr = (await tx.select({ id: documents.id }).from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), eq(documents.currentVersionId, versionId)))).length;
  const knowledge = (await tx.select({ id: knowledgeSources.id }).from(knowledgeSources).where(and(eq(knowledgeSources.orgId, ctx.orgId), eq(knowledgeSources.projectId, ctx.projectId), eq(knowledgeSources.documentVersionId, versionId)))).length;
  const runRefs = (await tx.select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(and(eq(runDocumentVersions.orgId, ctx.orgId), eq(runDocumentVersions.projectId, ctx.projectId), eq(runDocumentVersions.documentVersionId, versionId)))).length;
  const snapRefs = await runSnapshotReferences(tx, ctx, versionId);
  const retention = 0; // no configured legal/retention holds yet — placeholder that a future policy fills.

  const blockers: PurgeAssessment['blockers'] = [];
  if (currentPtr > 0) blockers.push({ category: 'current_version_pointer', count: currentPtr });
  if (knowledge > 0) blockers.push({ category: 'knowledge_source', count: knowledge });
  if (runRefs > 0) blockers.push({ category: 'run_normalized_reference', count: runRefs });
  if (snapRefs > 0) blockers.push({ category: 'run_snapshot', count: snapRefs });
  if (retention > 0) blockers.push({ category: 'retention_policy', count: retention });

  let decision: PurgeDecision = 'purge_permitted';
  if (currentPtr > 0) decision = 'purge_blocked_by_current_use';
  else if (knowledge > 0 || runRefs > 0 || snapRefs > 0) decision = 'purge_blocked_by_institutional_evidence';
  else if (retention > 0) decision = 'purge_blocked_by_retention_policy';
  return { versionId, decision, blockers };
}

export interface PurgeResult {
  purged: boolean;
  decision: PurgeDecision;
  objectDeleted: boolean;
  blockers: PurgeAssessment['blockers'];
}

/**
 * Execute a purge, RE-assessing inside the destructive transaction (a stale assessment can never
 * authorize deletion). Deletes version chunks, the version row, and — only when no other retained version
 * shares it — the immutable object; clears any dangling pointer; writes an immutable tombstone + audit.
 */
export async function executePurge(tx: DbTx, ctx: TenantContext, store: ObjectStore, versionId: string, reason?: string): Promise<PurgeResult> {
  const assessment = await assessPurge(tx, ctx, versionId); // re-check NOW, inside the transaction
  if (assessment.decision !== 'purge_permitted') {
    return { purged: false, decision: assessment.decision, objectDeleted: false, blockers: assessment.blockers };
  }

  const v = (await tx.select({ id: documentVersions.id, documentId: documentVersions.documentId, sha256: documentVersions.sha256, contentFidelity: documentVersions.contentFidelity, objectKey: documentVersions.objectKey }).from(documentVersions).where(eq(documentVersions.id, versionId)).limit(1))[0]!;

  // Delete version-specific chunks.
  await tx.delete(documentChunks).where(eq(documentChunks.documentVersionId, versionId));

  // Delete the immutable object ONLY if no other retained version references it.
  let objectDeleted = false;
  if (v.objectKey) {
    const shared = (await tx.select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.objectKey, v.objectKey), ne(documentVersions.id, versionId), eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId))).limit(1))[0];
    if (!shared) {
      await store.delete(v.objectKey).catch(() => {}); // idempotent; a missing object is already gone
      objectDeleted = true;
    }
  }

  // Defensive: clear any logical pointer to the purged version (current-use would have blocked, but never
  // leave a dangling current_version_id behind).
  await tx.update(documents).set({ currentVersionId: null, updatedAt: new Date() }).where(and(eq(documents.currentVersionId, versionId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));

  await tx.delete(documentVersions).where(eq(documentVersions.id, versionId));

  await tx.insert(documentVersionTombstones).values({ orgId: ctx.orgId, projectId: ctx.projectId, versionId, documentId: v.documentId, sha256: v.sha256, contentFidelity: v.contentFidelity, objectKey: v.objectKey, objectDeleted, reason: reason ?? null, purgedBy: ctx.userId });
  await writeAudit(tx, ctx, { action: 'document.version_purged', entityType: 'document', entityId: v.documentId, detail: { versionId, sha256: v.sha256.slice(0, 12), objectDeleted, reason: reason ?? null } });

  return { purged: true, decision: 'purge_permitted', objectDeleted, blockers: [] };
}

// ---- D6: legacy filename-keyed object cleanup assessment (read-only) -----------------------------

export type LegacyObjectClass = 'still_referenced' | 'rollback_required' | 'superseded_retained' | 'eligible_for_later_cleanup' | 'integrity_mismatch' | 'unknown';

export interface LegacyObjectAssessment {
  byClass: Record<LegacyObjectClass, number>;
  objects: { objectKey: string; documentId: string; class: LegacyObjectClass; supersededByVersionObject: boolean }[];
}

/**
 * Read-only assessment of the pre-version filename-keyed cloud objects. Every such object is still
 * referenced by `documents.object_key` (upload/download/retry/legacy-retrieval/rollback all use it), so
 * none is eligible for cleanup yet; an object that no longer hashes to its Document's recorded hash is an
 * integrity mismatch. NEVER deletes anything.
 */
export async function assessLegacyObjects(tx: DbTx, ctx: TenantContext, store: ObjectStore): Promise<LegacyObjectAssessment> {
  const byClass: Record<LegacyObjectClass, number> = { still_referenced: 0, rollback_required: 0, superseded_retained: 0, eligible_for_later_cleanup: 0, integrity_mismatch: 0, unknown: 0 };
  const objects: LegacyObjectAssessment['objects'] = [];

  const docs = await tx
    .select({ id: documents.id, objectKey: documents.objectKey, sha256: documents.sha256, currentVersionId: documents.currentVersionId, source: documents.source })
    .from(documents)
    .where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));

  for (const d of docs) {
    if (!d.objectKey) continue; // no legacy object
    // Is this legacy object superseded by a distinct byte_exact version object?
    const curKey = d.currentVersionId
      ? (await tx.select({ objectKey: documentVersions.objectKey }).from(documentVersions).where(eq(documentVersions.id, d.currentVersionId)).limit(1))[0]?.objectKey ?? null
      : null;
    const superseded = d.source === 'cloud_upload' && !!curKey && curKey !== d.objectKey;

    let cls: LegacyObjectClass;
    try {
      const bytes = await store.get(d.objectKey);
      if (sha256Hex(bytes) !== d.sha256) cls = 'integrity_mismatch';
      else cls = 'still_referenced'; // referenced by documents.object_key; needed for legacy retrieval + rollback
    } catch {
      cls = 'unknown'; // present in metadata but the object could not be read this run
    }
    byClass[cls] += 1;
    if (cls === 'still_referenced') byClass.rollback_required += 1; // also required for rollback
    if (superseded) byClass.superseded_retained += 1;
    objects.push({ objectKey: d.objectKey, documentId: d.id, class: cls, supersededByVersionObject: superseded });
  }
  return { byClass, objects };
}

/** Guard against a client forging a purge authorization: purge is a server-only domain operation gated by
 *  the current assessment; there is no client-supplied token. This asserts the caller is an admin/owner. */
export function assertPurgeAuthority(ctx: TenantContext): void {
  if (ctx.orgRole !== 'owner' && ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Purge requires workspace owner or project admin authority.');
  }
}
