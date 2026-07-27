import 'server-only';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { type ContentFidelity, type KnowledgeDisclosure, type RunSourceSnapshot, type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { documentChunks, documentVersions, documents, knowledgeSources, projects, runDocumentVersions, runs } from '@/db/schema';
import { type ObjectStore, ObjectNotFoundError, keyBelongsToTenant } from './object-store';
import { setCurrentVersion, versionObjectKey } from './versions';

/**
 * Documents increment 1, Stage C1 — BACKFILL, fidelity classification, evidence-reference reconciliation,
 * and audit. Populates the immutable version model for documents that pre-date Stage B (or whose Stage B
 * dual-write was missed), WITHOUT switching retrieval, deleting legacy columns, purging orphans, or
 * rewriting historical prompt snapshots.
 *
 * Correctness rules encoded here (from the Stage C1 spec):
 *  - byte_exact ONLY when raw bytes are readable AND hash-verified AND retained under the immutable key.
 *  - reconstructed_text when exact bytes can't be verified but legacy chunks preserve inspectable text;
 *    the version's chunks are COPIES of the legacy null-version chunks (originals untouched, so legacy
 *    retrieval is byte-for-byte unchanged).
 *  - unavailable when neither bytes nor sufficient chunks exist — a terminal (`failed`) version that
 *    records identity/integrity but exposes no preview and never becomes current.
 *  - a currently-readable path is NOT evidence of the earlier indexed state unless its bytes match the
 *    recorded hash; a changed local file is left to normal ingestion as a separate later version.
 *  - restart-safe: reruns reuse the (documentId, sha256) version, the content-addressed object, migrated
 *    chunks, and the normalized references — never duplicating any of them.
 */

const PARSER_VERSION = 'chunk-v1';

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export interface FidelityCounts {
  byte_exact: number;
  reconstructed_text: number;
  unavailable: number;
}
const zeroFidelity = (): FidelityCounts => ({ byte_exact: 0, reconstructed_text: 0, unavailable: 0 });

export interface BackfillDefect {
  docId?: string;
  kind: string;
  detail: string;
}

export interface ProjectBackfillReport {
  orgId: string;
  projectId: string;
  baseline: {
    documents: number;
    bySource: Record<string, number>;
    byStatus: Record<string, number>;
    withCurrentVersion: number;
    withoutCurrentVersion: number;
    withObjectKey: number;
    withoutObject: number;
    legacyChunks: number;
    knowledgeDocSources: number;
    runSnapshotDocRefs: number;
  };
  versions: {
    created: number;
    reused: number;
    byFidelity: FidelityCounts;
    chunksCopied: number;
    currentAssigned: number;
    currentWithheld: number;
    duplicatesPrevented: number;
  };
  fidelityByAdapter: Record<string, FidelityCounts>;
  storage: {
    objectsCreated: number;
    objectsReused: number;
    hashMismatches: number;
    missingObjects: number;
    bytesRetained: number;
    orphanObjects: number;
    orphanScan: 'local' | 's3' | 'skipped';
  };
  knowledgeRefs: {
    resolved: number;
    unresolved: number;
    unresolvedByReason: Record<string, number>;
  };
  runRefs: {
    versionLevelCreated: number;
    chunkLevelCreated: number;
    resolved: number;
    unresolved: number;
    ambiguous: number;
    crossWorkspaceRejected: number;
  };
  dualWrite: {
    examined: number;
    gaps: number;
    reconciled: number;
    remainingDefects: number;
  };
  integrity: {
    byteExactMissingObject: number;
    byteExactHashMismatch: number;
    versionChunksOrphaned: number;
    currentPointerInvariant: number;
    localChangedSinceIndex: number;
  };
  gate: {
    activeIndexed: number;
    withValidCurrent: number;
    withoutValidCurrent: number;
    unresolvedActiveDocIds: string[];
  };
  defects: BackfillDefect[];
  notes: string[];
}

function emptyReport(orgId: string, projectId: string): ProjectBackfillReport {
  return {
    orgId,
    projectId,
    baseline: {
      documents: 0,
      bySource: {},
      byStatus: {},
      withCurrentVersion: 0,
      withoutCurrentVersion: 0,
      withObjectKey: 0,
      withoutObject: 0,
      legacyChunks: 0,
      knowledgeDocSources: 0,
      runSnapshotDocRefs: 0,
    },
    versions: { created: 0, reused: 0, byFidelity: zeroFidelity(), chunksCopied: 0, currentAssigned: 0, currentWithheld: 0, duplicatesPrevented: 0 },
    fidelityByAdapter: { local_folder: zeroFidelity(), cloud_upload: zeroFidelity() },
    storage: { objectsCreated: 0, objectsReused: 0, hashMismatches: 0, missingObjects: 0, bytesRetained: 0, orphanObjects: 0, orphanScan: 'skipped' },
    knowledgeRefs: { resolved: 0, unresolved: 0, unresolvedByReason: {} },
    runRefs: { versionLevelCreated: 0, chunkLevelCreated: 0, resolved: 0, unresolved: 0, ambiguous: 0, crossWorkspaceRejected: 0 },
    dualWrite: { examined: 0, gaps: 0, reconciled: 0, remainingDefects: 0 },
    integrity: { byteExactMissingObject: 0, byteExactHashMismatch: 0, versionChunksOrphaned: 0, currentPointerInvariant: 0, localChangedSinceIndex: 0 },
    gate: { activeIndexed: 0, withValidCurrent: 0, withoutValidCurrent: 0, unresolvedActiveDocIds: [] },
    defects: [],
    notes: [],
  };
}

interface DocRow {
  id: string;
  source: string;
  relativePath: string;
  sha256: string;
  sizeBytes: number;
  disclosure: KnowledgeDisclosure;
  status: string;
  objectKey: string | null;
  mimeType: string | null;
  sourceModifiedAt: Date | null;
  ingestedAt: Date | null;
  indexedAt: Date | null;
  currentVersionId: string | null;
}

interface VersionRow {
  id: string;
  documentId: string;
  orgId: string;
  projectId: string;
  sha256: string;
  indexStatus: string;
  contentFidelity: ContentFidelity;
  objectKey: string | null;
}

/**
 * Backfill one workspace's documents into the immutable version model, reconcile evidence references, and
 * audit. Idempotent: safe to re-run after any interruption. `operationId` ties every created version to
 * the backfill operation (audit/provenance). Returns a structured reconciliation report.
 */
export async function backfillProject(
  tx: DbTx,
  ctx: TenantContext,
  store: ObjectStore,
  opts: { operationId: string; stageBDeployedAt?: Date | null },
): Promise<ProjectBackfillReport> {
  const report = emptyReport(ctx.orgId, ctx.projectId);

  const folderRow = (
    await tx.select({ path: projects.documentFolderPath }).from(projects).where(and(eq(projects.id, ctx.projectId), eq(projects.orgId, ctx.orgId))).limit(1)
  )[0];
  const folderPath = folderRow?.path ?? null;

  const docs: DocRow[] = await tx
    .select({
      id: documents.id,
      source: documents.source,
      relativePath: documents.relativePath,
      sha256: documents.sha256,
      sizeBytes: documents.sizeBytes,
      disclosure: documents.disclosure,
      status: documents.status,
      objectKey: documents.objectKey,
      mimeType: documents.mimeType,
      sourceModifiedAt: documents.sourceModifiedAt,
      ingestedAt: documents.ingestedAt,
      indexedAt: documents.indexedAt,
      currentVersionId: documents.currentVersionId,
    })
    .from(documents)
    .where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));

  await computeBaseline(tx, ctx, docs, report);

  // ---- Per-document backfill --------------------------------------------------------------------
  for (const doc of docs) {
    await backfillOneDocument(tx, ctx, store, doc, folderPath, opts, report);
  }

  // ---- Evidence-reference reconciliation --------------------------------------------------------
  await reconcileKnowledgeRefs(tx, ctx, report);
  await reconcileRunRefs(tx, ctx, report);

  // ---- Audit: integrity of byte_exact objects, orphan chunks, orphan objects, and the gate ------
  await auditIntegrity(tx, ctx, store, report);
  await computeGate(tx, ctx, report);

  return report;
}

