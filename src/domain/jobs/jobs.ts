import 'server-only';
import { and, eq, lt, or, sql } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { log } from '@/lib/log';
import { getDb, type DbTx } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { projectMembers, runJobs, runs, tasks } from '@/db/schema';
import { startRun, type RunLiveEvents, type RunOutcome } from '@/domain/tasks/runner';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Durable run execution (O-21). A task's run is enqueued as a `run_jobs` row and
 * executed by a worker that CLAIMS jobs atomically (FOR UPDATE SKIP LOCKED + a
 * lease). This removes the dependency on an open browser request, a terminal,
 * or a single in-memory process: a job survives a restart, is claimed by
 * exactly one worker, and never bills a provider sequence twice.
 *
 * Cross-tenant note: claiming reads `run_jobs` across workspaces, so — like the
 * standing-work tick — the worker's DB role must be able to read the queue
 * (a system role, or the superuser used in dev). The RUN itself still executes
 * through `withTenant`, so per-tenant isolation is unchanged.
 */

const LEASE_MS = 10 * 60 * 1000; // a run must finish (RUN_TIMEOUT) well within this

export interface ClaimedJob {
  jobId: string;
  taskId: string;
  orgId: string;
  projectId: string;
  createdBy: string;
}

/** Enqueue a task for durable execution. Idempotent: the partial unique index
 *  on (task_id) where status in (queued,running) rejects a duplicate live job. */
export async function enqueueRun(tx: DbTx, ctx: TenantContext, taskId: string): Promise<void> {
  await tx
    .insert(runJobs)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId, status: 'queued' })
    .onConflictDoNothing();
  await writeAudit(tx, ctx, {
    action: 'run_job.enqueued',
    entityType: 'task',
    entityId: taskId,
    detail: {},
  });
}

/**
 * Atomically claims the next runnable job across all workspaces: a queued job,
 * or a running job whose lease expired (worker died). Sets a fresh lease and
 * bumps attempts. Returns null when nothing is claimable.
 */
export async function claimNextJob(): Promise<ClaimedJob | null> {
  const db = getDb();
  const rows = await db.execute(sql`
    update run_jobs j
    set status = 'running',
        attempts = j.attempts + 1,
        leased_until = now() + interval '${sql.raw(String(LEASE_MS))} milliseconds',
        updated_at = now()
    where j.id = (
      select id from run_jobs
      where status = 'queued'
         or (status = 'running' and leased_until < now())
      order by created_at
      for update skip locked
      limit 1
    )
    returning j.id, j.task_id, j.org_id, j.project_id
  `);
  const row = (rows as unknown as { rows?: Array<Record<string, string>> }).rows?.[0]
    ?? (Array.isArray(rows) ? (rows[0] as Record<string, string>) : undefined);
  if (!row) return null;
  const taskId = String(row.task_id);
  const orgId = String(row.org_id);
  const projectId = String(row.project_id);

  // The run executes as the task's creator (same identity the UI would use).
  const creator = (
    await db.select({ createdBy: tasks.createdBy }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
  )[0];
  return {
    jobId: String(row.id),
    taskId,
    orgId,
    projectId,
    createdBy: creator?.createdBy ?? '',
  };
}

/**
 * Atomically claims the job for a SPECIFIC task (the interactive path: a user
 * starts a run and we execute it inline with live updates, while keeping the
 * durable job row). Returns null when a worker already claimed it.
 */
export async function claimJobForTask(
  ctx: TenantContext,
  taskId: string,
): Promise<ClaimedJob | null> {
  const db = getDb();
  const rows = await db.execute(sql`
    update run_jobs j
    set status = 'running',
        attempts = j.attempts + 1,
        leased_until = now() + interval '${sql.raw(String(LEASE_MS))} milliseconds',
        updated_at = now()
    where j.id = (
      select id from run_jobs
      where task_id = ${taskId}
        and org_id = ${ctx.orgId}
        and project_id = ${ctx.projectId}
        and (status = 'queued' or (status = 'running' and leased_until < now()))
      for update skip locked
      limit 1
    )
    returning j.id, j.task_id, j.org_id, j.project_id
  `);
  const row = (rows as unknown as { rows?: Array<Record<string, string>> }).rows?.[0]
    ?? (Array.isArray(rows) ? (rows[0] as Record<string, string>) : undefined);
  if (!row) return null;
  return { jobId: String(row.id), taskId, orgId: ctx.orgId, projectId: ctx.projectId, createdBy: ctx.userId };
}

async function ctxForJob(job: ClaimedJob): Promise<TenantContext> {
  const db = getDb();
  const m = (
    await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, job.projectId), eq(projectMembers.userId, job.createdBy)))
      .limit(1)
  )[0];
  return {
    userId: job.createdBy,
    orgId: job.orgId,
    projectId: job.projectId,
    orgRole: 'member',
    projectRole: m?.role ?? 'viewer',
  };
}

