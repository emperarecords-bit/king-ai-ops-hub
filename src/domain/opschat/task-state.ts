import { and, desc, eq, inArray } from 'drizzle-orm';
import { type DbTx } from '@/db/client';
import { approvals, opsChatProposals, runJobs, runs, tasks } from '@/db/schema';
import { type TenantContext } from '@/types/domain';

/**
 * Authoritative task state for Ops Chat — task + latest job + latest run + this task's approvals, read NOW.
 *
 * Evidence (server-cooling conversation, Hub prod 2026-10-19 16:10): Ops Chat told the owner the duct task
 * "is sitting in 'awaiting approval' — it hasn't been confirmed/run yet, so no calculations exist". In fact its
 * dispatch card was confirmed at 14:50:03 and its run COMPLETED at 14:50:11 with a 3,948-char result; the task
 * was `awaiting_approval` only because that run had proposed an (unrelated) approval. `list_tasks` returned only
 * `tasks.status`, so the model guessed what "awaiting approval" meant. Every task Ops Chat reports on now carries
 * the stored facts and one plain owner-facing sentence derived ONLY from them.
 */

/** P4 provenance: an Ops Chat card, as far as the stored link shows it. */
export interface CardRef {
  proposalId: string;
  kind: string | null;
  createdAt: Date | null;
}

export interface TaskStateInput {
  taskId: string;
  title: string;
  status: string;
  /** The card that CREATED the task (tasks.ops_chat_proposal_id), or null. */
  createdByCard?: CardRef | null;
  /** The card whose job produced the latest run (runs.ops_chat_proposal_id), or null. */
  latestRunCard?: CardRef | null;
  job: { status: string; createdAt: Date; updatedAt: Date } | null;
  run: { id: string; status: string; reviewOutcome: string | null; startedAt: Date | null; finishedAt: Date | null; resultChars: number } | null;
  pendingApprovals: { id: string; summary: string; actionType: string; createdAt: Date }[];
}

export interface TaskState {
  taskId: string;
  title: string;
  status: string;
  job: { status: string; updatedAt: string } | null;
  latestRun: { id: string; status: string; reviewOutcome: string | null; finishedAt: string | null; hasResult: boolean } | null;
  pendingApprovals: { id: string; summary: string; actionType: string }[];
  createdByCard: { proposalId: string; kind: string | null; createdAt: string | null } | null;
  latestRunCard: { proposalId: string; kind: string | null; createdAt: string | null } | null;
  /** One sentence, built only from the stored facts above. Say THIS — not a guess from chat history. */
  ownerFacing: string;
}

const cardOut = (c: CardRef | null | undefined) =>
  c ? { proposalId: c.proposalId, kind: c.kind, createdAt: c.createdAt?.toISOString() ?? null } : null;
const short = (id: string) => id.slice(0, 8);

/** Which card produced what — only from the stored links; never inferred. */
function provenanceSentence(s: TaskStateInput): string {
  const created = s.createdByCard ?? null;
  const fromRun = s.latestRunCard ?? null;
  const parts: string[] = [];
  if (created) parts.push(`Created by Ops Chat card ${short(created.proposalId)}${created.createdAt ? ` (${t(created.createdAt)})` : ''}.`);
  if (s.run) {
    if (fromRun && created && fromRun.proposalId === created.proposalId) parts.push('Its latest result is from that original card.');
    else if (fromRun) parts.push(`Its latest result came from ${fromRun.kind === 'rerun_task' ? 're-run ' : ''}card ${short(fromRun.proposalId)}${fromRun.createdAt ? ` (${t(fromRun.createdAt)})` : ''}.`);
    else if (created) parts.push('Its latest run has no card on record (it predates card tracking, or was not started from Ops Chat).');
  }
  return parts.length ? ` ${parts.join(' ')}` : '';
}

const t = (d: Date | null | undefined): string | null => (d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : null);

export function describeTaskState(s: TaskStateInput): TaskState {
  const run = s.run;
  const unreviewed = run?.reviewOutcome === 'required_unmet';
  const finished = run && (run.status === 'completed' || run.status === 'awaiting_approval') ? t(run.finishedAt) : null;
  let ownerFacing: string;
  switch (s.status) {
    case 'awaiting_approval': {
      const a = s.pendingApprovals[0];
      ownerFacing =
        `It already RAN${finished ? ` (finished ${finished})` : ''}${run && run.resultChars > 0 ? ' and its result is ready to read' : ''}. ` +
        (a
          ? `It is waiting on the owner's decision on approval "${a.summary}" (${a.id}) that the run proposed — this is NOT an unconfirmed card.`
          : 'It is waiting on an approval decision that the run proposed — this is NOT an unconfirmed card.');
      break;
    }
    case 'completed':
      ownerFacing = `Completed${finished ? ` ${finished}` : ''}${run && run.resultChars > 0 ? '; result available' : ''}.`;
      if (unreviewed) ownerFacing += ' It is an UNREVIEWED DRAFT: review was required but no reviewer completed it — not final.';
      break;
    case 'running':
      ownerFacing = `Running now${run?.startedAt ? ` (started ${t(run.startedAt)})` : ''}.`;
      break;
    case 'pending':
      ownerFacing =
        s.job && (s.job.status === 'queued' || s.job.status === 'running')
          ? `Queued, not started yet (job ${s.job.status} since ${t(s.job.createdAt)}).`
          : 'Pending with NO job queued — it will not start on its own; it needs a re-run or dispatch.';
      break;
    case 'failed':
      ownerFacing = `Failed${finished ? ` ${finished}` : run?.finishedAt ? ` ${t(run.finishedAt)}` : ''}.`;
      break;
    case 'cancelled':
      ownerFacing = 'Cancelled.';
      break;
    default:
      ownerFacing = `Status: ${s.status}.`;
  }
  return {
    taskId: s.taskId,
    title: s.title,
    status: s.status,
    job: s.job ? { status: s.job.status, updatedAt: s.job.updatedAt.toISOString() } : null,
    latestRun: run
      ? { id: run.id, status: run.status, reviewOutcome: run.reviewOutcome, finishedAt: run.finishedAt?.toISOString() ?? null, hasResult: run.resultChars > 0 }
      : null,
    pendingApprovals: s.pendingApprovals.map((a) => ({ id: a.id, summary: a.summary, actionType: a.actionType })),
    createdByCard: cardOut(s.createdByCard),
    latestRunCard: cardOut(s.latestRunCard),
    ownerFacing: ownerFacing + provenanceSentence(s),
  };
}