async function computeBaseline(tx: DbTx, ctx: TenantContext, docs: DocRow[], report: ProjectBackfillReport): Promise<void> {
  report.baseline.documents = docs.length;
  for (const d of docs) {
    report.baseline.bySource[d.source] = (report.baseline.bySource[d.source] ?? 0) + 1;
    report.baseline.byStatus[d.status] = (report.baseline.byStatus[d.status] ?? 0) + 1;
    if (d.currentVersionId) report.baseline.withCurrentVersion += 1;
    else report.baseline.withoutCurrentVersion += 1;
    if (d.objectKey) report.baseline.withObjectKey += 1;
    else report.baseline.withoutObject += 1;
  }
  const legacy = await tx
    .select({ id: documentChunks.id })
    .from(documentChunks)
    .where(and(eq(documentChunks.orgId, ctx.orgId), eq(documentChunks.projectId, ctx.projectId), isNull(documentChunks.documentVersionId)));
  report.baseline.legacyChunks = legacy.length;
  const ks = await tx
    .select({ id: knowledgeSources.id })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.orgId, ctx.orgId), eq(knowledgeSources.projectId, ctx.projectId), eq(knowledgeSources.sourceType, 'document')));
  report.baseline.knowledgeDocSources = ks.length;
  const runRows = await tx
    .select({ retrievedSources: runs.retrievedSources })
    .from(runs)
    .where(and(eq(runs.orgId, ctx.orgId), eq(runs.projectId, ctx.projectId)));
  let refCount = 0;
  for (const r of runRows) {
    const snaps = (r.retrievedSources as RunSourceSnapshot[] | null) ?? [];
    refCount += snaps.length;
  }
  report.baseline.runSnapshotDocRefs = refCount;
}

