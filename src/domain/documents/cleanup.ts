import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type RunSourceSnapshot, type TenantContext } from '@/types/domain';
import { AppError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { documentJobs, documentVersionTombstones, documentVersions, documents, knowledgeSources, objectCleanupOperations, runDocumentVersions, runs } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { ObjectNotFoundError, type ObjectStore, keyBelongsToTenant } from './object-store';

/**
 * Legacy-object cleanup — deletion of a storage object PROVEN obsolete and unreferenced (an orphan left by a
 * failed/rolled-back upload: the upload writes the object, then the row commit is lost). This capability is
 * deliberately separate from purge: it NEVER deletes a document, version, tombstone, chunk, or evidence row,
 * and it refuses any object a purge tombstone owns.
 *
 * Because deleting an external object cannot be rolled back through a DB transaction, the lifecycle is
 * explicit, persisted, and restartable:
 *   assess (read-only) → propose (records identity + starts a QUIET period) → authorize + delete → deleted|failed
 *
 * The QUIET period closes the one legitimate "object without a committed reference" window: a concurrent
 * upload whose object landed but whose row transaction has not committed yet. Such an upload commits (or
 * aborts) within seconds, so requiring the key to have stayed continuously orphaned across a quiet interval —
 * with ingestion quiescent — guarantees we never delete an in-flight upload's object.
 */

const DEFAULT_CLEANUP_QUIET_MS = 15 * 60 * 1000; // 15 min; overridable per call (env-backed at the action layer)

export type CleanupRefusal =
  | 'not_tenant_object' // key is not under this workspace's prefix (cross-workspace / ambiguous ownership)
  | 'referenced' // an authoritative record still names or reaches the object
  | 'tombstoned' // a purge tombstone owns this object — cleanup must not overlap purge
  | 'object_absent' // nothing exists at that key to clean
  | 'store_unreachable' // storage could not be inspected this attempt
  | 'ingestion_active' // a document job is queued/running — refuse until ingestion is quiescent
  | 'quiet_period_not_elapsed' // the proposal has not aged past the quiet interval yet
  | 'identity_changed' // the object's bytes/size no longer match the proposed identity
  | 'not_proposed'; // the operation is not in a state that can be authorized/deleted (existence-neutral)

export interface ReferenceCheck {
  location: string;
  count: number;
}

export type CleanupEligibility = 'eligible' | 'ineligible';

export interface ObjectCleanupAssessment {
  objectKey: string;
  eligibility: CleanupEligibility;
  refusal?: CleanupRefusal;
  reason: string;
  size: number | null;
  /** Full content hash of the retained bytes — the identity a later delete rebinds to. Never the bytes. */
  sha256: string | null;
  fingerprint: string | null;
  /** EVERY authoritative reference location checked, with the count found (0 for a true orphan). */
  referencesChecked: ReferenceCheck[];
  whatRemains: string;
  ingestionActive: boolean;
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fingerprintOf(objectKey: string, size: number, sha: string): string {
  return sha256Hex(Buffer.from(`${objectKey}|${size}|${sha}`, 'utf8'));
}

/** A short, non-reversible handle for the object key so audit evidence never carries the raw path. */
function keyHandle(objectKey: string): string {
  return sha256Hex(Buffer.from(objectKey, 'utf8')).slice(0, 16);
}

/** Guard: cleanup deletes real storage — require workspace owner or project admin, never a client token. */
export function assertObjectCleanupAuthority(ctx: TenantContext): void {
  if (ctx.orgRole !== 'owner' && ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Legacy-object cleanup requires workspace owner or project admin authority.');
  }
}

/** True when any ingestion job for this workspace is queued or running (constraint #4: refuse if active). */
async function ingestionActive(tx: DbTx, ctx: TenantContext): Promise<boolean> {
  const live = (
    await tx
      .select({ id: documentJobs.id })
      .from(documentJobs)
      .where(and(eq(documentJobs.orgId, ctx.orgId), eq(documentJobs.projectId, ctx.projectId), inArray(documentJobs.status, ['queued', 'running'])))
      .limit(1)
  )[0];
  return !!live;
}

/**
 * The complete reference closure for one object key — checks EVERY authoritative location that could name or
 * reach the object. Direct key columns: documents.object_key, document_versions.object_key,
 * document_version_tombstones.object_key. Indirect (defensive): a version that HOLDS this key reached through
 * the current-version pointer, a Knowledge citation, a normalized run reference, or an immutable run snapshot.
 * (When no version holds the key, the indirect counts are necessarily 0 — but they are checked and reported.)
 */
async function referenceClosure(
  tx: DbTx,
  ctx: TenantContext,
  objectKey: string,
): Promise<{ checks: ReferenceCheck[]; referenced: boolean; tombstoned: boolean }> {
  const docRefs = (await tx.select({ id: documents.id }).from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), eq(documents.objectKey, objectKey)))).length;
  const verRows = await tx.select({ id: documentVersions.id }).from(documentVersions).where(and(eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId), eq(documentVersions.objectKey, objectKey)));
  const verRefs = verRows.length;
  const tombRefs = (await tx.select({ id: documentVersionTombstones.id }).from(documentVersionTombstones).where(and(eq(documentVersionTombstones.orgId, ctx.orgId), eq(documentVersionTombstones.projectId, ctx.projectId), eq(documentVersionTombstones.objectKey, objectKey)))).length;

  const versionIds = verRows.map((v) => v.id);
  let currentPtr = 0;
  let knowledge = 0;
  let runRef = 0;
  let runSnap = 0;
  if (versionIds.length > 0) {
    currentPtr = (await tx.select({ id: documents.id }).from(documents).where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId), inArray(documents.currentVersionId, versionIds)))).length;
    knowledge = (await tx.select({ id: knowledgeSources.id }).from(knowledgeSources).where(and(eq(knowledgeSources.orgId, ctx.orgId), eq(knowledgeSources.projectId, ctx.projectId), inArray(knowledgeSources.documentVersionId, versionIds)))).length;
    runRef = (await tx.select({ id: runDocumentVersions.id }).from(runDocumentVersions).where(and(eq(runDocumentVersions.orgId, ctx.orgId), eq(runDocumentVersions.projectId, ctx.projectId), inArray(runDocumentVersions.documentVersionId, versionIds)))).length;
    const runRows = await tx.select({ retrievedSources: runs.retrievedSources }).from(runs).where(and(eq(runs.orgId, ctx.orgId), eq(runs.projectId, ctx.projectId)));
    const idSet = new Set(versionIds);
    for (const r of runRows) {
      const snaps = (r.retrievedSources as RunSourceSnapshot[] | null) ?? [];
      if (snaps.some((s) => s.documentVersionId && idSet.has(s.documentVersionId))) runSnap += 1;
    }
  }

  const checks: ReferenceCheck[] = [
    { location: 'documents.object_key', count: docRefs },
    { location: 'document_versions.object_key', count: verRefs },
    { location: 'document_version_tombstones.object_key', count: tombRefs },
    { location: 'documents.current_version_id→version', count: currentPtr },
    { location: 'knowledge_sources→version', count: knowledge },
    { location: 'run_document_versions→version', count: runRef },
    { location: 'runs.retrieved_sources→version', count: runSnap },
  ];
  const referenced = docRefs > 0 || verRefs > 0 || currentPtr > 0 || knowledge > 0 || runRef > 0 || runSnap > 0;
  return { checks, referenced, tombstoned: tombRefs > 0 };
}

