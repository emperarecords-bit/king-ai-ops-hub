import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { type DispatchKind, type ProjectRole, type TenantContext } from '@/types/domain';
import { log } from '@/lib/log';
import { getDb, type DbTx } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { runJobs, runs, tasks } from '@/db/schema';
import {
  resumeRun,
  startRun,
  type RunJobContext,
  type RunLiveEvents,
  type RunOutcome,
} from '@/domain/tasks/runner';
import { LeaseLostSignal } from '@/orchestration/engine';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Durable run execution (O-21, hardened for RLS in O-22). A task's run is
 * enqueued as a `run_jobs` row and executed by a worker that CLAIMS jobs
 * atomically (FOR UPDATE SKIP LOCKED + a lease). This removes the dependency on
 * an open browser request, a terminal, or a single in-memory process: a job
 * survives a restart, is claimed by exactly one worker, and never bills a
 * provider sequence twice.
 *
 * Isolation model under the non-superuser `app_server` role (O-22):
 *   * The one CROSS-tenant step — scanning/claiming the queue before we know
 *     whose job is next — runs through SECURITY DEFINER functions in schema
 *     `app` (owned by the BYPASSRLS `app_system`, EXECUTE-granted to
 *     app_server). app_server has no general cross-tenant read.
 *   * Every per-job write to run_jobs also goes through those functions, so the
 *     worker never needs a tenant GUC merely to update queue status.
 *   * The RUN ITSELF (startRun, recoverInterrupted) executes under withTenant()
 *     with the job's persisted (org, project) — RLS fully enforced, and one
 *     job's tenant context can never leak into the next (transaction-local
 *     GUCs, fresh per job).
 */

const LEASE_MS = 10 * 60 * 1000; // a run must finish (RUN_TIMEOUT) well within this

export interface ClaimedJob {
  jobId: string;
  taskId: string;
  orgId: string;
  projectId: string;
  createdBy: string;
  projectRole: ProjectRole;
  /** Hub P1d — the job's `attempts` counter at claim time: the lease OWNERSHIP token. A reclaim increments
   *  it, so a superseded worker's ownership check fails and it can never overwrite the winner. */
  attempt: number;
}

interface ClaimRow {
  job_id: string;
  task_id: string;
  org_id: string;
  project_id: string;
  created_by: string | null;
  project_role: string | null;
}

/** Normalize a drizzle `execute` result (postgres-js may return an array or a
 *  `{ rows }` wrapper) to the first row, or undefined. */
function firstRow<T>(result: unknown): T | undefined {
  const wrapped = (result as { rows?: T[] }).rows;
  if (Array.isArray(wrapped)) return wrapped[0];
  if (Array.isArray(result)) return (result as T[])[0];
  return undefined;
}

function claimedFrom(row: ClaimRow): ClaimedJob {
  return {
    jobId: String(row.job_id),
    taskId: String(row.task_id),
    orgId: String(row.org_id),
    projectId: String(row.project_id),
    createdBy: row.created_by ? String(row.created_by) : '',
    projectRole: (row.project_role as ProjectRole) ?? 'viewer',
    attempt: 0,
  };
}

/** Read a job's current `attempts` counter (the lease ownership token) via the dispatcher. */
async function jobAttempt(jobId: string): Promise<number> {
  const result = await getDb().execute(sql`select app.run_job_attempt(${jobId}) as attempt`);
  const row = firstRow<{ attempt: number | string | null }>(result);
  return row && row.attempt != null ? Number(row.attempt) : 0;
}

/**
 * Hub P1d — renew the job lease + heartbeat IFF this worker still owns it (status running AND the
 * `attempts` token unchanged). Returns false once the job was reclaimed by another worker, so a stale
 * worker's ownership check fails and it defers to the winner. Exposed so the runner's per-run
 * `RunJobContext.ownsLease()` re-confirms ownership before every provider dispatch and before the terminal
 * finalize commit.
 */
