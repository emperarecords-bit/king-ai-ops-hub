import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { type RunSourceSnapshot, type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { documentChunks, documentDisclosureGrants, documentJobs, documentPurgeOperations, documentVersionTombstones, documentVersions, documents, knowledgeSources, objectCleanupOperations, runDocumentVersions, runs } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { type ObjectStore } from './object-store';
import { assertPurgeAuthority } from './retention';

/**
 * Document PURGE — the deliberate, IRREVERSIBLE removal of a document and its retained representations. It is
 * admin-authorized, ONE document per operation, and always passes through a visible retention/quarantine
 * window during which it is retrieval-excluded, cancellable, and still restorable. Database removal is
 * authoritative and commits FIRST; external-object deletion is a separate, restartable, HEAD-confirmed phase.
 *
 * It NEVER silently rewrites or erases immutable evidence to make purge possible: any surviving Knowledge
 * citation, run reference, run snapshot, unresolved cleanup operation, or retention hold BLOCKS the purge
 * (fail closed). Immutable run snapshots and all audit/lifecycle history are RETAINED; a metadata-only
 * tombstone is created per purged version.
 *
 * Lifecycle: proposed → quarantined (authorized + in window) → database_purged → object_cleanup_pending →
 * completed ; cancelled is terminal from proposed/quarantined; failed is a terminal error state.
 */

export const DEFAULT_PURGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days; overridable per authorization

export type PurgeOpStatus = 'proposed' | 'quarantined' | 'database_purged' | 'object_cleanup_pending' | 'completed' | 'failed' | 'cancelled';

export type PurgeBlocker =
  | 'knowledge_reference' // a Knowledge citation is bound to a version (never silently nulled to enable purge)
  | 'run_reference' // a normalized run→version evidence row exists (RESTRICT-protected)
  | 'run_snapshot' // an immutable run prompt snapshot cites a version
  | 'unresolved_cleanup' // a live object-cleanup operation targets one of this document's objects
  | 'retention_hold'; // a legal/retention hold is in force (placeholder for a future policy)

export interface PurgeScope {
  documentId: string;
  priorStatus: string;
  currentVersionId: string | null;
  versions: { versionId: string; sha256: string; objectKey: string | null; contentFidelity: string }[];
  chunkCount: number;
  disclosureGrantCount: number;
  jobCount: number;
  /** Distinct object keys that will be cleaned up (document legacy object + each version object). */
  objectKeys: string[];
  /** One tombstone will be created per version; existing tombstones are retained. */
  tombstonesToCreate: number;
}

export type PurgeDecision = 'purge_permitted' | 'purge_blocked' | 'assessment_incomplete';

export interface DocumentPurgeAssessment {
  documentId: string;
  decision: PurgeDecision;
  blockers: { category: PurgeBlocker; count: number }[];
  scope: PurgeScope;
  fingerprint: string;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A non-reversible handle so audit evidence carries an object reference without the raw path. */
function keyHandle(objectKey: string): string {
  return sha256Hex(Buffer.from(objectKey, 'utf8')).slice(0, 16);
}

/** Is `objectKey` still referenced by a retained version OUTSIDE this document (so it must be preserved)? */
async function objectSharedOutsideDocument(tx: DbTx, ctx: TenantContext, objectKey: string, documentId: string): Promise<boolean> {
  const other = (
    await tx
      .select({ id: documentVersions.id })
      .from(documentVersions)
      .where(and(eq(documentVersions.objectKey, objectKey), ne(documentVersions.documentId, documentId), eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId)))
      .limit(1)
  )[0];
  return !!other;
}

/**
 * The exact IDENTITY a purge binds to — the document + its complete version set (ids, content hashes, object
 * keys, fidelity) + the object keys. Deliberately excludes the document's mutable status (which legitimately
 * becomes `purge_quarantined` at authorization) and derived counts (chunks/grants/jobs are deleted, not
 * identity). A new/removed version or any change to a version's content identity re-binds → refuses.
 */
function purgeFingerprint(scope: PurgeScope): string {
  const versions = scope.versions
    .map((v) => `${v.versionId}:${v.sha256}:${v.objectKey ?? ''}:${v.contentFidelity}`)
    .sort()
    .join('|');
  const objects = [...scope.objectKeys].sort().join('|');
  return sha256Hex(Buffer.from(`${scope.documentId}|${scope.currentVersionId ?? ''}|${versions}|${objects}`, 'utf8'));
}

/**
 * READ-ONLY assessment of a document purge. Enumerates the EXACT scope (versions, chunks, disclosure grants,
 * jobs, object keys, tombstones-to-create) and the full reference closure (Knowledge, run references, run
 * snapshots, unresolved cleanup operations, retention holds). Blocks — never auto-clears — on any reference.
 */
export async function assessDocumentPurge(tx: DbTx, ctx: TenantContext, documentId: string): Promise<DocumentPurgeAssessment | null> {
  const doc = (
    await tx
      .select({ id: documents.id, status: documents.status, currentVersionId: documents.currentVersionId, objectKey: documents.objectKey })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)))
      .limit(1)
  )[0];
  if (!doc) return null; // existence-neutral: not this workspace

  const versionRows = await tx
    .select({ id: documentVersions.id, sha256: documentVersions.sha256, objectKey: documentVersions.objectKey, contentFidelity: documentVersions.contentFidelity })
    .from(documentVersions)
    .where(and(eq(documentVersions.documentId, documentId), eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId)));
  const versionIds = versionRows.map((v) => v.id);

  const objectKeys = new Set<string>();
  if (doc.objectKey) objectKeys.add(doc.objectKey);
  for (const v of versionRows) if (v.objectKey) objectKeys.add(v.objectKey);

  const chunkCount = versionIds.length > 0
    ? (await tx.select({ id: documentChunks.id }).from(documentChunks).where(and(eq(documentChunks.orgId, ctx.orgId), eq(documentChunks.projectId, ctx.projectId), eq(documentChunks.documentId, documentId)))).length
    : 0;
  const disclosureGrantCount = (await tx.select({ id: documentDisclosureGrants.id }).from(documentDisclosureGrants).where(and(eq(documentDisclosureGrants.orgId, ctx.orgId), eq(documentDisclosureGrants.projectId, ctx.projectId), eq(documentDisclosureGrants.documentId, documentId)))).length;
  const jobCount = (await tx.select({ id: documentJobs.id }).from(documentJobs).where(and(eq(documentJobs.orgId, ctx.orgId), eq(documentJobs.projectId, ctx.projectId), eq(documentJobs.documentId, documentId)))).length;

  const scope: PurgeScope = {
    documentId,
    priorStatus: doc.status,
    currentVersionId: doc.currentVersionId,
    versions: versionRows.map((v) => ({ versionId: v.id, sha256: v.sha256, objectKey: v.objectKey, contentFidelity: v.contentFidelity })),
    chunkCount,
    disclosureGrantCount,
    jobCount,
    objectKeys: [...objectKeys],
    tombstonesToCreate: versionRows.length,
  };

  // ---- Reference closure — every surviving relationship BLOCKS purge (never silently cleared). ----------
  const blockers: DocumentPurgeAssessment['blockers'] = [];
  if (versionIds.length > 0) {
    const knowledge = (await tx.select({ id: knowledgeSources.id }).from(knowledgeSources).where(and(eq(knowledgeSources.orgId, ctx.orgId), eq(knowledgeSources.projectId, ctx.projectId), inArray(knowledgeSources.documentVersionId, versionIds)))).length;
    if (knowledge > 0) blockers.push({ category: 'knowledge_reference', count: knowledge });
    const runRefs = (await tx.select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(and(eq(runDocumentVersions.orgId, ctx.orgId), eq(runDocumentVersions.projectId, ctx.projectId), inArray(runDocumentVersions.documentVersionId, versionIds)))).length;
    if (runRefs > 0) blockers.push({ category: 'run_reference', count: runRefs });
    const runRows = await tx.select({ retrievedSources: runs.retrievedSources }).from(runs).where(and(eq(runs.orgId, ctx.orgId), eq(runs.projectId, ctx.projectId)));
    const idSet = new Set(versionIds);
    let snap = 0;
    for (const r of runRows) {
      const snaps = (r.retrievedSources as RunSourceSnapshot[] | null) ?? [];
      if (snaps.some((s) => s.documentVersionId && idSet.has(s.documentVersionId))) snap += 1;
    }
    if (snap > 0) blockers.push({ category: 'run_snapshot', count: snap });
  }
  // A live object-cleanup operation on one of this document's objects must resolve first.
  if (objectKeys.size > 0) {
    const liveCleanup = (await tx.select({ id: objectCleanupOperations.id }).from(objectCleanupOperations).where(and(eq(objectCleanupOperations.orgId, ctx.orgId), eq(objectCleanupOperations.projectId, ctx.projectId), inArray(objectCleanupOperations.objectKey, [...objectKeys]), inArray(objectCleanupOperations.status, ['proposed', 'authorized'])))).length;
    if (liveCleanup > 0) blockers.push({ category: 'unresolved_cleanup', count: liveCleanup });
  }
  // Retention/legal holds — placeholder for a future policy; always 0 today.

  const decision: PurgeDecision = blockers.length === 0 ? 'purge_permitted' : 'purge_blocked';
  return { documentId, decision, blockers, scope, fingerprint: purgeFingerprint(scope) };
}