async function readLocalBytes(folderPath: string | null, relativePath: string): Promise<Buffer | null> {
  if (!folderPath) return null;
  const full = join(folderPath, relativePath.split('/').join(sep));
  try {
    return await readFile(full);
  } catch {
    return null; // source path gone / unreadable
  }
}

/** Idempotently ensure the immutable object exists holding exactly these bytes. Returns true if it wrote
 *  a new object, false if a correct one already existed. A same-key/different-bytes object is a hard
 *  integrity error (never overwritten). */
async function ensureObjectExists(store: ObjectStore, key: string, bytes: Buffer, sha256: string, mimeType: string): Promise<boolean> {
  const head = await store.head(key).catch(() => null);
  if (head) {
    const existing = await store.get(key);
    if (sha256Hex(existing) !== sha256) throw new Error(`object key collision on backfill: ${key}`);
    return false;
  }
  await store.put(key, bytes, mimeType);
  return true;
}

async function versionChunkCount(tx: DbTx, versionId: string): Promise<number> {
  const rows = await tx.select({ id: documentChunks.id }).from(documentChunks).where(eq(documentChunks.documentVersionId, versionId));
  return rows.length;
}

async function backfillOneDocument(
  tx: DbTx,
  ctx: TenantContext,
  store: ObjectStore,
  doc: DocRow,
  folderPath: string | null,
  opts: { operationId: string; stageBDeployedAt?: Date | null },
  report: ProjectBackfillReport,
): Promise<void> {
  const versions: VersionRow[] = await tx
    .select({
      id: documentVersions.id,
      documentId: documentVersions.documentId,
      orgId: documentVersions.orgId,
      projectId: documentVersions.projectId,
      sha256: documentVersions.sha256,
      indexStatus: documentVersions.indexStatus,
      contentFidelity: documentVersions.contentFidelity,
      objectKey: documentVersions.objectKey,
    })
    .from(documentVersions)
    .where(eq(documentVersions.documentId, doc.id));

  const currentVer = doc.currentVersionId ? versions.find((v) => v.id === doc.currentVersionId) : undefined;
  const currentValid =
    !!currentVer && currentVer.indexStatus === 'indexed' && currentVer.documentId === doc.id && currentVer.orgId === ctx.orgId && currentVer.projectId === ctx.projectId;

  // A current pointer set to something that fails the invariant is an integrity defect.
  if (doc.currentVersionId && !currentValid) {
    report.integrity.currentPointerInvariant += 1;
    report.defects.push({ docId: doc.id, kind: 'current_pointer_invariant', detail: 'current_version_id does not reference an indexed same-document version' });
  }

  // Whether this is a Stage-B-era gap (legacy-indexed after Stage B, no usable current version).
  const isStageBGap = doc.status === 'active' && !currentValid && versions.length === 0;
  if (isStageBGap) {
    report.dualWrite.examined += 1;
    report.dualWrite.gaps += 1;
  }

  if (currentValid) {
    report.versions.reused += 1;
    report.fidelityByAdapter[doc.source]![currentVer!.contentFidelity] += 1;
    return; // already reconciled (Stage B dual-write or a prior backfill run)
  }

  const legacyHash = doc.sha256;
  const legacyChunks = await tx
    .select({ chunkIndex: documentChunks.chunkIndex, content: documentChunks.content, locator: documentChunks.locator })
    .from(documentChunks)
    .where(and(eq(documentChunks.documentId, doc.id), isNull(documentChunks.documentVersionId)))
    .orderBy(documentChunks.chunkIndex);
  const hasChunks = legacyChunks.length > 0;

  const existingVer = versions.find((v) => v.sha256 === legacyHash);

  let versionId: string;
  let fidelity: ContentFidelity;
  let indexStatus: string;

  if (existingVer) {
    // Reuse the immutable version exactly as persisted (never rewrite its facts).
    versionId = existingVer.id;
    fidelity = existingVer.contentFidelity;
    indexStatus = existingVer.indexStatus;
    report.versions.duplicatesPrevented += 1;
    // Top up a byte_exact object if we can (idempotent, hash-verified).
    if (fidelity === 'byte_exact' && existingVer.objectKey) {
      const bytes = await materializeBytes(store, doc, folderPath, legacyHash, report);
      if (bytes) await ensureObjectExists(store, existingVer.objectKey, bytes, legacyHash, doc.mimeType ?? 'text/plain').catch(() => false);
    }
  } else {
    // Classify + (for byte_exact) retain bytes, then insert a fresh immutable version.
    const classified = await classifyAndRetain(store, ctx, doc, folderPath, legacyHash, hasChunks, report);
    if (classified === 'retryable_defect') {
      report.defects.push({ docId: doc.id, kind: 'cloud_object_read_error', detail: 'transient object read failure — retry backfill' });
      if (isStageBGap) report.dualWrite.remainingDefects += 1;
      report.gate.unresolvedActiveDocIds.push(doc.id);
      return;
    }
    fidelity = classified.fidelity;
    const inserted = await tx
      .insert(documentVersions)
      .values({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        documentId: doc.id,
        sha256: legacyHash,
        sizeBytes: classified.bytes?.length ?? doc.sizeBytes,
        mimeType: doc.mimeType,
        objectKey: classified.objectKey,
        contentFidelity: fidelity,
        disclosureSnapshot: doc.disclosure,
        sourceModifiedAt: doc.sourceModifiedAt,
        ingestedAt: doc.ingestedAt ?? doc.indexedAt ?? new Date(),
        indexStatus: 'pending',
        parserVersion: PARSER_VERSION,
        ingestionOperationId: opts.operationId,
      })
      .returning({ id: documentVersions.id });
    versionId = inserted[0]!.id;
    indexStatus = 'pending';
    report.versions.created += 1;
    report.versions.byFidelity[fidelity] += 1;
    report.fidelityByAdapter[doc.source]![fidelity] += 1;
  }

  // Copy legacy chunks into version-scoped chunks (byte_exact + reconstructed only). Idempotent + repairs
  // a partial migration. The null-version legacy chunks are NEVER touched (legacy retrieval unchanged).
  if (fidelity !== 'unavailable' && hasChunks) {
    const existingCount = await versionChunkCount(tx, versionId);
    if (existingCount !== legacyChunks.length) {
      if (existingCount > 0) await tx.delete(documentChunks).where(eq(documentChunks.documentVersionId, versionId));
      await tx.insert(documentChunks).values(
        legacyChunks.map((c) => ({
          orgId: ctx.orgId,
          projectId: ctx.projectId,
          documentId: doc.id,
          documentVersionId: versionId,
          chunkIndex: c.chunkIndex,
          content: c.content,
          locator: c.locator,
          parserVersion: PARSER_VERSION,
          contentHash: sha256Hex(Buffer.from(c.content, 'utf8')),
        })),
      );
      report.versions.chunksCopied += legacyChunks.length;
    }
  }

  // Index-status transition + conservative current assignment.
  if (fidelity === 'unavailable') {
    if (indexStatus === 'pending') {
      await tx
        .update(documentVersions)
        .set({ indexStatus: 'failed', errorMessage: 'backfill: original evidence unavailable — no retained bytes and insufficient legacy chunks' })
        .where(and(eq(documentVersions.id, versionId), eq(documentVersions.indexStatus, 'pending')));
    }
    report.versions.currentWithheld += 1;
    report.defects.push({ docId: doc.id, kind: 'no_current_version', detail: 'evidence unavailable' });
    if (doc.status === 'active') report.gate.unresolvedActiveDocIds.push(doc.id);
    if (isStageBGap) report.dualWrite.remainingDefects += 1;
    return;
  }

  if (indexStatus === 'pending') {
    await tx
      .update(documentVersions)
      .set({ indexStatus: 'indexed', indexedAt: doc.indexedAt ?? new Date() })
      .where(and(eq(documentVersions.id, versionId), eq(documentVersions.indexStatus, 'pending')));
    indexStatus = 'indexed';
  }

  const legacySuccessful = doc.status === 'active';
  const mayBeCurrent = indexStatus === 'indexed' && (fidelity === 'byte_exact' || (fidelity === 'reconstructed_text' && hasChunks));
  if (legacySuccessful && mayBeCurrent) {
    await setCurrentVersion(tx, ctx, doc.id, versionId);
    report.versions.currentAssigned += 1;
    if (isStageBGap) report.dualWrite.reconciled += 1;
  } else {
    report.versions.currentWithheld += 1;
    if (legacySuccessful) {
      report.defects.push({ docId: doc.id, kind: 'no_current_version', detail: `fidelity=${fidelity} status=${indexStatus} cannot be current` });
      report.gate.unresolvedActiveDocIds.push(doc.id);
      if (isStageBGap) report.dualWrite.remainingDefects += 1;
    }
  }
}