export async function renewRunJobLease(jobId: string, attempt: number): Promise<boolean> {
  const result = await getDb().execute(
    sql`select app.renew_run_job_lease(${jobId}, ${attempt}, ${LEASE_MS}) as owned`,
  );
  const row = firstRow<{ owned: boolean | string | null }>(result);
  return row?.owned === true || row?.owned === 't';
}

/**
 * Hub P1d — the IN-TRANSACTION lease fence. Same ownership predicate as {@link renewRunJobLease}, but run on
 * the CALLER's transaction (`tx`) via the SECURITY DEFINER `app.renew_run_job_lease`, which performs an
 * `UPDATE ... WHERE id AND status='running' AND attempts=<token>` — taking a ROW LOCK on the run_jobs row
 * that is HELD until the caller's transaction commits/rolls back. That lock is the mutual-exclusion the
 * proposal-application transaction needs: while it is held no concurrent reclaim can advance `attempts`, and
 * a second application transaction blocks here until the first commits (then observes the completed state).
 * Returns true iff THIS token still owns the job. A stale/reclaimed token gets false → the caller must abort
 * BEFORE any proposal/usage/audit write.
 */
export async function renewRunJobLeaseTx(tx: DbTx, jobId: string, attempt: number): Promise<boolean> {
  const result = await tx.execute(sql`select app.renew_run_job_lease(${jobId}, ${attempt}, ${LEASE_MS}) as owned`);
  const row = firstRow<{ owned: boolean | string | null }>(result);
  return row?.owned === true || row?.owned === 't';
}

function ctxForJob(job: ClaimedJob): TenantContext {
  // Built purely from the job's trusted persisted fields + the creator's role
  // resolved by the claim function. No ambient/leaked identity is possible.
  return {
    userId: job.createdBy,
    orgId: job.orgId,
    projectId: job.projectId,
    orgRole: 'member',
    projectRole: job.projectRole,
  };
}

/** Enqueue a task for durable execution. Idempotent: the partial unique index
 *  on (task_id) where status in (queued,running) rejects a duplicate live job.
 *  Runs inside the caller's tenant transaction, so RLS validates ownership.
 *  `dispatchKind` (Hub P1d) records HOW the job entered the queue — metadata
 *  only, it never changes claim eligibility. Defaults to 'interactive' for the
 *  inline user-started path; the standing-work tick passes 'standing'. */
export async function enqueueRun(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  dispatchKind: DispatchKind = 'interactive',
): Promise<void> {
  await tx
    .insert(runJobs)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId, status: 'queued', dispatchKind })
    .onConflictDoNothing();
  await writeAudit(tx, ctx, {
    action: 'run_job.enqueued',
    entityType: 'task',
    entityId: taskId,
    detail: { dispatchKind },
  });
}

/**
 * Atomically claims the next runnable job across all workspaces (queued, or a
 * running job whose lease expired). The cross-tenant scan/claim + creator/role
 * resolution happen inside the SECURITY DEFINER dispatcher; app_server only
 * EXECUTEs it. Returns null when nothing is claimable.
 */
export async function claimNextJob(): Promise<ClaimedJob | null> {
  const result = await getDb().execute(
    sql`select * from app.claim_next_run_job(${LEASE_MS})`,
  );
  const row = firstRow<ClaimRow>(result);
  if (!row) return null;
  return { ...claimedFrom(row), attempt: await jobAttempt(String(row.job_id)) };
}

/**
 * Atomically claims the job for a SPECIFIC task (the interactive path: a user
 * starts a run and we execute it inline with live updates, keeping the durable
 * job row). Scoped to the caller's tenant inside the dispatcher. Returns null
 * when a worker already claimed it.
 */
