import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { type DbTx } from '@/db/client';
import { approvals, decisions as decisionRows, opsChatProposals, ownerQuestions, runJobs, runs, tasks } from '@/db/schema';
import { type TenantContext } from '@/types/domain';
import { PREPARE_UPDATE_CARD } from '@/domain/opschat/stale-wording';

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

/**
 * P5c-2 — an owner decision the task's latest run could not have known about. Counted: an owner question about this
 * task ANSWERED, or an approval for it REJECTED, after that run STARTED (anything decided once the run was under way
 * was not in its context). Approving an action the run itself proposed does not change its analysis, so approvals
 * are not counted. Also counted: a decision the owner RECORDED for this task (accepted, task-scoped guidance —
 * see recordedJobDecisions), at the time it was accepted.
 */
export interface OwnerDecision {
  kind: 'question_answered' | 'approval_rejected' | 'decision_recorded';
  id: string;
  at: Date;
  /** The question text, or the approval summary (short; the full text is read by propose_update_task). */
  summary: string;
}

/** Decisions made after `runStartedAt`, oldest first. No run → nothing to be stale against. */
export function decisionsAfterRun(runStartedAt: Date | null | undefined, decisions: readonly OwnerDecision[]): OwnerDecision[] {
  if (!runStartedAt) return [];
  return decisions.filter((d) => d.at.getTime() > runStartedAt.getTime()).sort((a, b) => a.at.getTime() - b.at.getTime());
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
  /** Owner decisions for this task (any time); describeTaskState keeps those after the latest run started. */
  decisions?: readonly OwnerDecision[];
  /** P5c-2: the newest task created from a confirmed update card for THIS task (its card's updateOf.taskId). */
  supersededBy?: { taskId: string; title: string; createdAt: Date } | null;
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
  /** P5c-2: the latest run predates these owner decisions — its result does not reflect them. Null when current. */
  stale: { runId: string; runStartedAt: string | null; decisions: { kind: OwnerDecision['kind']; id: string; at: string; summary: string }[] } | null;
  /** P5c-2: an update task already carries the owner's decisions — report THAT task, not this one. */
  supersededBy: { taskId: string; title: string; createdAt: string } | null;
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
  const after = run ? decisionsAfterRun(run.startedAt, s.decisions ?? []) : [];
  // An update task created AFTER this task's latest run started and after the newest of those decisions already carries
  // all of them: this task is superseded, not stale (otherwise Ops Chat would keep offering update cards for work
  // already updated). A re-run of this task after the update task was created makes this task current again.
  const sup = s.supersededBy ?? null;
  const covered =
    !!sup &&
    (!run?.startedAt || sup.createdAt.getTime() > run.startedAt.getTime()) &&
    after.every((d) => d.at.getTime() <= sup.createdAt.getTime());
  if (sup && covered) {
    ownerFacing += ` It has been SUPERSEDED by update task "${sup.title}" (${sup.taskId}, created ${t(sup.createdAt)}) which carries the owner's later decisions — report on that task instead.`;
  }
  const stale =
    run && after.length > 0 && !covered
      ? {
          runId: run.id,
          runStartedAt: run.startedAt?.toISOString() ?? null,
          decisions: after.map((d) => ({ kind: d.kind, id: d.id, at: d.at.toISOString(), summary: d.summary.replace(/\s+/g, ' ').slice(0, 160) })),
        }
      : null;
  if (stale) {
    const q = after.filter((d) => d.kind === 'question_answered').length;
    const r = after.filter((d) => d.kind === 'approval_rejected').length;
    const c = after.filter((d) => d.kind === 'decision_recorded').length;
    const what = [
      q ? `${q} answered question${q === 1 ? '' : 's'}` : '',
      r ? `${r} rejected approval${r === 1 ? '' : 's'}` : '',
      c ? `${c} recorded decision${c === 1 ? '' : 's'}` : '',
    ]
      .filter(Boolean)
      .join(' and ');
    ownerFacing +=
      ` Its latest run (started ${t(run!.startedAt)}) PREDATES ${after.length} owner decision${after.length === 1 ? '' : 's'} made since (${what}) — its result does not reflect them. ` +
      `Do not report the old result as current: ${PREPARE_UPDATE_CARD}`;
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
    stale,
    supersededBy: sup && covered ? { taskId: sup.taskId, title: sup.title, createdAt: sup.createdAt.toISOString() } : null,
    ownerFacing: ownerFacing + provenanceSentence(s),
  };
}