/**
 * Executes a claimed job. If the task is already `running`, a prior attempt was
 * interrupted mid-run: we do NOT re-execute (that would re-bill the provider
 * sequence). Instead we mark the run failed with a recoverable reason and the
 * job failed — an observable, retryable state.
 */
export async function runClaimedJob(job: ClaimedJob, live?: RunLiveEvents): Promise<RunOutcome | null> {
  const ctx = await ctxForJob(job);
  const db = getDb();

  const task = (
    await db.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, job.taskId)).limit(1)
  )[0];
  if (!task) {
    await failJob(job.jobId, 'task no longer exists');
    return null;
  }
  if (task.status === 'running') {
    // Interrupted mid-run — recover, do not re-run.
    await recoverInterrupted(ctx, job.taskId, job.jobId);
    return null;
  }
  if (task.status !== 'pending' && task.status !== 'failed') {
    // Already completed/cancelled/awaiting — nothing to do; close the job.
    await db.update(runJobs).set({ status: 'done', updatedAt: new Date() }).where(eq(runJobs.id, job.jobId));
    return null;
  }

  try {
    const outcome = await startRun(ctx, job.taskId, live);
    await db
      .update(runJobs)
      .set({
        status: outcome.status === 'failed' ? 'failed' : 'done',
        lastError: outcome.failureReason,
        updatedAt: new Date(),
      })
      .where(eq(runJobs.id, job.jobId));
    return outcome;
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown worker error';
    await failJob(job.jobId, reason);
    log.error('run job execution threw', { jobId: job.jobId, taskId: job.taskId, reason });
    return null;
  }
}

async function failJob(jobId: string, reason: string): Promise<void> {
  await getDb()
    .update(runJobs)
    .set({ status: 'failed', lastError: reason.slice(0, 500), updatedAt: new Date() })
    .where(eq(runJobs.id, jobId));
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
  await getDb()
    .update(runJobs)
    .set({ status: 'failed', lastError: 'interrupted; recovered', updatedAt: new Date() })
    .where(eq(runJobs.id, jobId));
}

export interface ReconcileResult {
  requeued: number;
  recovered: number;
}

/**
 * Startup reconciliation: reclaim jobs whose lease expired. A stale job whose
 * task is still `running` was interrupted mid-run → recover (fail-recoverable).
 * A stale job whose task is `pending` never started provider work → requeue.
 */
export async function reconcileStaleJobs(): Promise<ReconcileResult> {
  const db = getDb();
  const stale = await db
    .select({ id: runJobs.id, taskId: runJobs.taskId, orgId: runJobs.orgId, projectId: runJobs.projectId })
    .from(runJobs)
    .where(and(eq(runJobs.status, 'running'), or(lt(runJobs.leasedUntil, new Date()), sql`leased_until is null`)));

  let requeued = 0;
  let recovered = 0;
  for (const s of stale) {
    const task = (
      await db.select({ status: tasks.status, createdBy: tasks.createdBy }).from(tasks).where(eq(tasks.id, s.taskId)).limit(1)
    )[0];
    if (!task) {
      await failJob(s.id, 'task no longer exists');
      continue;
    }
    if (task.status === 'running') {
      const ctx = await ctxForJob({ jobId: s.id, taskId: s.taskId, orgId: s.orgId, projectId: s.projectId, createdBy: task.createdBy });
      await recoverInterrupted(ctx, s.taskId, s.id);
      recovered += 1;
    } else {
      await db.update(runJobs).set({ status: 'queued', leasedUntil: null, updatedAt: new Date() }).where(eq(runJobs.id, s.id));
      requeued += 1;
    }
  }
  return { requeued, recovered };
}