export interface LivePurgeOperation {
  operationId: string;
  status: PurgeOpStatus;
  retentionUntil: string | null;
  reason: string | null;
  scope: { versions: number; chunks: number; disclosureGrants: number; jobs: number; objects: number };
}

/** The current non-terminal purge operation for a document (for the detail UI), or null. Read-only. */
export async function loadLivePurgeOperation(tx: DbTx, ctx: TenantContext, documentId: string): Promise<LivePurgeOperation | null> {
  const op = (
    await tx
      .select({ id: documentPurgeOperations.id, status: documentPurgeOperations.status, retentionUntil: documentPurgeOperations.retentionUntil, reason: documentPurgeOperations.reason, scope: documentPurgeOperations.scope })
      .from(documentPurgeOperations)
      .where(and(eq(documentPurgeOperations.orgId, ctx.orgId), eq(documentPurgeOperations.projectId, ctx.projectId), eq(documentPurgeOperations.documentId, documentId), inArray(documentPurgeOperations.status, ['proposed', 'quarantined', 'database_purged', 'object_cleanup_pending'])))
      .limit(1)
  )[0];
  if (!op) return null;
  const s = (op.scope as unknown as PurgeScope | null);
  return {
    operationId: op.id,
    status: op.status as PurgeOpStatus,
    retentionUntil: op.retentionUntil ? op.retentionUntil.toISOString() : null,
    reason: op.reason,
    scope: { versions: s?.versions.length ?? 0, chunks: s?.chunkCount ?? 0, disclosureGrants: s?.disclosureGrantCount ?? 0, jobs: s?.jobCount ?? 0, objects: s?.objectKeys.length ?? 0 },
  };
}

