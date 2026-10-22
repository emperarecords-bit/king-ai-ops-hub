import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from 'drizzle-orm';
import { type DbTx } from '@/db/client';
import { approvals, ownerQuestions, runs, tasks } from '@/db/schema';
import { AppError } from '@/lib/errors';
import { type TenantContext } from '@/types/domain';
import { decisionsAfterRun, loadTaskStates } from '@/domain/opschat/task-state';

/**
 * P5c-2 — ONE consolidated "update this job" card when the owner's decisions changed after a task's latest run.
 *
 * Evidence (server-cooling conversation, Hub prod 2026-10-19/20): the duct task's run asked the owner four blocking
 * questions; the owner answered them, but the old result kept being reported as current and the owner had to keep
 * asking for progress and restart the work by hand. Answers are written to workspace knowledge, but nothing
 * guarantees a later run sees them — so the update card carries them EXPLICITLY in the new task's instructions.
 *
 * The card is an ordinary dispatch_task (same confirm path, same governance, gets P4 provenance → P5a/P5b-1 apply),
 * built server-side from stored rows only: the original instructions + every decision made after the latest run
 * started. Nothing here writes.
 */

/** The confirm path's dispatch limit. */
export const MAX_DISPATCH_INSTRUCTIONS = 32_000;
const MAX_TITLE = 200;

export interface UpdateDecision {
  kind: 'question_answered' | 'approval_rejected';
  id: string;
  /** The task (of the job) the decision was made on. */
  taskId: string;
  at: Date;
  /** Question: the question; rejection: the approval summary. */
  subject: string;
  /** Question: the owner's answer; rejection: the owner's note (may be null). */
  detail: string | null;
}

export interface UpdateBasis {
  /** The task the card was asked for (its title, instructions and agent are used). */
  task: { id: string; title: string; input: string; primaryAgentId: string | null };
  /** That task's latest run. */
  run: { id: string; status: string; startedAt: Date | null; finishedAt: Date | null };
  /**
   * P5c-2b: every task of the SAME JOB — same workspace, same normalized title (duplicate dispatches of one job, e.g.
   * the two "Server Cabinet Cooling — Dual FUSION-TEC Punch List …" tasks) — each with its latest run, oldest task
   * first. Includes the task above. A task with no run yet has nothing to be stale against and is left out.
   */
  siblings: { taskId: string; runId: string; startedAt: Date | null }[];
  /** Decisions made after the latest run of the task they belong to started — across ALL siblings, oldest first. */
  decisions: UpdateDecision[];
}

/** At most this many tasks are treated as one job (more → only the oldest MAX_SIBLINGS, the requested one always). */
export const MAX_SIBLINGS = 10;

/** One job = same workspace + same title, compared case- and whitespace-insensitively. */
export function normalizeJobTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().toLowerCase();
}

async function latestRun(tx: DbTx, taskId: string) {
  return (
    await tx
      .select({ id: runs.id, status: runs.status, startedAt: runs.startedAt, finishedAt: runs.finishedAt })
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .limit(1)
  )[0];
}

/**
 * Stored facts for an update card. Null when the task is missing or has no run (nothing to update — dispatch or
 * re-run instead). Tenant tx (RLS confines the sibling search to the task's own workspace).
 *
 * Evidence (Hub prod, 2026-10-21 read-only check): the owner's four server-cooling answers are SPLIT across two
 * duplicate tasks of one job — Lead-Lag on the 11:41 task; installer, fire suppression and fence noise on the 12:34
 * task. Collecting decisions per task would have produced a card that silently lacked part of the owner's answers.
 */
