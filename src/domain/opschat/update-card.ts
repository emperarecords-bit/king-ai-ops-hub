import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
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
  at: Date;
  /** Question: the question; rejection: the approval summary. */
  subject: string;
  /** Question: the owner's answer; rejection: the owner's note (may be null). */
  detail: string | null;
}

export interface UpdateBasis {
  task: { id: string; title: string; input: string; primaryAgentId: string | null };
  run: { id: string; status: string; startedAt: Date | null; finishedAt: Date | null };
  decisions: UpdateDecision[];
}

/**
 * Stored facts for an update card: the task, its latest run, and the owner decisions made after that run started.
 * Null when the task is missing or has no run (nothing to update — dispatch or re-run instead). Tenant tx (RLS).
 */
export async function loadUpdateBasis(tx: DbTx, taskId: string): Promise<UpdateBasis | null> {
  const task = (
    await tx.select({ id: tasks.id, title: tasks.title, input: tasks.input, primaryAgentId: tasks.assignedPrimaryAgentId }).from(tasks).where(eq(tasks.id, taskId)).limit(1)
  )[0];
  if (!task) return null;
  const run = (
    await tx
      .select({ id: runs.id, status: runs.status, startedAt: runs.startedAt, finishedAt: runs.finishedAt })
      .from(runs)
      .where(eq(runs.taskId, taskId))
      .orderBy(desc(runs.startedAt), desc(runs.id))
      .limit(1)
  )[0];
  if (!run) return null;
  const answered = await tx
    .select({ id: ownerQuestions.id, question: ownerQuestions.question, answer: ownerQuestions.answer, at: ownerQuestions.answeredAt })
    .from(ownerQuestions)
    .where(and(eq(ownerQuestions.taskId, taskId), eq(ownerQuestions.status, 'answered'), isNotNull(ownerQuestions.answeredAt)));
  const rejected = await tx
    .select({ id: approvals.id, summary: approvals.summary, note: approvals.decisionNote, at: approvals.decidedAt })
    .from(approvals)
    .where(and(eq(approvals.taskId, taskId), eq(approvals.status, 'rejected'), isNotNull(approvals.decidedAt)));
  const all: UpdateDecision[] = [
    ...answered.map((q) => ({ kind: 'question_answered' as const, id: q.id, at: q.at!, subject: q.question, detail: q.answer })),
    ...rejected.map((a) => ({ kind: 'approval_rejected' as const, id: a.id, at: a.at!, subject: a.summary, detail: a.note })),
  ];
  const keep = new Set(decisionsAfterRun(run.startedAt, all.map((d) => ({ kind: d.kind, id: d.id, at: d.at, summary: d.subject }))).map((d) => d.id));
  return {
    task: { id: task.id, title: task.title, input: task.input, primaryAgentId: task.primaryAgentId ?? null },
    run,
    decisions: all.filter((d) => keep.has(d.id)).sort((a, b) => a.at.getTime() - b.at.getTime()),
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
}

export const UPDATE_CARD_NOT_CURRENT =
  'This update card is no longer current because the job changed after the card was prepared. Ask Ops Chat for a fresh update card. Nothing was started.';

/**
 * CONFIRM-TIME freshness (review of #175): an update card freezes the original task's state when it is prepared; if the
 * job changed before the owner confirms, starting it would run stale frozen instructions — the very drift P5c-2 fixes.
 * Confirm only when, re-read NOW in the confirming transaction:
 *   - the original task still exists and still has its latest run = the card's run (no re-run since);
 *   - its post-run decisions are EXACTLY the card's (no answer/rejection added since; none disappeared);
 *   - no other update task has already superseded it.
 * Serialized per original task with a transaction-scoped advisory lock, so two update cards confirmed at the same
 * moment cannot both pass. Throws AppError('conflict') → the card becomes `stale` with the plain reason; nothing starts.
 */
export async function assertUpdateCardCurrent(tx: DbTx, ctx: TenantContext, u: UpdateOf): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`ops_chat_update_card:${u.taskId}`}))`);
  const fail = (why: string): never => {
    throw new AppError('conflict', `${UPDATE_CARD_NOT_CURRENT} (${why})`);
  };
  const basis = await loadUpdateBasis(tx, u.taskId);
  if (!basis) fail('the original task or its run is no longer available');
  if (basis!.run.id !== u.runId) fail('the original task was run again after the card was prepared');
  const now = basis!.decisions.map((d) => d.id).sort();
  const frozen = u.decisionIds ? [...u.decisionIds].sort() : null;
  const same = frozen ? frozen.length === now.length && frozen.every((id, i) => id === now[i]) : now.length === u.decisions;
  if (!same) fail('the owner made decisions after the card was prepared');
  const st = (await loadTaskStates(tx, ctx, [u.taskId]))[0];
  if (st?.supersededBy) fail(`it was already updated by task "${st.supersededBy.title}"`);
}

const iso = (d: Date | null) => (d ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : 'unknown time');
/** Each decision's text is capped so the decisions can never crowd out the limit; the rest stays readable in the Hub. */
const MAX_DECISION_TEXT = 1_200;
/** At most this many decisions go on one card (oldest first); more are counted, never silently dropped. */
export const MAX_UPDATE_DECISIONS = 10;
const oneLine = (s: string, max = MAX_DECISION_TEXT) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)} […]` : t;
};