/** For a reuse top-up, get the exact bytes again if verifiable (cloud object or matching local file). */
async function materializeBytes(store: ObjectStore, doc: DocRow, folderPath: string | null, legacyHash: string, _report: ProjectBackfillReport): Promise<Buffer | null> {
  if (doc.source === 'cloud_upload' && doc.objectKey) {
    try {
      const obj = await store.get(doc.objectKey);
      return sha256Hex(obj) === legacyHash ? obj : null;
    } catch {
      return null;
    }
  }
  const raw = await readLocalBytes(folderPath, doc.relativePath);
  return raw && sha256Hex(raw) === legacyHash ? raw : null;
}

type Classified = { fidelity: ContentFidelity; bytes: Buffer | null; objectKey: string | null };

/** Decide the fidelity for a NEW version and, for byte_exact, retain the exact bytes under the immutable
 *  key. Returns 'retryable_defect' when a cloud object read fails transiently (not a definitive absence),
 *  so a rerun can complete it rather than mislabeling evidence as unavailable. */
async function classifyAndRetain(
  store: ObjectStore,
  ctx: TenantContext,
  doc: DocRow,
  folderPath: string | null,
  legacyHash: string,
  hasChunks: boolean,
  report: ProjectBackfillReport,
): Promise<Classified | 'retryable_defect'> {
  const fallback = (): Classified => ({ fidelity: hasChunks ? 'reconstructed_text' : 'unavailable', bytes: null, objectKey: null });

  if (doc.source === 'cloud_upload') {
    if (!doc.objectKey) return fallback();
    let obj: Buffer;
    try {
      obj = await store.get(doc.objectKey);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        report.storage.missingObjects += 1;
        return fallback();
      }
      return 'retryable_defect';
    }
    if (sha256Hex(obj) === legacyHash) {
      return retainByteExact(store, ctx, doc, obj, legacyHash, report);
    }
    // Object present but hash disagrees with the recorded legacy hash — an integrity finding; the bytes
    // cannot be claimed as the indexed evidence. Reconstruct from chunks if possible.
    report.storage.hashMismatches += 1;
    report.defects.push({ docId: doc.id, kind: 'cloud_object_hash_mismatch', detail: 'stored object hash != recorded document hash' });
    return fallback();
  }

  // local_folder
  const raw = await readLocalBytes(folderPath, doc.relativePath);
  if (raw === null) return fallback(); // source path gone / unreachable
  if (sha256Hex(raw) === legacyHash) {
    return retainByteExact(store, ctx, doc, raw, legacyHash, report);
  }
  // The path is readable but its current bytes differ from what was indexed. Do NOT claim these bytes are
  // the legacy version; reconstruct from chunks. The changed bytes become a later version via normal
  // ingestion (not created here).
  report.integrity.localChangedSinceIndex += 1;
  report.notes.push(`local ${doc.relativePath}: current bytes differ from indexed hash — backfilled from chunks, changed bytes deferred to ingestion`);
  return fallback();
}