export async function claimJobForTask(
  ctx: TenantContext,
  taskId: string,
): Promise<ClaimedJob | null> {
  const result = await getDb().execute(
    sql`select * from app.claim_run_job_for_task(${taskId}, ${ctx.orgId}, ${ctx.projectId}, ${LEASE_MS})`,
  );
  const row = firstRow<ClaimRow>(result);
  if (!row) return null;
  // The acting identity for the interactive path is the caller, not (only) the
  // task creator — preserve their role for the run's authority decisions.
  return {
    ...claimedFrom(row),
    createdBy: ctx.userId,
    projectRole: ctx.projectRole,
    attempt: await jobAttempt(String(row.job_id)),
  };
}

/**
 * Executes a claimed job (Hub P1d — crash-safe). If the task is already `running`, a prior attempt was
 * interrupted mid-run: we RESUME the SAME run row (replaying durable checkpoints, no second provider call,
 * no re-bill) rather than re-creating a new run — a Stage-2 run continues where it stopped, an uncertain
 * dispatch resolves to reconciliation_required, and a completed-but-unfinalized run finalizes idempotently.
 * A fresh (`pending`/`failed`) task starts a new run. The claimed job's ownership token is threaded so a
 * reclaimed (stale) worker can never overwrite the winner's outcome.
 */
export async function runClaimedJob(job: ClaimedJob, live?: RunLiveEvents): Promise<RunOutcome | null> {
  const ctx = ctxForJob(job);
  if (!ctx.userId) {
    // A job whose task lost its creator cannot be given a trusted tenant
    // identity — fail closed rather than run under a guessed context (O-22).
    log.error('run job has no restorable tenant identity; failing closed', {
      jobId: job.jobId,
      taskId: job.taskId,
    });
    await failJob(job.jobId, 'no restorable tenant identity');
    return null;
  }

  // Read the task's status UNDER the job's tenant context (RLS-enforced).
  const task = await withTenant(ctx, (tx) =>
    tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, job.taskId)).limit(1),
  ).then((r) => r[0]);

  if (!task) {
    await failJob(job.jobId, 'task no longer exists');
    return null;
  }
  if (task.status !== 'running' && task.status !== 'pending' && task.status !== 'failed') {
    // Already completed / awaiting_approval / cancelled — nothing to execute; drain the job with ZERO
    // provider calls (this also cleanly terminates a job left behind by a cancelled-while-queued task).
    await finishJob(job.jobId, 'done');
    return null;
  }

  const jobCtx: RunJobContext = {
    jobId: job.jobId,
    attempt: job.attempt,
    ownsLease: () => renewRunJobLease(job.jobId, job.attempt),
    ownsLeaseTx: (tx) => renewRunJobLeaseTx(tx, job.jobId, job.attempt),
  };

  try {
    const outcome =
      task.status === 'running'
        ? await resumeRun(ctx, job.taskId, live, jobCtx)
        : await startRun(ctx, job.taskId, live, jobCtx);

    if (outcome.status === 'failed') {
      await finishJob(job.jobId, 'failed', outcome.failureReason);
    } else if (outcome.status === 'reconciliation_required') {
      await finishJob(job.jobId, 'failed', 'reconciliation_required');
    } else {
      // completed / awaiting_approval / cancelled → the job's lifecycle is done.
      await finishJob(job.jobId, 'done', outcome.status === 'cancelled' ? 'cancelled' : null);
    }
    return outcome;
  } catch (err) {
    if (err instanceof LeaseLostSignal) {
      // The job was reclaimed by another worker mid-run. Back off WITHOUT touching the job or the run — the
      // reclaiming worker is the winner and owns the terminal outcome.
      log.warn('run job lease lost; backing off (another worker owns it)', { jobId: job.jobId, taskId: job.taskId });
      return null;
    }
    const reason = err instanceof Error ? err.message : 'unknown worker error';
    await failJob(job.jobId, reason);
    log.error('run job execution threw', { jobId: job.jobId, taskId: job.taskId, reason });
    return null;
  }
}

/** Queue status transitions go through the dispatcher (no tenant GUC needed). */
async function finishJob(jobId: string, status: 'done' | 'failed', reason?: string | null): Promise<void> {
  await getDb().execute(sql`select app.finish_run_job(${jobId}, ${status}, ${reason ?? null})`);
}