/** Load the authoritative state for these tasks (tenant-scoped, read-only). Missing ids are skipped. */
export async function loadTaskStates(tx: DbTx, ctx: TenantContext, taskIds: readonly string[]): Promise<TaskState[]> {
  if (taskIds.length === 0) return [];
  const ids = [...new Set(taskIds)];
  const scope = (col: typeof tasks.projectId | typeof runs.projectId | typeof runJobs.projectId | typeof approvals.projectId) =>
    eq(col, ctx.projectId);
  const [taskRows, jobRows, runRows, apprRows] = await Promise.all([
    tx
      .select({ id: tasks.id, title: tasks.title, status: tasks.status, opsChatProposalId: tasks.opsChatProposalId })
      .from(tasks)
      .where(and(inArray(tasks.id, ids), scope(tasks.projectId))),
    tx
      .select({ taskId: runJobs.taskId, status: runJobs.status, createdAt: runJobs.createdAt, updatedAt: runJobs.updatedAt })
      .from(runJobs)
      .where(and(inArray(runJobs.taskId, ids), scope(runJobs.projectId)))
      .orderBy(desc(runJobs.createdAt)),
    tx
      .select({
        id: runs.id,
        taskId: runs.taskId,
        status: runs.status,
        reviewOutcome: runs.reviewOutcome,
        startedAt: runs.startedAt,
        finishedAt: runs.finishedAt,
        result: runs.consolidatedResult,
        opsChatProposalId: runs.opsChatProposalId,
      })
      .from(runs)
      .where(and(inArray(runs.taskId, ids), scope(runs.projectId)))
      .orderBy(desc(runs.createdAt)),
    tx
      .select({ id: approvals.id, taskId: approvals.taskId, summary: approvals.summary, actionType: approvals.actionType, createdAt: approvals.createdAt })
      .from(approvals)
      .where(and(inArray(approvals.taskId, ids), scope(approvals.projectId), eq(approvals.status, 'pending')))
      .orderBy(desc(approvals.createdAt)),
  ]);
  const firstBy = <T extends { taskId: string | null }>(rows: T[]) => {
    const m = new Map<string, T>();
    for (const r of rows) if (r.taskId && !m.has(r.taskId)) m.set(r.taskId, r);
    return m;
  };
  const job = firstBy(jobRows);
  const run = firstBy(runRows);
  // The cards themselves (owner-private rows; visible to this owner only — an id the owner can't see stays bare).
  const cardIds = [
    ...new Set([...taskRows.map((x) => x.opsChatProposalId), ...[...run.values()].map((x) => x.opsChatProposalId)].filter((x): x is string => !!x)),
  ];
  const cardRows = cardIds.length
    ? await tx
        .select({ id: opsChatProposals.id, kind: opsChatProposals.kind, createdAt: opsChatProposals.createdAt })
        .from(opsChatProposals)
        .where(inArray(opsChatProposals.id, cardIds))
    : [];
  const cardById = new Map(cardRows.map((c) => [c.id, c]));
  const ref = (id: string | null): CardRef | null =>
    id ? { proposalId: id, kind: cardById.get(id)?.kind ?? null, createdAt: cardById.get(id)?.createdAt ?? null } : null;
  return taskRows.map((tk) => {
    const r = run.get(tk.id);
    const j = job.get(tk.id);
    return describeTaskState({
      taskId: tk.id,
      title: tk.title,
      status: tk.status,
      createdByCard: ref(tk.opsChatProposalId),
      latestRunCard: ref(r?.opsChatProposalId ?? null),
      job: j ? { status: j.status, createdAt: j.createdAt, updatedAt: j.updatedAt } : null,
      run: r
        ? { id: r.id, status: r.status, reviewOutcome: r.reviewOutcome ?? null, startedAt: r.startedAt, finishedAt: r.finishedAt, resultChars: (r.result ?? '').length }
        : null,
      pendingApprovals: apprRows.filter((a) => a.taskId === tk.id).map((a) => ({ id: a.id, summary: a.summary, actionType: a.actionType, createdAt: a.createdAt })),
    });
  });
}