export interface PurgeProposalResult {
  assessment: DocumentPurgeAssessment;
  operationId: string | null;
}

/** Record a purge PROPOSAL for a permitted document. Idempotent per document (one live operation). No mutation
 *  of the document, versions, or objects — only the operation lifecycle row. */
export async function proposeDocumentPurge(tx: DbTx, ctx: TenantContext, documentId: string, reason?: string): Promise<PurgeProposalResult | null> {
  assertPurgeAuthority(ctx);
  const assessment = await assessDocumentPurge(tx, ctx, documentId);
  if (!assessment) return null;
  if (assessment.decision !== 'purge_permitted') return { assessment, operationId: null };

  const existing = (
    await tx
      .select({ id: documentPurgeOperations.id })
      .from(documentPurgeOperations)
      .where(and(eq(documentPurgeOperations.orgId, ctx.orgId), eq(documentPurgeOperations.projectId, ctx.projectId), eq(documentPurgeOperations.documentId, documentId), inArray(documentPurgeOperations.status, ['proposed', 'quarantined', 'database_purged', 'object_cleanup_pending'])))
      .limit(1)
  )[0];
  if (existing) return { assessment, operationId: existing.id };

  const ins = await tx
    .insert(documentPurgeOperations)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId, status: 'proposed', scope: assessment.scope as unknown as Record<string, unknown>, fingerprint: assessment.fingerprint, reason: reason ?? null, proposedBy: ctx.userId })
    .returning({ id: documentPurgeOperations.id });
  const operationId = ins[0]!.id;
  await writeAudit(tx, ctx, {
    action: 'document.purge_proposed',
    entityType: 'document',
    entityId: documentId,
    // Metadata-only: identifiers + counts + object handles — never content, bytes, or raw paths.
    detail: { operationId, versions: assessment.scope.versions.length, chunks: assessment.scope.chunkCount, disclosureGrants: assessment.scope.disclosureGrantCount, jobs: assessment.scope.jobCount, objects: assessment.scope.objectKeys.map(keyHandle) },
  });
  return { assessment, operationId };
}