/**
 * READ-ONLY assessment of one object key (constraint #3: preview performs no mutation). Confirms tenant
 * ownership, runs the full reference closure, refuses any tombstoned/referenced/absent/ingestion-active
 * object, and — when eligible — captures the exact identity (size + content hash) + a binding fingerprint.
 */
export async function assessObjectCleanup(tx: DbTx, ctx: TenantContext, store: ObjectStore, objectKey: string): Promise<ObjectCleanupAssessment> {
  const base: Omit<ObjectCleanupAssessment, 'eligibility' | 'reason' | 'referencesChecked' | 'ingestionActive'> = {
    objectKey,
    size: null,
    sha256: null,
    fingerprint: null,
    whatRemains: 'No document, version, tombstone, chunk, or evidence row is affected — only the orphaned storage object would be removed.',
  };
  if (!keyBelongsToTenant(objectKey, ctx)) {
    return { ...base, eligibility: 'ineligible', refusal: 'not_tenant_object', reason: 'This object key is not owned by this workspace.', referencesChecked: [], ingestionActive: false };
  }

  const { checks, referenced, tombstoned } = await referenceClosure(tx, ctx, objectKey);
  if (tombstoned) {
    return { ...base, eligibility: 'ineligible', refusal: 'tombstoned', reason: 'A purge tombstone already owns this object; its cleanup is handled by purge, not legacy-object cleanup.', referencesChecked: checks, ingestionActive: false };
  }
  if (referenced) {
    return { ...base, eligibility: 'ineligible', refusal: 'referenced', reason: 'The object is still referenced by at least one authoritative record and must be preserved.', referencesChecked: checks, ingestionActive: false };
  }

  let bytes: Buffer;
  try {
    const head = await store.head(objectKey);
    if (head === null) return { ...base, eligibility: 'ineligible', refusal: 'object_absent', reason: 'No object exists at that key; there is nothing to clean up.', referencesChecked: checks, ingestionActive: false };
    bytes = await store.get(objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return { ...base, eligibility: 'ineligible', refusal: 'object_absent', reason: 'No object exists at that key; there is nothing to clean up.', referencesChecked: checks, ingestionActive: false };
    return { ...base, eligibility: 'ineligible', refusal: 'store_unreachable', reason: 'Object storage was not reachable to inspect this object; cleanup is refused until it can be verified.', referencesChecked: checks, ingestionActive: false };
  }

  const active = await ingestionActive(tx, ctx);
  if (active) {
    return { ...base, eligibility: 'ineligible', refusal: 'ingestion_active', reason: 'Ingestion is currently active in this workspace; cleanup is refused until it is quiescent.', referencesChecked: checks, ingestionActive: true };
  }

  const size = bytes.length;
  const sha = sha256Hex(bytes);
  return {
    ...base,
    size,
    sha256: sha,
    fingerprint: fingerprintOf(objectKey, size, sha),
    eligibility: 'eligible',
    reason: 'The object is present in storage and referenced by no document, version, tombstone, or evidence record — it is an orphan safe to propose for cleanup.',
    referencesChecked: checks,
    ingestionActive: false,
  };
}

export interface ObjectCleanupProposalResult {
  assessment: ObjectCleanupAssessment;
  /** The recorded 'proposed' operation, or null when the object was not eligible (nothing was recorded). */
  operationId: string | null;
  quietUntilMs: number | null;
}

/**
 * Record a cleanup PROPOSAL for an eligible orphan. Idempotent per key (one live proposed/authorized op at a
 * time). Captures the identity fingerprint and starts the quiet-period clock. Writes nothing to documents,
 * versions, tombstones, or the object store.
 */
export async function proposeObjectCleanup(
  tx: DbTx,
  ctx: TenantContext,
  store: ObjectStore,
  objectKey: string,
  opts?: { reason?: string; now?: Date; quietMs?: number },
): Promise<ObjectCleanupProposalResult> {
  assertObjectCleanupAuthority(ctx);
  const now = opts?.now ?? new Date();
  const quietMs = opts?.quietMs ?? DEFAULT_CLEANUP_QUIET_MS;
  const assessment = await assessObjectCleanup(tx, ctx, store, objectKey);
  if (assessment.eligibility !== 'eligible') return { assessment, operationId: null, quietUntilMs: null };

  const existing = (
    await tx
      .select({ id: objectCleanupOperations.id, proposedAt: objectCleanupOperations.proposedAt })
      .from(objectCleanupOperations)
      .where(and(eq(objectCleanupOperations.orgId, ctx.orgId), eq(objectCleanupOperations.projectId, ctx.projectId), eq(objectCleanupOperations.objectKey, objectKey), inArray(objectCleanupOperations.status, ['proposed', 'authorized'])))
      .limit(1)
  )[0];
  if (existing) return { assessment, operationId: existing.id, quietUntilMs: existing.proposedAt.getTime() + quietMs };

  const ins = await tx
    .insert(objectCleanupOperations)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, objectKey, objectSize: assessment.size, objectSha256: assessment.sha256, fingerprint: assessment.fingerprint!, status: 'proposed', referencesChecked: assessment.referencesChecked as unknown as Record<string, unknown>, reason: opts?.reason ?? null, proposedBy: ctx.userId, proposedAt: now })
    .returning({ id: objectCleanupOperations.id });
  const operationId = ins[0]!.id;
  await writeAudit(tx, ctx, {
    action: 'document.object_cleanup_proposed',
    entityType: 'document',
    entityId: operationId,
    // Metadata-only: a non-reversible key handle, identity size/hash-prefix, and the reference checks — never the raw path or bytes.
    detail: { operationId, keyHandle: keyHandle(objectKey), size: assessment.size, sha256: assessment.sha256?.slice(0, 12) ?? null, referencesChecked: assessment.referencesChecked },
  });
  return { assessment, operationId, quietUntilMs: now.getTime() + quietMs };
}