export async function loadUpdateBasis(tx: DbTx, taskId: string): Promise<UpdateBasis | null> {
  const task = (
    await tx
      .select({ id: tasks.id, title: tasks.title, input: tasks.input, primaryAgentId: tasks.assignedPrimaryAgentId, projectId: tasks.projectId })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1)
  )[0];
  if (!task) return null;
  const run = await latestRun(tx, taskId);
  if (!run) return null;

  const sameJob = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, task.projectId),
        ne(tasks.status, 'cancelled'),
        sql`lower(regexp_replace(btrim(${tasks.title}), '\\s+', ' ', 'g')) = ${normalizeJobTitle(task.title)}`,
      ),
    )
    .orderBy(asc(tasks.createdAt), asc(tasks.id))
    .limit(MAX_SIBLINGS);
  const ids = [...new Set([...sameJob.map((r) => r.id), taskId])];
  const siblings: UpdateBasis['siblings'] = [];
  for (const id of ids) {
    const r = id === taskId ? run : await latestRun(tx, id);
    if (r) siblings.push({ taskId: id, runId: r.id, startedAt: r.startedAt });
  }
  const startOf = new Map(siblings.map((s) => [s.taskId, s.startedAt]));
  const siblingIds = siblings.map((s) => s.taskId);

  const answered = await tx
    .select({ id: ownerQuestions.id, taskId: ownerQuestions.taskId, question: ownerQuestions.question, answer: ownerQuestions.answer, at: ownerQuestions.answeredAt })
    .from(ownerQuestions)
    .where(and(inArray(ownerQuestions.taskId, siblingIds), eq(ownerQuestions.status, 'answered'), isNotNull(ownerQuestions.answeredAt)));
  const rejected = await tx
    .select({ id: approvals.id, taskId: approvals.taskId, summary: approvals.summary, note: approvals.decisionNote, at: approvals.decidedAt })
    .from(approvals)
    .where(and(inArray(approvals.taskId, siblingIds), eq(approvals.status, 'rejected'), isNotNull(approvals.decidedAt)));
  const all: UpdateDecision[] = [
    ...answered.map((q) => ({ kind: 'question_answered' as const, id: q.id, taskId: q.taskId, at: q.at!, subject: q.question, detail: q.answer })),
    ...rejected.map((a) => ({ kind: 'approval_rejected' as const, id: a.id, taskId: a.taskId!, at: a.at!, subject: a.summary, detail: a.note })),
  ];
  // Each decision is judged against the latest run of ITS OWN task (what that run could have known).
  const keep = all.filter(
    (d) => decisionsAfterRun(startOf.get(d.taskId) ?? null, [{ kind: d.kind, id: d.id, at: d.at, summary: d.subject }]).length === 1,
  );
  return {
    task: { id: task.id, title: task.title, input: task.input, primaryAgentId: task.primaryAgentId ?? null },
    run,
    siblings,
    decisions: keep.sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id)),
  };
}

/** What an update card froze when it was prepared — re-checked at confirm (see assertUpdateCardCurrent). */
export interface UpdateOf {
  taskId: string;
  taskTitle: string;
  runId: string;
  decisions: number;
  /** The exact decisions written into the card's instructions. Absent only on cards prepared before this field. */
  decisionIds?: string[];
  /** P5c-2b: every task of the job (incl. taskId) — supersession and the pending-card check use it. */
  taskIds?: string[];
  /** P5c-2b: each task's latest run when the card was prepared — any re-run of ANY of them invalidates the card. */
  siblingRuns?: { taskId: string; runId: string }[];
}

export const UPDATE_CARD_NOT_CURRENT =
  'This update card is no longer current because the job changed after the card was prepared. Ask Ops Chat for a fresh update card. Nothing was started.';

/**
 * CONFIRM-TIME freshness (review of #175): an update card freezes the job's state when it is prepared; if the job
 * changed before the owner confirms, starting it would run stale frozen instructions — the very drift P5c-2 fixes.
 * Confirm only when, re-read NOW in the confirming transaction:
 *   - the task still exists, and EVERY task of the job still has exactly the latest run the card froze (no re-run of
 *     any of them; no duplicate added or removed);
 *   - the post-run decisions across the job are EXACTLY the card's (none added since; none disappeared);
 *   - no other update task has already superseded ANY task of the job.
 * Serialized per JOB (workspace + normalized title) with a transaction-scoped advisory lock, so two update cards for
 * the same job — even prepared from different duplicate tasks — cannot both pass. Throws AppError('conflict') → the
 * card becomes `stale` with the plain reason; nothing starts.
 */