async function retainByteExact(store: ObjectStore, ctx: TenantContext, doc: DocRow, bytes: Buffer, legacyHash: string, report: ProjectBackfillReport): Promise<Classified> {
  const objectKey = versionObjectKey(ctx, doc.id, legacyHash);
  const created = await ensureObjectExists(store, objectKey, bytes, legacyHash, doc.mimeType ?? 'text/plain');
  if (created) report.storage.objectsCreated += 1;
  else report.storage.objectsReused += 1;
  report.storage.bytesRetained += bytes.length;
  return { fidelity: 'byte_exact', bytes, objectKey };
}

// ---- Evidence-reference reconciliation ----------------------------------------------------------

async function reconcileKnowledgeRefs(tx: DbTx, ctx: TenantContext, report: ProjectBackfillReport): Promise<void> {
  const rows = await tx
    .select({ id: knowledgeSources.id, sourceRef: knowledgeSources.sourceRef, sourceVersionHash: knowledgeSources.sourceVersionHash, documentVersionId: knowledgeSources.documentVersionId })
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.orgId, ctx.orgId), eq(knowledgeSources.projectId, ctx.projectId), eq(knowledgeSources.sourceType, 'document')));

  const bump = (reason: string) => {
    report.knowledgeRefs.unresolved += 1;
    report.knowledgeRefs.unresolvedByReason[reason] = (report.knowledgeRefs.unresolvedByReason[reason] ?? 0) + 1;
  };

  for (const ks of rows) {
    if (ks.documentVersionId) {
      report.knowledgeRefs.resolved += 1; // already bound (idempotent)
      continue;
    }
    if (!ks.sourceVersionHash) {
      bump('no_cited_hash');
      continue;
    }
    // Candidate documents in THIS workspace with a matching path.
    const docsForPath = await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), eq(documents.relativePath, ks.sourceRef)));
    if (docsForPath.length === 0) {
      bump('source_missing');
      continue;
    }
    if (docsForPath.length > 1) {
      bump('ambiguous_document');
      continue;
    }
    const candidates = await tx
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(and(eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId), eq(documentVersions.documentId, docsForPath[0]!.id), eq(documentVersions.sha256, ks.sourceVersionHash)));
    if (candidates.length === 0) {
      bump('expected_version_unavailable'); // cited hash was overwritten before versioning existed
      continue;
    }
    if (candidates.length > 1) {
      bump('ambiguous_version');
      continue;
    }
    await tx.update(knowledgeSources).set({ documentVersionId: candidates[0]!.id }).where(eq(knowledgeSources.id, ks.id));
    report.knowledgeRefs.resolved += 1;
  }
}

