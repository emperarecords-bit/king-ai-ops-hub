import { and, eq, sql } from 'drizzle-orm';
import { type DbTx } from '@/db/client';
import { runs, tasks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Stranded runs: a run whose finalization was AUDITED as completed but whose row was never closed — still
 * status 'running', reliability 'finalizing', no consolidated result. Hub prod (read-only check 2026-10-24): 14
 * such runs from 2026-08-20..09-01, each with a done job, a checkpointed draft and a `run.finalization_completed`
 * audit event. They show as "running" forever. Nothing will ever finish them: their job is done and no newer run
 * exists.
 *
 * The repair closes each one as FAILED with a reason that says what happened, keeps the checkpointed draft as is,
 * and moves the task to 'failed' ONLY when the task itself still says 'running' (so it can be re-run). A cancelled
 * or completed task is left alone. No notification is sent. Every repair is audited (`run.stranded_closed`).
 *
 * Selection is deliberately narrow — every condition must hold, and each is re-checked inside the repair
 * transaction with the run row locked, so a run that moved since the dry run is skipped, never overwritten.
 */

export const STRANDED_RUN_MIN_AGE_DAYS = 7;

export interface StrandedRun {
  runId: string;
  taskId: string;
  orgId: string;
  projectId: string;
  projectKey: string;
  startedAt: Date;
  taskStatus: string;
  finalizationAuditedAt: Date;
}

/** The candidate predicate, shared by the finder and the in-transaction re-check (aliases: r = runs, t = tasks). */
const strandedPredicate = (cutoff: Date) => sql`
  r.status = 'running'
  and r.reliability_state = 'finalizing'
  and r.consolidated_result is null
  and r.started_at < ${cutoff}
  and not exists (select 1 from run_jobs j where j.task_id = r.task_id and j.status in ('queued', 'running'))
  and not exists (select 1 from runs r2 where r2.task_id = r.task_id and r2.id <> r.id and r2.started_at > r.started_at)
  and exists (select 1 from audit_logs a where a.entity_type = 'run' and a.entity_id = r.id and a.action = 'run.finalization_completed')`;

export function strandedCutoff(now: Date, minAgeDays = STRANDED_RUN_MIN_AGE_DAYS): Date {
  return new Date(now.getTime() - minAgeDays * 86_400_000);
}

/** Read-only. Owner/migration connection (cross-workspace); ordered oldest first. */
export async function findStrandedRuns(tx: DbTx, cutoff: Date): Promise<StrandedRun[]> {
  const rows = await tx.execute<{
    run_id: string;
    task_id: string;
    org_id: string;
    project_id: string;
    project_key: string;
    started_at: Date | string;
    task_status: string;
    finalization_audited_at: Date | string;
  }>(sql`
    select r.id as run_id, r.task_id, r.org_id, r.project_id, p.key as project_key, r.started_at, t.status::text as task_status,
           (select max(a.created_at) from audit_logs a where a.entity_type = 'run' and a.entity_id = r.id and a.action = 'run.finalization_completed') as finalization_audited_at
    from runs r join tasks t on t.id = r.task_id join projects p on p.id = r.project_id
    where ${strandedPredicate(cutoff)}
    order by r.started_at, r.id`);
  return [...rows].map((x) => ({
    runId: x.run_id,
    taskId: x.task_id,
    orgId: x.org_id,
    projectId: x.project_id,
    projectKey: x.project_key,
    startedAt: new Date(x.started_at),
    taskStatus: x.task_status,
    finalizationAuditedAt: new Date(x.finalization_audited_at),
  }));
}

export function strandedReason(run: Pick<StrandedRun, 'finalizationAuditedAt'>, now: Date): string {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  return (
    `Closed by repair on ${day(now)}: this run's finalization was recorded as complete on ${day(run.finalizationAuditedAt)}, ` +
    'but the run was never closed and its final answer was never saved. Its draft is kept. Re-run the task to get a final answer.'
  );
}

export type RepairOutcome = { runId: string; repaired: true; taskFailed: boolean } | { runId: string; repaired: false; skipped: string };

/**
 * Close ONE stranded run in its own transaction. Locks the run, re-checks every condition, and skips (never
 * overwrites) a run that no longer qualifies. `actorUserId` attributes the audit event.
 */
export async function closeStrandedRun(tx: DbTx, run: StrandedRun, opts: { now: Date; cutoff: Date; actorUserId: string }): Promise<RepairOutcome> {
  const still = await tx.execute<{ task_status: string }>(sql`
    select t.status::text as task_status from runs r join tasks t on t.id = r.task_id
    where r.id = ${run.runId} and ${strandedPredicate(opts.cutoff)}
    for update of r`);
  const row = [...still][0];
  if (!row) return { runId: run.runId, repaired: false, skipped: 'no longer stranded' };

  const reason = strandedReason(run, opts.now);
  await tx
    .update(runs)
    .set({ status: 'failed', reliabilityState: 'failed', errorMessage: reason, finishedAt: opts.now, updatedAt: opts.now })
    .where(and(eq(runs.id, run.runId), eq(runs.status, 'running')));
  const taskFailed = row.task_status === 'running';
  if (taskFailed) {
    await tx.update(tasks).set({ status: 'failed', updatedAt: opts.now }).where(and(eq(tasks.id, run.taskId), eq(tasks.status, 'running')));
  }
  await writeAudit(tx, { orgId: run.orgId, projectId: run.projectId, userId: opts.actorUserId }, {
    action: 'run.stranded_closed',
    entityType: 'run',
    entityId: run.runId,
    detail: {
      reason,
      startedAt: run.startedAt.toISOString(),
      finalizationAuditedAt: run.finalizationAuditedAt.toISOString(),
      taskStatusBefore: row.task_status,
      taskFailed,
    },
  });
  return { runId: run.runId, repaired: true, taskFailed };
}