export type CleanupOutcome = 'deleted' | 'already_deleted' | 'reconciled_absent' | 'ambiguous' | 'failed' | 'refused';

export interface ObjectCleanupResult {
  operationId: string | null;
  outcome: CleanupOutcome;
  refusal?: CleanupRefusal;
  /** Did THIS operation perform the deletion (vs. the object already being gone)? */
  objectDeleted: boolean;
  /** Was the terminal lifecycle state committed to the database? */
  committed: boolean;
  /** Was the object's removal confirmed against storage (never assumed)? */
  verified: boolean;
  detail: string;
}

/** Each phase commits independently; cleanup writes no privileged (version/tombstone) rows, so plain withTenant works. */
export type CleanupTxRunner = <T>(fn: (tx: DbTx) => Promise<T>) => Promise<T>;

/**
 * AUTHORIZE + DELETE a proposed cleanup. Three phases:
 *   A (one DB tx): lock the op, re-check quiet-period elapsed, ingestion quiescent, full reference closure,
 *     and that the object identity still matches the proposal fingerprint; then mark it authorized.
 *   B (no DB tx): delete the external object — irreversible. On any error, reconcile via head().
 *   C (one DB tx): record the honest terminal state. 'deleted' is written ONLY after storage confirms removal;
 *     an ambiguous/failed delete leaves the op authorized for a reconciling retry with the error + attempt count.
 * Idempotent: a completed op reports 'already_deleted'; an object already gone reconciles to 'reconciled_absent'.
 */