async function reconcileRunRefs(tx: DbTx, ctx: TenantContext, report: ProjectBackfillReport): Promise<void> {
  const runRows = await tx
    .select({ id: runs.id, retrievedSources: runs.retrievedSources })
    .from(runs)
    .where(and(eq(runs.orgId, ctx.orgId), eq(runs.projectId, ctx.projectId)));

  for (const r of runRows) {
    const snaps = (r.retrievedSources as RunSourceSnapshot[] | null) ?? [];
    // Track which versions this run resolved to, so we insert exactly ONE version-level row per version.
    const versionLevelSeen = new Set<string>();
    for (const s of snaps) {
      const docsForPath = await tx
        .select({ id: documents.id })
        .from(documents)
        .where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), eq(documents.relativePath, s.relativePath)));
      if (docsForPath.length !== 1) {
        report.runRefs.unresolved += 1;
        if (docsForPath.length > 1) report.runRefs.ambiguous += 1;
        continue;
      }
      const vers = await tx
        .select({ id: documentVersions.id })
        .from(documentVersions)
        .where(and(eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId), eq(documentVersions.documentId, docsForPath[0]!.id), eq(documentVersions.sha256, s.sha256)));
      if (vers.length !== 1) {
        report.runRefs.unresolved += 1;
        if (vers.length > 1) report.runRefs.ambiguous += 1;
        continue;
      }
      const versionId = vers[0]!.id;
      report.runRefs.resolved += 1;
      const disclosure = (s.disclosure as KnowledgeDisclosure) ?? 'workspace_internal';
      // Version-level relationship (chunkIndex sentinel -1): one per (run, version).
      if (!versionLevelSeen.has(versionId)) {
        versionLevelSeen.add(versionId);
        const insVer = await tx
          .insert(runDocumentVersions)
          .values({ orgId: ctx.orgId, projectId: ctx.projectId, runId: r.id, documentVersionId: versionId, chunkIndex: -1, rank: s.rank ?? null, disclosureSnapshot: disclosure })
          .onConflictDoNothing()
          .returning({ id: runDocumentVersions.id });
        if (insVer.length > 0) report.runRefs.versionLevelCreated += 1;
      }
      // Chunk-level relationship: one per (run, version, chunk).
      const insChunk = await tx
        .insert(runDocumentVersions)
        .values({ orgId: ctx.orgId, projectId: ctx.projectId, runId: r.id, documentVersionId: versionId, chunkIndex: s.chunkIndex, retrievalReason: 'backfill', rank: s.rank ?? null, disclosureSnapshot: disclosure })
        .onConflictDoNothing()
        .returning({ id: runDocumentVersions.id });
      if (insChunk.length > 0) report.runRefs.chunkLevelCreated += 1;
    }
  }
}

// ---- Audit ------------------------------------------------------------------------------------