export function updateTitle(taskTitle: string): string {
  const suffix = ' — updated with your answers';
  return (taskTitle.slice(0, MAX_TITLE - suffix.length) + suffix).slice(0, MAX_TITLE);
}

/**
 * The new task's instructions: the original instructions, then every owner decision made after the latest run started
 * (oldest first), then what to do with them. Bounded to the dispatch limit: at most MAX_UPDATE_DECISIONS decisions, each
 * question/answer capped at MAX_DECISION_TEXT, keep the decisions block under ~26k chars, so the decisions always fit
 * whole and it is the ORIGINAL instructions that are truncated (with a marker) when room runs out.
 */
export function buildUpdateInstructions(b: UpdateBasis): string {
  const lines: string[] = [];
  for (const d of b.decisions.slice(0, MAX_UPDATE_DECISIONS)) {
    if (d.kind === 'question_answered') {
      lines.push(`- Question (answered ${iso(d.at)}): ${oneLine(d.subject)}\n  Owner's answer: ${oneLine(d.detail ?? '(no text)')}`);
    } else {
      lines.push(`- REJECTED (${iso(d.at)}): ${oneLine(d.subject)}${d.detail ? `\n  Owner's note: ${oneLine(d.detail)}` : ''}`);
    }
  }
  if (b.decisions.length > MAX_UPDATE_DECISIONS) {
    lines.push(`- … and ${b.decisions.length - MAX_UPDATE_DECISIONS} more decisions recorded in the Hub (Inbox and approvals history).`);
  }
  const decisionsBlock =
    `\n\n=== OWNER DECISIONS SINCE THE PREVIOUS RUN (authoritative — recorded in the Hub) ===\n${lines.join('\n')}\n\n` +
    `=== WHAT TO DO ===\nThe previous run of "${oneLine(b.task.title)}" (run ${b.run.id}, started ${iso(b.run.startedAt)}) predates the decisions above. ` +
    'Produce an updated, complete result that applies every one of them. Do not re-ask questions that are answered above; ' +
    'do not repeat a proposal the owner rejected.';
  const head = `=== ORIGINAL INSTRUCTIONS ===\n`;
  const room = MAX_DISPATCH_INSTRUCTIONS - head.length - decisionsBlock.length;
  const marker = '\n[… original instructions truncated to fit — the decisions below take precedence …]';
  const original = b.task.input.length <= room ? b.task.input : b.task.input.slice(0, Math.max(0, room - marker.length)) + marker;
  return (head + original + decisionsBlock).slice(0, MAX_DISPATCH_INSTRUCTIONS);
}