export async function assertUpdateCardCurrent(tx: DbTx, ctx: TenantContext, u: UpdateOf): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ops_chat_update_job:${ctx.projectId}:${normalizeJobTitle(u.taskTitle)}`}))`);
  const fail = (why: string): never => {
    throw new AppError('conflict', `${UPDATE_CARD_NOT_CURRENT} (${why})`);
  };
  const basis = await loadUpdateBasis(tx, u.taskId);
  if (!basis) fail('the original task or its run is no longer available');
  if (basis!.run.id !== u.runId) fail('the original task was run again after the card was prepared');
  if (u.siblingRuns) {
    const key = (xs: readonly { taskId: string; runId: string }[]) => xs.map((x) => `${x.taskId}:${x.runId}`).sort().join(',');
    if (key(basis!.siblings) !== key(u.siblingRuns)) fail('another task of this job was run again (or added) after the card was prepared');
  }
  const now = basis!.decisions.map((d) => d.id).sort();
  const frozen = u.decisionIds ? [...u.decisionIds].sort() : null;
  const same = frozen ? frozen.length === now.length && frozen.every((id, i) => id === now[i]) : now.length === u.decisions;
  if (!same) fail('the owner made decisions after the card was prepared');
  const states = await loadTaskStates(tx, ctx, basis!.siblings.map((s) => s.taskId));
  const sup = states.find((st) => st.supersededBy)?.supersededBy;
  if (sup) fail(`it was already updated by task "${sup.title}"`);
}

const iso = (d: Date | null) => (d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown time');
/** At most this many decisions go on one card. More than this → no card (see buildUpdateInstructions). */
export const MAX_UPDATE_DECISIONS = 10;

/** Text kept VERBATIM: line breaks become indented continuation lines, nothing is shortened or reflowed. */
const verbatim = (s: string) => s.trim().replace(/\r\n?/g, '\n').replace(/\n/g, '\n    ');

export function updateTitle(taskTitle: string): string {
  const suffix = ' — updated with your answers';
  return (taskTitle.slice(0, MAX_TITLE - suffix.length) + suffix).slice(0, MAX_TITLE);
}

export type UpdateInstructionsResult =
  | { ok: true; instructions: string }
  | { ok: false; reason: 'too_many_decisions' | 'too_large'; message: string };

export const UPDATE_CARD_TOO_BIG =
  'This job has too many post-run owner decisions to fit safely into one update card without dropping content. Nothing was prepared. Narrow the update scope or create a fresh consolidated task.';

/**
 * The new task's instructions: the FULL original instructions, then EVERY owner decision made after the latest run
 * started (oldest first, each verbatim), then what to do with them.
 *
 * Invariant (review of #175): a card never represents a decision whose content is not in its instructions, and never
 * carries a partial copy of the job. So nothing is ever truncated or summarized: if there are more than
 * MAX_UPDATE_DECISIONS decisions, or the complete text does not fit the dispatch limit, NO card is prepared and the
 * caller gets a plain refusal instead.
 */
export function buildUpdateInstructions(b: UpdateBasis): UpdateInstructionsResult {
  if (b.decisions.length > MAX_UPDATE_DECISIONS) return { ok: false, reason: 'too_many_decisions', message: UPDATE_CARD_TOO_BIG };
  const lines: string[] = [];
  for (const d of b.decisions) {
    if (d.kind === 'question_answered') {
      lines.push(`- Question (answered ${iso(d.at)}): ${verbatim(d.subject)}\n  Owner's answer: ${verbatim(d.detail ?? '(no text)')}`);
    } else {
      lines.push(`- REJECTED (${iso(d.at)}): ${verbatim(d.subject)}${d.detail ? `\n  Owner's note: ${verbatim(d.detail)}` : ''}`);
    }
  }
  const title = b.task.title.replace(/\s+/g, ' ').trim();
  const others = b.siblings.filter((s) => s.taskId !== b.task.id);
  const consolidated =
    others.length > 0
      ? `This job was dispatched ${b.siblings.length} times under this title (tasks ${b.siblings.map((s) => s.taskId).join(', ')}); the decisions above were made on any of them and ALL apply. `
      : '';
  const text =
    `=== ORIGINAL INSTRUCTIONS ===\n${b.task.input}` +
    `\n\n=== OWNER DECISIONS SINCE THE PREVIOUS RUN (authoritative — recorded in the Hub) ===\n${lines.join('\n')}\n\n` +
    `=== WHAT TO DO ===\n${consolidated}The previous run of "${title}" (run ${b.run.id}, started ${iso(b.run.startedAt)}) predates the decisions above. ` +
    'Produce an updated, complete result that applies every one of them. Do not re-ask questions that are answered above; ' +
    'do not repeat a proposal the owner rejected.';
  if (text.length > MAX_DISPATCH_INSTRUCTIONS) return { ok: false, reason: 'too_large', message: UPDATE_CARD_TOO_BIG };
  return { ok: true, instructions: text };
}