async function failJob(jobId: string, reason: string): Promise<void> {
  await finishJob(jobId, 'failed', reason);
}

async function recoverInterrupted(ctx: TenantContext, taskId: string, jobId: string): Promise<void> {
  await withTenant(ctx, async (tx) => {
    // Mark the orphaned run (if any) failed-recoverable, and the task failed.
    await tx
      .update(runs)
      .set({
        status: 'failed',
        errorMessage: 'Interrupted by a service restart — recoverable, safe to retry.',
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(runs.taskId, taskId), eq(runs.status, 'running')));
    await tx
      .update(tasks)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(tasks.id, taskId));
    await writeAudit(tx, ctx, {
      action: 'run.recovered_interrupted',
      entityType: 'task',
      entityId: taskId,
      detail: { jobId },
    });
  });
  await finishJob(jobId, 'failed', 'interrupted; recovered');
}

export interface ReconcileResult {
  requeued: number;
  recovered: number;
}

/**
 * Startup + periodic reconciliation: reclaim jobs whose lease expired. The cross-tenant scan runs through
 * the SECURITY DEFINER `app.list_stale_run_jobs()`; each job's recovery then runs under its own restored
 * tenant context.
 *   * task `running` with a Stage-2 (durable, checkpointed) run → REQUEUE for RESUME: the next worker
 *     continues the SAME run from its checkpoints (or resolves an uncertain dispatch to
 *     reconciliation_required). Its billed work is preserved; no new run is created.
 *   * task `running` with a LEGACY run (no reliability lifecycle / no checkpoints) → recover
 *     (fail-recoverable), preserving P1c behavior; a retry then creates a fresh run.
 *   * task `pending` → never started provider work → requeue.
 */
export async function reconcileStaleJobs(): Promise<ReconcileResult> {
  const result = await getDb().execute(sql`select * from app.list_stale_run_jobs()`);
  const wrapped = (result as { rows?: unknown[] }).rows;
  const stale = (Array.isArray(wrapped) ? wrapped : (result as unknown[])) as Array<{
    job_id: string;
    task_id: string;
    org_id: string;
    project_id: string;
    task_status: string | null;
    created_by: string | null;
    project_role: string | null;
  }>;

  let requeued = 0;
  let recovered = 0;
  for (const s of stale) {
    if (!s.task_status) {
      await failJob(String(s.job_id), 'task no longer exists');
      continue;
    }
    if (s.task_status === 'running') {
      if (!s.created_by) {
        await failJob(String(s.job_id), 'no restorable tenant identity');
        continue;
      }
      const ctx = ctxForJob(
        claimedFrom({
          job_id: s.job_id,
          task_id: s.task_id,
          org_id: s.org_id,
          project_id: s.project_id,
          created_by: s.created_by,
          project_role: s.project_role,
        }),
      );
      // Is the in-flight run a Stage-2 (durable, resumable) run? A non-null reliability_state means it
      // participates in the crash-safe lifecycle and can be RESUMED from its checkpoints.
      const runState = await withTenant(ctx, (tx) =>
        tx
          .select({ state: runs.reliabilityState })
          .from(runs)
          .where(and(eq(runs.taskId, String(s.task_id)), eq(runs.status, 'running')))
          .orderBy(desc(runs.createdAt))
          .limit(1),
      ).then((r) => r[0]?.state ?? null);

      if (runState != null) {
        // Stage-2 run — requeue so the next worker resumes the SAME run (no new run, no re-bill).
        await getDb().execute(sql`select app.requeue_run_job(${s.job_id})`);
        requeued += 1;
      } else {
        // Legacy interrupted run (no durable checkpoints) — recover to failed-recoverable (P1c behavior).
        await recoverInterrupted(ctx, String(s.task_id), String(s.job_id));
        recovered += 1;
      }
    } else {
      await getDb().execute(sql`select app.requeue_run_job(${s.job_id})`);
      requeued += 1;
    }
  }
  return { requeued, recovered };
}