export async function executeObjectCleanup(
  runTx: CleanupTxRunner,
  ctx: TenantContext,
  store: ObjectStore,
  operationId: string,
  opts?: { now?: Date; quietMs?: number },
): Promise<ObjectCleanupResult> {
  const now = opts?.now ?? new Date();
  const quietMs = opts?.quietMs ?? DEFAULT_CLEANUP_QUIET_MS;

  // ---- PHASE A: authorize under lock, re-checking every guard against the EXACT current state. -------------
  type AuthZ =
    | { decision: 'authorized'; objectKey: string }
    | { decision: 'reconciled_absent' }
    | { decision: 'already_deleted' }
    | { decision: 'refused'; refusal: CleanupRefusal };
  const authz: AuthZ = await runTx(async (tx) => {
    assertObjectCleanupAuthority(ctx);
    const op = (
      await tx
        .select({ id: objectCleanupOperations.id, objectKey: objectCleanupOperations.objectKey, fingerprint: objectCleanupOperations.fingerprint, status: objectCleanupOperations.status, proposedAt: objectCleanupOperations.proposedAt })
        .from(objectCleanupOperations)
        .where(and(eq(objectCleanupOperations.id, operationId), eq(objectCleanupOperations.orgId, ctx.orgId), eq(objectCleanupOperations.projectId, ctx.projectId)))
        .limit(1)
        .for('update')
    )[0];
    if (!op) return { decision: 'refused', refusal: 'not_proposed' }; // existence-neutral for another workspace
    if (op.status === 'deleted') return { decision: 'already_deleted' };
    if (op.status !== 'proposed' && op.status !== 'authorized') return { decision: 'refused', refusal: 'not_proposed' };

    if (now.getTime() - op.proposedAt.getTime() < quietMs) return { decision: 'refused', refusal: 'quiet_period_not_elapsed' };
    if (await ingestionActive(tx, ctx)) return { decision: 'refused', refusal: 'ingestion_active' };

    const { referenced, tombstoned } = await referenceClosure(tx, ctx, op.objectKey);
    if (tombstoned) return { decision: 'refused', refusal: 'tombstoned' };
    if (referenced) return { decision: 'refused', refusal: 'referenced' };

    let bytes: Buffer;
    try {
      bytes = await store.get(op.objectKey);
    } catch (err) {
      if (err instanceof ObjectNotFoundError) {
        // The object is already gone — reconcile the lifecycle without performing (or claiming) a deletion.
        await tx.update(objectCleanupOperations).set({ status: 'deleted', objectDeleted: false, deletedAt: now, lastError: null }).where(eq(objectCleanupOperations.id, operationId));
        await writeAudit(tx, ctx, { action: 'document.object_cleanup_deleted', entityType: 'document', entityId: operationId, detail: { operationId, keyHandle: keyHandle(op.objectKey), objectDeleted: false, reconciled: 'already_absent' } });
        return { decision: 'reconciled_absent' };
      }
      return { decision: 'refused', refusal: 'store_unreachable' };
    }
    const fp = fingerprintOf(op.objectKey, bytes.length, sha256Hex(bytes));
    if (fp !== op.fingerprint) return { decision: 'refused', refusal: 'identity_changed' };

    await tx.update(objectCleanupOperations).set({ status: 'authorized', authorizedAt: now, authorizedBy: ctx.userId }).where(eq(objectCleanupOperations.id, operationId));
    return { decision: 'authorized', objectKey: op.objectKey };
  });

  if (authz.decision === 'already_deleted') return { operationId, outcome: 'already_deleted', objectDeleted: false, committed: true, verified: true, detail: 'This object was already cleaned up; nothing further to do.' };
  if (authz.decision === 'reconciled_absent') return { operationId, outcome: 'reconciled_absent', objectDeleted: false, committed: true, verified: true, detail: 'The object was already absent from storage; the operation was reconciled to completed without deleting anything.' };
  if (authz.decision === 'refused') return { operationId, outcome: 'refused', refusal: authz.refusal, objectDeleted: false, committed: false, verified: false, detail: refusalDetail(authz.refusal) };

  // ---- PHASE B: the irreversible external delete (NOT inside a DB transaction). ---------------------------
  const objectKey = authz.objectKey;
  let deleteState: 'deleted' | 'ambiguous' | 'failed';
  let deleteError: string | null = null;
  try {
    await store.delete(objectKey);
    deleteState = 'deleted';
  } catch (err) {
    deleteError = err instanceof Error ? err.message.slice(0, 500) : String(err);
    // Reconcile via head() rather than assuming success or blindly retrying (constraint #8).
    try {
      const head = await store.head(objectKey);
      deleteState = head === null ? 'deleted' : 'failed';
    } catch {
      deleteState = 'ambiguous';
    }
  }

  // ---- PHASE C: record the honest terminal state — 'deleted' ONLY after storage confirmed removal. --------
  return await runTx(async (tx) => {
    if (deleteState === 'deleted') {
      await tx.update(objectCleanupOperations).set({ status: 'deleted', objectDeleted: true, deletedAt: now, lastError: null }).where(eq(objectCleanupOperations.id, operationId));
      await writeAudit(tx, ctx, { action: 'document.object_cleanup_deleted', entityType: 'document', entityId: operationId, detail: { operationId, keyHandle: keyHandle(objectKey), objectDeleted: true, verified: true } });
      return { operationId, outcome: 'deleted', objectDeleted: true, committed: true, verified: true, detail: 'The orphaned object was deleted and its removal was confirmed against storage.' };
    }
    // Ambiguous or failed: stay authorized (retryable), record the error + attempt; never claim deletion.
    await tx.update(objectCleanupOperations).set({ status: 'authorized', attempts: sql`${objectCleanupOperations.attempts} + 1`, lastError: deleteError }).where(eq(objectCleanupOperations.id, operationId));
    await writeAudit(tx, ctx, { action: 'document.object_cleanup_failed', entityType: 'document', entityId: operationId, detail: { operationId, keyHandle: keyHandle(objectKey), result: deleteState } });
    return deleteState === 'ambiguous'
      ? { operationId, outcome: 'ambiguous', objectDeleted: false, committed: true, verified: false, detail: 'The delete could not be confirmed against storage; the operation remains authorized for a reconciling retry and claims no success.' }
      : { operationId, outcome: 'failed', objectDeleted: false, committed: true, verified: false, detail: 'The object deletion failed; the operation remains authorized for a retry and no deletion was recorded.' };
  });
}

function refusalDetail(r: CleanupRefusal): string {
  switch (r) {
    case 'not_tenant_object': return 'This object key is not owned by this workspace.';
    case 'referenced': return 'The object is still referenced by an authoritative record and must be preserved.';
    case 'tombstoned': return 'A purge tombstone owns this object; cleanup does not overlap purge.';
    case 'object_absent': return 'No object exists at that key.';
    case 'store_unreachable': return 'Object storage was not reachable to verify the object; cleanup is refused.';
    case 'ingestion_active': return 'Ingestion is active in this workspace; cleanup is refused until it is quiescent.';
    case 'quiet_period_not_elapsed': return 'The proposal has not yet aged past the quiet period that protects in-flight uploads.';
    case 'identity_changed': return 'The object changed since it was proposed; the previewed identity no longer matches.';
    case 'not_proposed': return 'There is no proposed cleanup operation to authorize.';
  }
}