async function auditIntegrity(tx: DbTx, ctx: TenantContext, store: ObjectStore, report: ProjectBackfillReport): Promise<void> {
  const vers = await tx
    .select({ id: documentVersions.id, contentFidelity: documentVersions.contentFidelity, objectKey: documentVersions.objectKey, sha256: documentVersions.sha256 })
    .from(documentVersions)
    .where(and(eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId)));

  const knownKeys = new Set<string>();
  for (const v of vers) {
    if (v.contentFidelity === 'byte_exact') {
      if (!v.objectKey) {
        report.integrity.byteExactMissingObject += 1;
        report.defects.push({ kind: 'byte_exact_missing_object', detail: `version ${v.id} is byte_exact with no object key` });
        continue;
      }
      knownKeys.add(v.objectKey);
      try {
        const bytes = await store.get(v.objectKey);
        if (sha256Hex(bytes) !== v.sha256) {
          report.integrity.byteExactHashMismatch += 1;
          report.defects.push({ kind: 'byte_exact_hash_mismatch', detail: `version ${v.id} object hash != recorded sha256` });
        }
      } catch {
        report.integrity.byteExactMissingObject += 1;
        report.defects.push({ kind: 'byte_exact_object_unreadable', detail: `version ${v.id} object ${v.objectKey} missing/unreadable` });
      }
    } else if (v.objectKey) {
      knownKeys.add(v.objectKey);
    }
  }

  // Orphan version-scoped chunks (documentVersionId points nowhere) — should be impossible (FK cascade),
  // reported for completeness.
  const versionIds = new Set(vers.map((v) => v.id));
  const versionChunks = await tx
    .select({ id: documentChunks.id, versionId: documentChunks.documentVersionId })
    .from(documentChunks)
    .where(and(eq(documentChunks.orgId, ctx.orgId), eq(documentChunks.projectId, ctx.projectId)));
  for (const c of versionChunks) {
    if (c.versionId && !versionIds.has(c.versionId)) report.integrity.versionChunksOrphaned += 1;
  }

  // Orphan storage objects (present in the store, no version row). READ-ONLY; never deleted.
  if (typeof store.list === 'function') {
    report.storage.orphanScan = store.driver;
    try {
      const prefix = `org/${ctx.orgId}/project/${ctx.projectId}/`;
      const keys = await store.list(prefix);
      for (const k of keys) {
        if (!keyBelongsToTenant(k, ctx)) continue; // defensive
        if (!knownKeys.has(k)) {
          report.storage.orphanObjects += 1;
          report.defects.push({ kind: 'orphan_object', detail: `object ${k} has no version row (not deleted)` });
        }
      }
    } catch {
      report.storage.orphanScan = 'skipped';
      report.notes.push('object-orphan scan failed (store list error) — not audited this run');
    }
  } else {
    report.notes.push('object-orphan scan skipped — store has no list capability');
  }
}

async function computeGate(tx: DbTx, ctx: TenantContext, report: ProjectBackfillReport): Promise<void> {
  const docs = await tx
    .select({ id: documents.id, status: documents.status, currentVersionId: documents.currentVersionId })
    .from(documents)
    .where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), eq(documents.status, 'active')));

  const unresolved = new Set(report.gate.unresolvedActiveDocIds);
  for (const d of docs) {
    report.gate.activeIndexed += 1;
    let valid = false;
    if (d.currentVersionId) {
      const v = (
        await tx
          .select({ indexStatus: documentVersions.indexStatus, documentId: documentVersions.documentId, orgId: documentVersions.orgId, projectId: documentVersions.projectId })
          .from(documentVersions)
          .where(eq(documentVersions.id, d.currentVersionId))
          .limit(1)
      )[0];
      valid = !!v && v.indexStatus === 'indexed' && v.documentId === d.id && v.orgId === ctx.orgId && v.projectId === ctx.projectId;
    }
    if (valid) report.gate.withValidCurrent += 1;
    else {
      report.gate.withoutValidCurrent += 1;
      unresolved.add(d.id);
    }
  }
  report.gate.unresolvedActiveDocIds = [...unresolved];
  report.dualWrite.remainingDefects = Math.max(report.dualWrite.remainingDefects, 0);
}

