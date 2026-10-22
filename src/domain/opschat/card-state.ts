/**
 * Authoritative card-state lines for Ops Chat prompt history.
 *
 * Evidence (server-cooling conversation, Hub prod 2026-10-19): at 22:36 Ops Chat told the owner "once you
 * confirm those two cards …" — both cards (reject edb61199, rerun 0a72c3bc) had been CONFIRMED at 17:19. The
 * model only ever saw its own earlier "here is the card" TEXT, never what happened to the card, so stale chat
 * text overrode stored state. Every completed assistant reply in the prompt history now ends with server-built
 * lines stating each of its cards' CURRENT stored state (written from the database, never from model output).
 *
 * Pure (no DB) so the exact wording is unit-testable; conversations.ts feeds it the stored rows.
 */

import { linkedRunLine, type LinkedRunView } from '@/domain/opschat/linked-run-view';

export interface StoredCard {
  /** The card's id — shown (short) so it can be matched to a task's createdByCard / latestRunCard. */
  id?: string;
  kind: string;
  state: string;
  proposal: Record<string, unknown>;
  result: unknown;
  error: string | null;
  updatedAt: Date;
  /** P5a: the run this card started, read from the P4 link (runs/run_jobs.ops_chat_proposal_id). */
  linkedRun?: LinkedRunView | null;
}

const STATE_TEXT: Record<string, string> = {
  pending: 'NOT confirmed — still waiting for the owner',
  confirming: 'being confirmed right now',
  done: 'CONFIRMED by the owner', // refined per card by doneText()
  cancelled: 'CANCELLED by the owner — nothing was done',
  stale: 'STALE — not executed',
  error: 'FAILED when confirmed',
};

/** Task titles get more room than other fields — a dispatch title like "… — updated with your answers" runs ~100 chars. */
const TITLE_MAX = 140;

function str(v: unknown, max = 90): string | null {
  return typeof v === 'string' && v.trim() ? clipLabel(v.trim(), max) : null;
}

/**
 * A label that fits `max` characters, cut back to a word boundary with an ellipsis when it is longer (Hub prod
 * 2026-10-22: a hard cut showed "…updated with you" for "…updated with your answers"). Identifiers are passed with
 * their exact length as `max`, so they are never clipped.
 */
export function clipLabel(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max - 1);
  const cut = head.lastIndexOf(' ');
  return `${(cut > max * 0.5 ? head.slice(0, cut) : head).replace(/[\s,;:—–-]+$/, '')}…`;
}

function cardLabel(c: StoredCard): string {
  return cardLabelOf(c.kind, c.proposal);
}

/** A short human label for a card (shared by prompt history and the transcript's completed-since block). */
export function cardLabelOf(kind: string, proposal: Record<string, unknown>): string {
  const p = proposal;
  switch (kind) {
    case 'decide_approval':
      return `${str(p.decision) ?? 'decide'} approval ${str(p.approvalId, 36) ?? ''}`.trim();
    case 'rerun_task':
      return `re-run "${str(p.taskTitle, TITLE_MAX) ?? str(p.taskId, 36) ?? 'task'}"`;
    case 'dispatch_task':
      return `dispatch "${str(p.title, TITLE_MAX) ?? 'task'}"${str(p.agentName) ? ` to ${str(p.agentName)}` : ''}`;
    case 'answer_question':
      return `answer question ${str(p.questionId, 36) ?? ''}`.trim();
    case 'record_decision':
      return `record decision "${str(p.title, TITLE_MAX) ?? 'decision'}" on "${str(p.taskTitle, TITLE_MAX) ?? 'task'}"`;
    case 'accept_decisions':
      return Array.isArray(p.decisions) ? `accept ${p.decisions.length} extracted decision(s)` : 'accept extracted decisions';
    default:
      return str(p.title) ?? str(p.summary) ?? kind;
  }
}

function resultIds(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const r = result as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of ['taskId', 'jobId', 'approvalId', 'outcome'] as const) {
    const v = str(r[k], 40);
    if (v) parts.push(`${k} ${v}`);
  }
  return parts.length ? ` (${parts.join(', ')})` : '';
}

/**
 * What a CONFIRMED card may claim. "Executed" only when the stored result proves it (an `outcome`, a `jobId`,
 * or — for a dispatch — the created `taskId`). Evidence (v89 acceptance, 2026-10-20): the 17:19 re-run card
 * (7cc10bc8) is `done` with a NULL result — before #168 a re-run of a completed task queued a job that drained
 * with no run — yet the line said "CONFIRMED … and executed", and Ops Chat told the owner that re-run "is the
 * same completed-but-unreviewed run". A confirmed card without an execution record now says exactly that, and
 * points at the task's current state instead.
 */
function doneText(c: StoredCard): string {
  // P5a: a linked attempt IS the execution record — the run line appended below says what actually happened.
  if (c.linkedRun) return 'CONFIRMED by the owner and executed';
  const r = c.result && typeof c.result === 'object' ? (c.result as Record<string, unknown>) : {};
  if (c.kind === 'decide_approval') {
    const decision = str(c.proposal.decision);
    if (decision === 'rejected') return 'CONFIRMED by the owner — rejection recorded';
    if (!str(r.outcome)) return 'CONFIRMED by the owner — approval recorded; no execution record';
    return 'CONFIRMED by the owner and executed';
  }
  if (c.kind === 'answer_question') return 'CONFIRMED by the owner — answer recorded';
  if (c.kind === 'record_decision' || c.kind === 'accept_decisions') {
    // Recorded as accepted guidance on the job's task: later runs of that task and its update card carry it.
    return Array.isArray(r.decisionIds) && r.decisionIds.length > 0
      ? 'CONFIRMED by the owner — decision recorded (later runs of the task and its update card carry it)'
      : 'CONFIRMED by the owner — no record of what was saved';
  }
  const executed = Boolean(str(r.outcome) || str(r.jobId) || (c.kind === 'dispatch_task' && str(r.taskId)));
  return executed
    ? 'CONFIRMED by the owner and executed'
    : "CONFIRMED by the owner — no execution record (it did not record what it did; read the task's current state, do not assume it ran)";
}

/** The lines appended to one assistant reply, or '' when it had no cards. */
export function cardStateLines(cards: readonly StoredCard[]): string {
  if (cards.length === 0) return '';
  const lines = cards.map((c) => {
    const when = c.updatedAt.toISOString().slice(0, 16).replace('T', ' ');
    const state = c.state === 'done' ? doneText(c) : (STATE_TEXT[c.state] ?? c.state);
    const err = c.error && (c.state === 'stale' || c.state === 'error') ? `: ${c.error.slice(0, 160)}` : '';
    const run = c.state === 'done' && c.linkedRun ? ` — ${linkedRunLine(c.linkedRun)}` : '';
    return `- [card ${c.kind}${c.id ? ` ${c.id.slice(0, 8)}` : ''}] ${cardLabel(c)} — ${state}${err} — as of ${when} UTC${resultIds(c.result)}${run}`;
  });
  return `\n\n[SERVER RECORD — current state of the cards in this reply; authoritative over anything said above]\n${lines.join('\n')}`;
}