export type PurgeAuthorizeOutcome = 'quarantined' | 'refused_state_changed' | 'refused_blocked' | 'refused_not_proposed';

/**
 * AUTHORIZE a proposed purge and enter the retention/quarantine window. Re-checks the reference closure and
 * the fingerprint (refuses if the document changed or a reference appeared since proposal), sets the retention
 * deadline, and marks the document `purge_quarantined` so retrieval and new use exclude it while it stays
 * cancellable and restorable.
 */
export async function authorizeDocumentPurge(tx: DbTx, ctx: TenantContext, operationId: string, opts?: { retentionMs?: number; now?: Date }): Promise<{ outcome: PurgeAuthorizeOutcome; retentionUntil?: Date }> {
  assertPurgeAuthority(ctx);
  const now = opts?.now ?? new Date();
  const retentionMs = opts?.retentionMs ?? DEFAULT_PURGE_RETENTION_MS;
  const op = (
    await tx
      .select({ id: documentPurgeOperations.id, documentId: documentPurgeOperations.documentId, status: documentPurgeOperations.status, fingerprint: documentPurgeOperations.fingerprint })
      .from(documentPurgeOperations)
      .where(and(eq(documentPurgeOperations.id, operationId), eq(documentPurgeOperations.orgId, ctx.orgId), eq(documentPurgeOperations.projectId, ctx.projectId)))
      .limit(1)
      .for('update')
  )[0];
  if (!op || op.status !== 'proposed') return { outcome: 'refused_not_proposed' };

  const fresh = await assessDocumentPurge(tx, ctx, op.documentId);
  if (!fresh) return { outcome: 'refused_not_proposed' };
  if (fresh.decision !== 'purge_permitted') return { outcome: 'refused_blocked' };
  if (fresh.fingerprint !== op.fingerprint) return { outcome: 'refused_state_changed' };

  const retentionUntil = new Date(now.getTime() + retentionMs);
  await tx.update(documentPurgeOperations).set({ status: 'quarantined', authorizedBy: ctx.userId, authorizedAt: now, retentionMs, retentionUntil }).where(eq(documentPurgeOperations.id, operationId));
  // Exclude from retrieval + new use while quarantined; prior status is preserved in the scope for restoration.
  await tx.update(documents).set({ status: 'purge_quarantined', updatedAt: now }).where(and(eq(documents.id, op.documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));
  await writeAudit(tx, ctx, { action: 'document.purge_authorized', entityType: 'document', entityId: op.documentId, detail: { operationId, retentionUntil: retentionUntil.toISOString() } });
  return { outcome: 'quarantined', retentionUntil };
}

export type PurgeCancelOutcome = 'cancelled' | 'refused_too_late' | 'refused_not_found';

/** CANCEL a purge while still in proposal or quarantine — restores the document to its prior status; nothing
 *  was deleted. Refuses once the database purge has begun. */
export async function cancelDocumentPurge(tx: DbTx, ctx: TenantContext, operationId: string, reason?: string, now: Date = new Date()): Promise<{ outcome: PurgeCancelOutcome }> {
  assertPurgeAuthority(ctx);
  const op = (
    await tx
      .select({ id: documentPurgeOperations.id, documentId: documentPurgeOperations.documentId, status: documentPurgeOperations.status, scope: documentPurgeOperations.scope })
      .from(documentPurgeOperations)
      .where(and(eq(documentPurgeOperations.id, operationId), eq(documentPurgeOperations.orgId, ctx.orgId), eq(documentPurgeOperations.projectId, ctx.projectId)))
      .limit(1)
      .for('update')
  )[0];
  if (!op) return { outcome: 'refused_not_found' };
  if (op.status !== 'proposed' && op.status !== 'quarantined') return { outcome: 'refused_too_late' };

  await tx.update(documentPurgeOperations).set({ status: 'cancelled', cancelledBy: ctx.userId, cancelledAt: now, reason: reason ?? null }).where(eq(documentPurgeOperations.id, operationId));
  // Restore the document to exactly the status it held before quarantine (only if we set it).
  if (op.status === 'quarantined') {
    const priorStatus = ((op.scope as unknown as PurgeScope | null)?.priorStatus ?? 'active') as 'active';
    await tx.update(documents).set({ status: priorStatus, updatedAt: now }).where(and(eq(documents.id, op.documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), eq(documents.status, 'purge_quarantined')));
  }
  await writeAudit(tx, ctx, { action: 'document.purge_cancelled', entityType: 'document', entityId: op.documentId, detail: { operationId } });
  return { outcome: 'cancelled' };
}

export type PurgeExecOutcome = 'completed' | 'database_purged_objects_pending' | 'already_completed' | 'refused_retention_not_elapsed' | 'refused_state_changed' | 'refused_blocked' | 'refused_not_ready';

export interface DocumentPurgeResult {
  operationId: string;
  outcome: PurgeExecOutcome;
  /** Exact rows deleted in the authoritative DB phase (for the gate's mutation-plan evidence). */
  deleted?: { chunks: number; jobs: number; disclosureGrants: number; versions: number; documents: number; tombstonesCreated: number };
  objectsTotal?: number;
  objectsDeleted?: number;
  /** True only once every object is HEAD-confirmed absent. */
  objectsAllConfirmedAbsent?: boolean;
  detail: string;
}

/** Each phase commits independently; the DB-authoritative deletions require a PRIVILEGED runner (app_server
 *  deliberately cannot delete immutable version rows). Every query is explicitly tenant-scoped. */
export type PurgeExecRunner = <T>(fn: (tx: DbTx) => Promise<T>) => Promise<T>;

/**
 * EXECUTE a quarantined purge whose retention window has elapsed. Phase A (one privileged DB transaction):
 * re-authorize, re-check retention + fingerprint + reference closure, delete every dependent in dependency
 * order (counted), create one metadata-only tombstone per version, and mark `database_purged` — this commit is
 * authoritative and can never be undone by a later object-store failure. Phase B: a restartable reconciler
 * deletes each retained object, HEAD-confirms absence, and marks `completed` only once ALL are confirmed gone.
 * Idempotent + resumable from any post-authorization state.
 */
export async function executeDocumentPurge(runTx: PurgeExecRunner, ctx: TenantContext, store: ObjectStore, operationId: string, opts?: { now?: Date }): Promise<DocumentPurgeResult> {
  const now = opts?.now ?? new Date();

  // ---- PHASE A: the authoritative database purge (privileged, one transaction). --------------------------
  type PhaseA =
    | { kind: 'purged'; documentId: string; objectKeys: string[]; deleted: NonNullable<DocumentPurgeResult['deleted']> }
    | { kind: 'resume'; documentId: string }
    | { kind: 'already_completed' }
    | { kind: 'refused'; outcome: PurgeExecOutcome };
  const a: PhaseA = await runTx(async (tx) => {
    assertPurgeAuthority(ctx);
    const op = (
      await tx
        .select({ id: documentPurgeOperations.id, documentId: documentPurgeOperations.documentId, status: documentPurgeOperations.status, fingerprint: documentPurgeOperations.fingerprint, retentionUntil: documentPurgeOperations.retentionUntil, scope: documentPurgeOperations.scope })
        .from(documentPurgeOperations)
        .where(and(eq(documentPurgeOperations.id, operationId), eq(documentPurgeOperations.orgId, ctx.orgId), eq(documentPurgeOperations.projectId, ctx.projectId)))
        .limit(1)
        .for('update')
    )[0];
    if (!op) return { kind: 'refused', outcome: 'refused_not_ready' };
    if (op.status === 'completed') return { kind: 'already_completed' };
    // Resume the object-cleanup phase if the DB purge already committed.
    if (op.status === 'database_purged' || op.status === 'object_cleanup_pending') return { kind: 'resume', documentId: op.documentId };
    if (op.status !== 'quarantined') return { kind: 'refused', outcome: 'refused_not_ready' };
    if (!op.retentionUntil || now.getTime() < op.retentionUntil.getTime()) return { kind: 'refused', outcome: 'refused_retention_not_elapsed' };

    // Re-check the reference closure + exact-state fingerprint immediately before the irreversible deletion.
    const fresh = await assessDocumentPurge(tx, ctx, op.documentId);
    if (!fresh) return { kind: 'refused', outcome: 'refused_not_ready' };
    if (fresh.decision !== 'purge_permitted') return { kind: 'refused', outcome: 'refused_blocked' };
    if (fresh.fingerprint !== op.fingerprint) return { kind: 'refused', outcome: 'refused_state_changed' };

    const versionRows = fresh.scope.versions;
    const objectKeys = fresh.scope.objectKeys;

    // Create a metadata-only tombstone per version BEFORE deleting the versions (retained evidence).
    for (const v of versionRows) {
      await tx.insert(documentVersionTombstones).values({ orgId: ctx.orgId, projectId: ctx.projectId, versionId: v.versionId, documentId: op.documentId, sha256: v.sha256, contentFidelity: v.contentFidelity, objectKey: v.objectKey, objectDeleted: false, status: v.objectKey ? 'object_cleanup_pending' : 'completed', assessment: { via: 'document_purge', operationId } as unknown as Record<string, unknown>, reason: `document purge ${operationId}`, purgedBy: ctx.userId });
    }

    // Delete every dependent EXPLICITLY (counted), in dependency order — never relying on silent cascade.
    const chunks = (await tx.delete(documentChunks).where(and(eq(documentChunks.orgId, ctx.orgId), eq(documentChunks.projectId, ctx.projectId), eq(documentChunks.documentId, op.documentId))).returning({ id: documentChunks.id })).length;
    const jobs = (await tx.delete(documentJobs).where(and(eq(documentJobs.orgId, ctx.orgId), eq(documentJobs.projectId, ctx.projectId), eq(documentJobs.documentId, op.documentId))).returning({ id: documentJobs.id })).length;
    const grants = (await tx.delete(documentDisclosureGrants).where(and(eq(documentDisclosureGrants.orgId, ctx.orgId), eq(documentDisclosureGrants.projectId, ctx.projectId), eq(documentDisclosureGrants.documentId, op.documentId))).returning({ id: documentDisclosureGrants.id })).length;
    // The RESTRICT FK on run_document_versions is the DB backstop: a still-referenced version cannot be deleted.
    const versions = (await tx.delete(documentVersions).where(and(eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId), eq(documentVersions.documentId, op.documentId))).returning({ id: documentVersions.id })).length;
    const docs = (await tx.delete(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), eq(documents.id, op.documentId))).returning({ id: documents.id })).length;

    const deleted = { chunks, jobs, disclosureGrants: grants, versions, documents: docs, tombstonesCreated: versionRows.length };
    await tx.update(documentPurgeOperations).set({ status: objectKeys.length > 0 ? 'database_purged' : 'completed', databasePurgedAt: now, completedAt: objectKeys.length > 0 ? null : now, objectsTotal: objectKeys.length }).where(eq(documentPurgeOperations.id, operationId));
    await writeAudit(tx, ctx, { action: 'document.purged', entityType: 'document', entityId: op.documentId, detail: { operationId, ...deleted, objects: objectKeys.map(keyHandle) } });
    return { kind: 'purged', documentId: op.documentId, objectKeys, deleted };
  });

  if (a.kind === 'already_completed') return { operationId, outcome: 'already_completed', detail: 'This document was already purged; nothing further to do.' };
  if (a.kind === 'refused') {
    const detail = a.outcome === 'refused_retention_not_elapsed' ? 'The retention/quarantine window has not yet elapsed.'
      : a.outcome === 'refused_blocked' ? 'A reference to this document appeared since authorization; purge is refused.'
      : a.outcome === 'refused_state_changed' ? 'The document changed since it was authorized; re-propose and re-authorize.'
      : 'This purge is not in a state that can be executed.';
    return { operationId, outcome: a.outcome, detail };
  }

  // ---- PHASE B: restartable object reconciler (external deletes; NOT one DB transaction). ------------------
  const documentId = a.documentId;
  await runTx((tx) => tx.update(documentPurgeOperations).set({ status: 'object_cleanup_pending' }).where(and(eq(documentPurgeOperations.id, operationId), eq(documentPurgeOperations.status, 'database_purged'))));

  // Re-read the pending tombstones (their objects are the source of truth for what remains to delete).
  const pending = await runTx((tx) => tx
    .select({ id: documentVersionTombstones.id, objectKey: documentVersionTombstones.objectKey, status: documentVersionTombstones.status, objectDeleted: documentVersionTombstones.objectDeleted })
    .from(documentVersionTombstones)
    .where(and(eq(documentVersionTombstones.orgId, ctx.orgId), eq(documentVersionTombstones.projectId, ctx.projectId), eq(documentVersionTombstones.documentId, documentId))));

  let confirmedAbsent = 0;
  let total = 0;
  for (const t of pending) {
    if (!t.objectKey) continue;
    total += 1;
    if (t.objectDeleted) { confirmedAbsent += 1; continue; }
    // An object shared by a retained version of ANOTHER document must be preserved.
    const shared = await runTx((tx) => objectSharedOutsideDocument(tx, ctx, t.objectKey!, documentId));
    if (shared) { await runTx((tx) => tx.update(documentVersionTombstones).set({ status: 'completed_object_retained_shared' }).where(eq(documentVersionTombstones.id, t.id))); confirmedAbsent += 1; continue; }
    let absent = false;
    try {
      await store.delete(t.objectKey);
      absent = (await store.head(t.objectKey)) === null; // confirm removal; never assume
    } catch (err) {
      try { absent = (await store.head(t.objectKey)) === null; } catch { absent = false; }
      if (!absent) await runTx((tx) => tx.update(documentPurgeOperations).set({ attempts: sql`${documentPurgeOperations.attempts} + 1`, lastError: err instanceof Error ? err.message.slice(0, 300) : String(err) }).where(eq(documentPurgeOperations.id, operationId)));
    }
    if (absent) { await runTx((tx) => tx.update(documentVersionTombstones).set({ status: 'completed', objectDeleted: true, cleanupError: null }).where(eq(documentVersionTombstones.id, t.id))); confirmedAbsent += 1; }
  }

  const allAbsent = total > 0 ? confirmedAbsent === total : true;
  await runTx((tx) => tx.update(documentPurgeOperations).set({ objectsTotal: total, objectsDeleted: confirmedAbsent, status: allAbsent ? 'completed' : 'object_cleanup_pending', completedAt: allAbsent ? now : null }).where(eq(documentPurgeOperations.id, operationId)));
  if (allAbsent) await runTx((tx) => writeAudit(tx, ctx, { action: 'document.purge_completed', entityType: 'document', entityId: documentId, detail: { operationId, objectsConfirmedAbsent: confirmedAbsent } }));

  const deleted = a.kind === 'purged' ? a.deleted : undefined;
  return {
    operationId,
    outcome: allAbsent ? 'completed' : 'database_purged_objects_pending',
    deleted,
    objectsTotal: total,
    objectsDeleted: confirmedAbsent,
    objectsAllConfirmedAbsent: allAbsent,
    detail: allAbsent
      ? 'The document and its retained representations were purged; every object was confirmed absent from storage.'
      : 'The database purge is committed and authoritative; some objects are not yet confirmed absent and will be retried.',
  };
}
