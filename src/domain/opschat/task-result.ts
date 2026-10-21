import { and, desc, eq, sql } from 'drizzle-orm';
import { type DbTx } from '@/db/client';
import { approvals, runs } from '@/db/schema';

/**
 * P5c-1 — Ops Chat reads what a task's run ACTUALLY produced (runs.consolidated_result), not just "result available".
 *
 * Evidence (server-cooling conversation, Hub prod 2026-10-19/20): the owner had to keep asking "what did it come back
 * with?" — Ops Chat could only say a result existed. The result is now readable, bounded and paged, always labelled
 * with how far it can be trusted, and always wrapped as untrusted DATA (a run's output is model text: it can never
 * instruct Ops Chat or authorize anything).
 *
 * The label is derived ONLY from stored facts:
 *   RUNNING          the run has not finished;
 *   FAILED           the run failed (no result);
 *   APPROVAL NEEDED  completed, but approvals it proposed are still pending — not done until the owner decides;
 *   UNREVIEWED DRAFT completed, review was required but did not happen — not final;
 *   FINAL            completed and reviewed, or review was not required;
 *   NO RESULT        no run yet, or a completed run that recorded no text.
 * Tenancy: the caller passes a tenant transaction (withTenant) — RLS scopes every read to that workspace.
 */

export type ResultLabel = 'FINAL' | 'UNREVIEWED DRAFT' | 'FAILED' | 'APPROVAL NEEDED' | 'RUNNING' | 'NO RESULT';

/** Max characters of result text returned per call (the rest is paged with nextOffset). */
export const RESULT_SLICE_CHARS = 12_000;

export interface ResultRunFacts {
  status: string;
  reviewOutcome: string | null;
  resultChars: number;
  pendingApprovals: number;
}

export function resultLabel(r: ResultRunFacts | null): ResultLabel {
  if (!r) return 'NO RESULT';
  if (r.status === 'running') return 'RUNNING';
  if (r.status === 'failed') return 'FAILED';
  if (r.status !== 'completed') return 'NO RESULT';
  if (r.pendingApprovals > 0) return 'APPROVAL NEEDED';
  if (r.resultChars === 0) return 'NO RESULT';
  if (r.reviewOutcome === 'required_unmet') return 'UNREVIEWED DRAFT';
  return 'FINAL';
}

/** One sentence the model must keep with the content when it shows or summarizes it. */
export function labelGuidance(label: ResultLabel): string {
  switch (label) {
    case 'FINAL':
      return 'FINAL — completed and reviewed (or review was not required). You may present it as the result.';
    case 'UNREVIEWED DRAFT':
      return 'UNREVIEWED DRAFT — review was required but did not happen. Say so every time you show or summarize it; never call it final.';
    case 'APPROVAL NEEDED':
      return 'APPROVAL NEEDED — the run finished but proposed actions that are still waiting on the owner; the work is not done until those are decided.';
    case 'FAILED':
      return 'FAILED — the run produced no result. Give the stored reason; do not invent an outcome.';
    case 'RUNNING':
      return 'RUNNING — not finished yet; there is no result to show.';
    case 'NO RESULT':
      return 'NO RESULT — there is no result text on record. Do not invent one.';
  }
}

/** A bounded slice of the result starting at `offset` (clamped), with the offset to continue from (null at the end). */
export function sliceResult(text: string, offset: number, max = RESULT_SLICE_CHARS): { text: string; offset: number; nextOffset: number | null; total: number } {
  const total = text.length;
  const start = Math.max(0, Math.min(Number.isFinite(offset) ? Math.floor(offset) : 0, total));
  const end = Math.min(total, start + max);
  return { text: text.slice(start, end), offset: start, nextOffset: end < total ? end : null, total };
}

export interface TaskResultRun {
  id: string;
  status: string;
  reviewOutcome: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  errorMessage: string | null;
  result: string | null;
  pendingApprovals: number;
}

/**
 * The run to read: `runId` when given (it MUST belong to `taskId`), else the task's latest run. Also reports the
 * latest COMPLETED run when the selected one is not completed, so Ops Chat can offer the last real result.
 */
export async function loadTaskResultRun(
  tx: DbTx,
  taskId: string,
  runId: string | null,
): Promise<{ run: TaskResultRun | null; lastCompletedRunId: string | null }> {
  const cols = {
    id: runs.id,
    status: runs.status,
    reviewOutcome: runs.reviewOutcome,
    startedAt: runs.startedAt,
    finishedAt: runs.finishedAt,
    errorMessage: runs.errorMessage,
    result: runs.consolidatedResult,
  };
  const where = runId ? and(eq(runs.taskId, taskId), eq(runs.id, runId)) : eq(runs.taskId, taskId);
  const row = (await tx.select(cols).from(runs).where(where).orderBy(desc(runs.startedAt), desc(runs.id)).limit(1))[0] ?? null;
  if (!row) return { run: null, lastCompletedRunId: null };
  const pending = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(approvals)
    .where(and(eq(approvals.runId, row.id), eq(approvals.status, 'pending')));
  const run: TaskResultRun = { ...row, pendingApprovals: Number(pending[0]?.n ?? 0) };
  let lastCompletedRunId: string | null = null;
  if (row.status !== 'completed') {
    const done = await tx
      .select({ id: runs.id })
      .from(runs)
      .where(and(eq(runs.taskId, taskId), eq(runs.status, 'completed')))
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .limit(1);
    lastCompletedRunId = done[0]?.id ?? null;
  }
  return { run, lastCompletedRunId };
}