/** Merge a set of per-project reports into one aggregate for the operation-level reconciliation report. */
export function aggregateReports(reports: ProjectBackfillReport[]): AggregateBackfillReport {
  const agg: AggregateBackfillReport = {
    projects: reports.length,
    baseline: { documents: 0, withCurrentVersion: 0, withoutCurrentVersion: 0, legacyChunks: 0, knowledgeDocSources: 0, runSnapshotDocRefs: 0 },
    versions: { created: 0, reused: 0, byFidelity: zeroFidelity(), chunksCopied: 0, currentAssigned: 0, currentWithheld: 0, duplicatesPrevented: 0 },
    fidelityByAdapter: { local_folder: zeroFidelity(), cloud_upload: zeroFidelity() },
    storage: { objectsCreated: 0, objectsReused: 0, hashMismatches: 0, missingObjects: 0, bytesRetained: 0, orphanObjects: 0 },
    knowledgeRefs: { resolved: 0, unresolved: 0, unresolvedByReason: {} },
    runRefs: { versionLevelCreated: 0, chunkLevelCreated: 0, resolved: 0, unresolved: 0, ambiguous: 0, crossWorkspaceRejected: 0 },
    dualWrite: { examined: 0, gaps: 0, reconciled: 0, remainingDefects: 0 },
    integrity: { byteExactMissingObject: 0, byteExactHashMismatch: 0, versionChunksOrphaned: 0, currentPointerInvariant: 0, localChangedSinceIndex: 0 },
    gate: { activeIndexed: 0, withValidCurrent: 0, withoutValidCurrent: 0, unresolvedActiveDocIds: [] },
    defectCount: 0,
  };
  for (const r of reports) {
    agg.baseline.documents += r.baseline.documents;
    agg.baseline.withCurrentVersion += r.baseline.withCurrentVersion;
    agg.baseline.withoutCurrentVersion += r.baseline.withoutCurrentVersion;
    agg.baseline.legacyChunks += r.baseline.legacyChunks;
    agg.baseline.knowledgeDocSources += r.baseline.knowledgeDocSources;
    agg.baseline.runSnapshotDocRefs += r.baseline.runSnapshotDocRefs;
    agg.versions.created += r.versions.created;
    agg.versions.reused += r.versions.reused;
    agg.versions.chunksCopied += r.versions.chunksCopied;
    agg.versions.currentAssigned += r.versions.currentAssigned;
    agg.versions.currentWithheld += r.versions.currentWithheld;
    agg.versions.duplicatesPrevented += r.versions.duplicatesPrevented;
    for (const k of ['byte_exact', 'reconstructed_text', 'unavailable'] as const) {
      agg.versions.byFidelity[k] += r.versions.byFidelity[k];
      agg.fidelityByAdapter.local_folder![k] += r.fidelityByAdapter.local_folder?.[k] ?? 0;
      agg.fidelityByAdapter.cloud_upload![k] += r.fidelityByAdapter.cloud_upload?.[k] ?? 0;
    }
    agg.storage.objectsCreated += r.storage.objectsCreated;
    agg.storage.objectsReused += r.storage.objectsReused;
    agg.storage.hashMismatches += r.storage.hashMismatches;
    agg.storage.missingObjects += r.storage.missingObjects;
    agg.storage.bytesRetained += r.storage.bytesRetained;
    agg.storage.orphanObjects += r.storage.orphanObjects;
    agg.knowledgeRefs.resolved += r.knowledgeRefs.resolved;
    agg.knowledgeRefs.unresolved += r.knowledgeRefs.unresolved;
    for (const [reason, n] of Object.entries(r.knowledgeRefs.unresolvedByReason)) {
      agg.knowledgeRefs.unresolvedByReason[reason] = (agg.knowledgeRefs.unresolvedByReason[reason] ?? 0) + n;
    }
    agg.runRefs.versionLevelCreated += r.runRefs.versionLevelCreated;
    agg.runRefs.chunkLevelCreated += r.runRefs.chunkLevelCreated;
    agg.runRefs.resolved += r.runRefs.resolved;
    agg.runRefs.unresolved += r.runRefs.unresolved;
    agg.runRefs.ambiguous += r.runRefs.ambiguous;
    agg.dualWrite.examined += r.dualWrite.examined;
    agg.dualWrite.gaps += r.dualWrite.gaps;
    agg.dualWrite.reconciled += r.dualWrite.reconciled;
    agg.dualWrite.remainingDefects += r.dualWrite.remainingDefects;
    agg.integrity.byteExactMissingObject += r.integrity.byteExactMissingObject;
    agg.integrity.byteExactHashMismatch += r.integrity.byteExactHashMismatch;
    agg.integrity.versionChunksOrphaned += r.integrity.versionChunksOrphaned;
    agg.integrity.currentPointerInvariant += r.integrity.currentPointerInvariant;
    agg.integrity.localChangedSinceIndex += r.integrity.localChangedSinceIndex;
    agg.gate.activeIndexed += r.gate.activeIndexed;
    agg.gate.withValidCurrent += r.gate.withValidCurrent;
    agg.gate.withoutValidCurrent += r.gate.withoutValidCurrent;
    agg.gate.unresolvedActiveDocIds.push(...r.gate.unresolvedActiveDocIds);
    agg.defectCount += r.defects.length;
  }
  return agg;
}

export interface AggregateBackfillReport {
  projects: number;
  baseline: { documents: number; withCurrentVersion: number; withoutCurrentVersion: number; legacyChunks: number; knowledgeDocSources: number; runSnapshotDocRefs: number };
  versions: ProjectBackfillReport['versions'];
  fidelityByAdapter: Record<string, FidelityCounts>;
  storage: { objectsCreated: number; objectsReused: number; hashMismatches: number; missingObjects: number; bytesRetained: number; orphanObjects: number };
  knowledgeRefs: ProjectBackfillReport['knowledgeRefs'];
  runRefs: ProjectBackfillReport['runRefs'];
  dualWrite: ProjectBackfillReport['dualWrite'];
  integrity: ProjectBackfillReport['integrity'];
  gate: ProjectBackfillReport['gate'];
  defectCount: number;
}