/** Load the authoritative state for these tasks (tenant-scoped, read-only). Missing ids are skipped. */
export async function loadTaskStates(tx: DbTx, ctx: TenantContext, taskIds: readonly string[]): Promise<TaskState[]> {
  if (taskIds.length === 0) return [];
  const ids = [...new Set(taskIds)];
  const scope = (col: typeof tasks.projectId | typeof runs.projectId | typeof runJobs.projectId | typeof approvals.projectId) =>
    eq(col, ctx.projectId);
  const [taskRows, jobRows, runRows, apprRows, answeredRows, rejectedRows, recordedRows] = await Promise.all([
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
    // P5c-2: owner decisions about these tasks (staleness is decided per task against its latest run's start).
    tx
      .select({ id: ownerQuestions.id, taskId: ownerQuestions.taskId, question: ownerQuestions.question, at: ownerQuestions.answeredAt })
      .from(ownerQuestions)
      .where(and(inArray(ownerQuestions.taskId, ids), eq(ownerQuestions.projectId, ctx.projectId), eq(ownerQuestions.status, 'answered'), isNotNull(ownerQuestions.answeredAt))),
    tx
      .select({ id: approvals.id, taskId: approvals.taskId, summary: approvals.summary, at: approvals.decidedAt })
      .from(approvals)
      .where(and(inArray(approvals.taskId, ids), scope(approvals.projectId), eq(approvals.status, 'rejected'), isNotNull(approvals.decidedAt))),
    recordedJobDecisions(tx, ctx, ids),
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
  // P5c-2: tasks created from confirmed update cards for these tasks (the card's updateOf.taskId; P4 link on the
  // new task). Cards are owner-private, so this resolves for the owner who confirmed them.
  // P5c-2b: an update card covers EVERY task of its job (updateOf.taskIds; older cards: updateOf.taskId only).
  const superRows = await tx
    .select({ updateOf: sql<{ taskId?: string; taskIds?: string[] } | null>`${opsChatProposals.proposal} -> 'updateOf'`, taskId: tasks.id, title: tasks.title, createdAt: tasks.createdAt })
    .from(tasks)
    .innerJoin(opsChatProposals, eq(opsChatProposals.id, tasks.opsChatProposalId))
    .where(and(eq(tasks.projectId, ctx.projectId), sql`${opsChatProposals.proposal} -> 'updateOf' is not null`))
    .orderBy(desc(tasks.createdAt));
  const wanted = new Set(ids);
  const supersededBy = new Map<string, { taskId: string; title: string; createdAt: Date }>();
  for (const r of superRows) {
    const covers = [...(Array.isArray(r.updateOf?.taskIds) ? r.updateOf!.taskIds : []), ...(r.updateOf?.taskId ? [r.updateOf.taskId] : [])];
    for (const id of covers) if (wanted.has(id) && !supersededBy.has(id)) supersededBy.set(id, { taskId: r.taskId, title: r.title, createdAt: r.createdAt });
  }
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
      supersededBy: supersededBy.get(tk.id) ?? null,
      decisions: [
        ...answeredRows.filter((q) => q.taskId === tk.id && q.at).map((q) => ({ kind: 'question_answered' as const, id: q.id, at: q.at!, summary: q.question })),
        ...rejectedRows.filter((a) => a.taskId === tk.id && a.at).map((a) => ({ kind: 'approval_rejected' as const, id: a.id, at: a.at!, summary: a.summary })),
        ...recordedRows.filter((d) => d.taskId === tk.id).map((d) => ({ kind: 'decision_recorded' as const, id: d.id, at: d.at, summary: d.title })),
      ],
    });
  });
}

/**
 * Decisions the owner RECORDED for these tasks: accepted, task-scoped guidance (what propose_record_decision and
 * propose_accept_decisions write), timed by acceptance. Task-scoped guidance is injected only into runs of that
 * exact task, so an update task (a new task) would never see it — update cards carry these explicitly.
 *
 * Evidence (Hub prod, 2026-10-22): the owner stated the 20 kW load twice in chat and chose the shared duct, yet none
 * of it was recorded anywhere a run reads; the workspace held 72 run-extracted decisions, all still `proposed`.
 */
export async function recordedJobDecisions(
  tx: DbTx,
  ctx: Pick<TenantContext, 'projectId'>,
  taskIds: readonly string[],
): Promise<{ id: string; taskId: string; title: string; summary: string; at: Date }[]> {
  if (taskIds.length === 0) return [];
  const rows = await tx
    .select({ id: decisionRows.id, taskId: decisionRows.scopeTaskId, title: decisionRows.title, summary: decisionRows.summary, at: decisionRows.reviewedAt })
    .from(decisionRows)
    .where(
      and(
        eq(decisionRows.projectId, ctx.projectId),
        eq(decisionRows.status, 'accepted'),
        eq(decisionRows.applicability, 'guidance'),
        eq(decisionRows.scope, 'task'),
        inArray(decisionRows.scopeTaskId, [...taskIds]),
        isNotNull(decisionRows.reviewedAt),
      ),
    );
  return rows
    .filter((r): r is typeof r & { taskId: string; at: Date } => !!r.taskId && !!r.at)
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
}
