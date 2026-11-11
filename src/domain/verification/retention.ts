/**
 * VER-002 PR-7 — the recoverable retention / purge lifecycle, domain side.
 * See docs/verification/external-runner-design.md §3.2.
 *
 * This module is deliberately storage- and DB-agnostic: it sequences the lifecycle and owns the rules
 * about WHEN a job may be considered finished. Everything that touches Postgres or S3 arrives through a
 * port, so the ordering guarantees below are testable without either.
 *
 * The invariants it exists to hold:
 *
 *  1. The object list is durable BEFORE the references go. That ordering lives in
 *     `app.purge_verification_evidence()` (one transaction), so `openEvidencePurge` is a thin call into
 *     it rather than a read-modify-write here — doing it in TypeScript would reintroduce the window the
 *     SQL closes.
 *  2. A failure is a RETRY, never a terminal state. `drainPurgeJob` records the failure and leaves the
 *     object pending, so the next sweep picks it up. No object is ever silently skipped.
 *  3. A job completes only when EVERY listed object is confirmed gone — and that decision is made by the
 *     database (`record_verification_purge_object_deleted` flips the job when the outstanding count hits
 *     zero), not by counting successes in this process. A worker that crashed mid-drain must not be able
 *     to leave a job marked complete with objects still live.
 *  4. One failing object does not stall the rest of the job. Each object is attempted independently.
 *
 * TENANCY. Every port method is tenant-scoped because the retention role is NOBYPASSRLS. There is no
 * cross-tenant sweep and that is not an oversight: a query issued without the tenant GUCs set returns a
 * FALSE EMPTY rather than an error, which is exactly how a "nothing to do" bug hides. Draining more than
 * one project means iterating projects and establishing the tenant context for each.
 */
import type { PurgeJobStore, PurgeReason, RetentionObjectDeleter } from './ports';

/** An audit sink. Optional so the lifecycle is testable without the audit chain; the worker wires it. */
export type RetentionAuditSink = (event: {
  readonly action: string;
  readonly entityId: string | null;
  readonly detail: Record<string, unknown>;
}) => Promise<void>;

export interface RetentionDeps {
  readonly store: PurgeJobStore;
  readonly deleter: RetentionObjectDeleter;
  readonly audit?: RetentionAuditSink;
  /** Injectable for tests. */
  readonly now?: () => Date;
}

export interface DrainResult {
  readonly jobId: string;
  /** Objects confirmed gone during THIS drain (not the job total). */
  readonly deleted: number;
  /** Objects that failed during this drain and remain pending for the next one. */
  readonly failed: number;
  /** Whether the DATABASE now reports the job complete. Never inferred from the counts above. */
  readonly complete: boolean;
}

/** Deletion errors are expected and retried, so they must never escape as unhandled rejections. */
function errorText(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}

/**
 * Open a purge for a set of evidence rows. The job row, its object list, and the removal of the evidence
 * references all happen inside one database transaction — see invariant 1.
 */
export async function openEvidencePurge(
  deps: RetentionDeps,
  evidenceIds: readonly string[],
  reason: PurgeReason,
): Promise<string> {
  if (evidenceIds.length === 0) {
    throw new Error('openEvidencePurge: at least one evidence id is required');
  }
  const jobId = await deps.store.openPurge(evidenceIds, reason);
  await deps.audit?.({
    action: 'verification.evidence.purge_opened',
    entityId: jobId,
    detail: { reason, evidenceCount: evidenceIds.length },
  });
  return jobId;
}

/**
 * Attempt every outstanding object of one job exactly once. Returns what happened; does NOT decide
 * completion — `recordObjectDeleted` lets the database make that call (invariant 3).
 */
export async function drainPurgeJob(deps: RetentionDeps, jobId: string): Promise<DrainResult> {
  const pending = await deps.store.listPendingObjects(jobId);
  let deleted = 0;
  let failed = 0;

  for (const obj of pending) {
    try {
      await deps.deleter.delete(obj.objectKey, obj.versionId);
      // Only after the provider confirms the delete do we record it — recording first would let a failed
      // delete mark the job complete with the object still live.
      const applied = await deps.store.recordObjectDeleted(obj.id);
      if (applied) deleted += 1;
    } catch (e) {
      // Invariant 2: a failure raises the attempt count and leaves the object pending. Invariant 4: we
      // keep going, so one poisoned object cannot starve the rest of the job.
      failed += 1;
      await deps.store.recordObjectFailure(obj.id, errorText(e));
    }
  }

  const job = await deps.store.getJob(jobId);
  const complete = job?.status === 'complete';
  if (complete) {
    await deps.audit?.({
      action: 'verification.evidence.purge_completed',
      entityId: jobId,
      detail: { objectCount: job?.objectCount ?? null },
    });
  }
  return { jobId, deleted, failed, complete };
}

/**
 * Drain up to `limit` open jobs for the CURRENT tenant. Safe to re-run: a job with nothing outstanding
 * yields a no-op drain, and a crash mid-sweep simply leaves jobs open for the next pass.
 */
export async function drainOpenPurgeJobs(deps: RetentionDeps, limit = 10): Promise<DrainResult[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('drainOpenPurgeJobs: limit must be a positive integer');
  const jobIds = await deps.store.listOpenJobIds(limit);
  const results: DrainResult[] = [];
  for (const jobId of jobIds) {
    results.push(await drainPurgeJob(deps, jobId));
  }
  return results;
}
