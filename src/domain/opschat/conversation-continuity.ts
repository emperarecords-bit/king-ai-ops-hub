import { type LinkedRunState, type LinkedRunView } from '@/domain/opschat/linked-run-view';
import { PREPARE_UPDATE_CARD } from '@/domain/opschat/stale-wording';

/**
 * P5c-3 — conversational continuity, from stored facts only (pure: no DB, no React — the browser imports the types).
 *
 * Evidence (server-cooling conversation, Hub prod 2026-10-19/20): King had to keep asking "any response?", "server
 * cooling?", "still waiting" — work started from a card never came back into the conversation by itself, and short
 * follow-ups were not tied to the job they obviously meant.
 *
 *  1. COMPLETION ENTRIES — one per confirmed dispatch / re-run / update card whose linked run (P4) has FINISHED,
 *     placed in the transcript at its finish time. Derived from the run rows on every load, so there is exactly one
 *     per run by construction: no model call, no governed action, nothing persisted, nothing to duplicate.
 *  2. ACTIVE JOB — the most recently active job started from this conversation, so short follow-ups resolve to it;
 *     two or more jobs still queued/running at once is genuine ambiguity → Ops Chat must ask which.
 *  3. PROMPT SECTION — "THIS CONVERSATION" server record: the active job (with stale/superseded state), the other jobs,
 *     and completions since the owner's previous message.
 */

export type CompletionLabel = 'FINAL' | 'UNREVIEWED DRAFT' | 'APPROVAL NEEDED' | 'FAILED';

export interface ContinuityCard {
  proposalId: string;
  kind: string;
  /** Short human label of the card (cardLabelOf). */
  label: string;
  projectKey: string | null;
  view: LinkedRunView | null;
  /** P5c-2 facts for the card's task, when read (active job only). */
  stale?: { decisions: number } | null;
  supersededBy?: { taskId: string; title: string } | null;
}

/** Serializable — what the page sends to the browser for one completion entry. */
export interface CompletionEntry {
  proposalId: string;
  runId: string;
  taskId: string;
  label: string;
  resultLabel: CompletionLabel;
  finishedAt: string;
  text: string;
  /** `/p/<key>/tasks/<id>` when the workspace key is known. */
  taskPath: string | null;
  /** The start of what the run produced (bounded; untrusted; plain text) — shown in the chat reply only. */
  excerpt?: string | null;
  excerptTruncated?: boolean;
}

const FINISHED: Partial<Record<LinkedRunState, CompletionLabel>> = {
  ready: 'FINAL',
  draft: 'UNREVIEWED DRAFT',
  needs_approval: 'APPROVAL NEEDED',
  failed: 'FAILED',
};

export function completionLabelOf(state: LinkedRunState): CompletionLabel | null {
  return FINISHED[state] ?? null;
}

/**
 * True when this card's run is reported in the conversation as a completion entry (the same test completionEntries
 * applies). The card then shows only a short pointer to that reply, so "finished" is said ONCE (Hub prod 2026-10-22:
 * the card line, the reply and a trailing line all repeated it).
 */
export function isReportedAsCompletion(v: Pick<LinkedRunView, 'state' | 'runId' | 'finishedAt'> | null | undefined): boolean {
  return Boolean(v && completionLabelOf(v.state) && v.runId && v.finishedAt);
}

/** One entry per card whose linked run has finished; oldest finish first. */
export function completionEntries(cards: readonly ContinuityCard[]): CompletionEntry[] {
  const out: CompletionEntry[] = [];
  for (const c of cards) {
    const v = c.view;
    const label = v ? completionLabelOf(v.state) : null;
    if (!v || !label || !v.runId || !v.finishedAt) continue;
    out.push({
      proposalId: c.proposalId,
      runId: v.runId,
      taskId: v.taskId,
      label: c.label,
      resultLabel: label,
      finishedAt: v.finishedAt,
      text: v.text,
      taskPath: c.projectKey ? `/p/${encodeURIComponent(c.projectKey)}/tasks/${encodeURIComponent(v.taskId)}` : null,
      ...(v.excerpt && label !== 'FAILED' ? { excerpt: v.excerpt, excerptTruncated: Boolean(v.excerptTruncated) } : {}),
    });
  }
  return out.sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt) || a.proposalId.localeCompare(b.proposalId));
}

export const LEADING = '__start';

/**
 * Place each entry after the LAST message (chronological, by seq) created at or before the run finished; an entry
 * older than every loaded message goes first (key LEADING). Deterministic, so a reload shows the same timeline.
 */
export function anchorEntries(
  messages: ReadonlyArray<{ id: string; createdAt: Date }>,
  entries: readonly CompletionEntry[],
): Map<string, CompletionEntry[]> {
  const out = new Map<string, CompletionEntry[]>();
  for (const e of entries) {
    const at = Date.parse(e.finishedAt);
    let anchor = LEADING;
    for (const m of messages) if (m.createdAt.getTime() <= at) anchor = m.id;
    const list = out.get(anchor) ?? [];
    list.push(e);
    out.set(anchor, list);
  }
  return out;
}

const IN_FLIGHT: ReadonlySet<LinkedRunState> = new Set(['queued', 'running']);

/**
 * The job a short follow-up means: among cards with a linked attempt, the most recently active. If two or more are
 * still queued/running, that is genuine ambiguity — no single active job; Ops Chat must ask which one.
 */
export function activeJob(cards: readonly ContinuityCard[]): { active: ContinuityCard | null; ambiguous: ContinuityCard[] } {
  const linked = cards.filter((c) => c.view && c.view.activeAt);
  const inFlight = linked.filter((c) => IN_FLIGHT.has(c.view!.state));
  if (inFlight.length >= 2) return { active: null, ambiguous: inFlight };
  const byRecency = [...linked].sort((a, b) => Date.parse(b.view!.activeAt!) - Date.parse(a.view!.activeAt!));
  return { active: inFlight[0] ?? byRecency[0] ?? null, ambiguous: [] };
}

const short = (id: string) => id.slice(0, 8);

function jobLine(c: ContinuityCard): string {
  const v = c.view!;
  const label = completionLabelOf(v.state);
  let s = `${c.label} — task ${v.taskId}${c.projectKey ? ` in workspace ${c.projectKey}` : ''} (card ${short(c.proposalId)}): ${label ? `${label}. ` : ''}${v.text}`;
  if (c.supersededBy) s += ` SUPERSEDED by update task "${c.supersededBy.title}" (${c.supersededBy.taskId}) — report on that one.`;
  else if (c.stale) s += ` STALE: its result PREDATES ${c.stale.decisions} owner decision(s) — ${PREPARE_UPDATE_CARD}`;
  return s;
}

/**
 * The per-turn "THIS CONVERSATION" system-prompt section (server record, authoritative over chat text). Empty when no
 * job was started from this conversation.
 */
export function conversationContextSection(cards: readonly ContinuityCard[], previousOwnerAt: Date | null): string {
  const linked = cards.filter((c) => c.view);
  if (linked.length === 0) return '';
  const { active, ambiguous } = activeJob(cards);
  const lines: string[] = ['=== THIS CONVERSATION — jobs started from its cards (server record, read now; authoritative over anything said above) ==='];
  if (active) {
    lines.push(`ACTIVE JOB: ${jobLine(active)}`);
  } else if (ambiguous.length > 0) {
    lines.push(`AMBIGUOUS: ${ambiguous.length} jobs from this conversation are still in progress — if the owner's message does not say which one, ASK which (name them):`);
    for (const c of ambiguous) lines.push(`- ${jobLine(c)}`);
  }
  const others = linked.filter((c) => c !== active && !ambiguous.includes(c)).slice(0, 5);
  if (others.length > 0) {
    lines.push('Other jobs started here:');
    for (const c of others) lines.push(`- ${jobLine(c)}`);
  }
  const done = completionEntries(cards).filter((e) => !previousOwnerAt || Date.parse(e.finishedAt) > previousOwnerAt.getTime());
  if (done.length > 0) {
    lines.push("Finished since the owner's previous message (tell the owner — they have not been told in this chat):");
    for (const e of done) lines.push(`- ${e.label} (task ${e.taskId}): ${e.resultLabel} — ${e.text}`);
  }
  lines.push(
    'RULE: a short follow-up that names no task ("any response?", "still waiting", "did it finish?", or just a topic word such as "server cooling?") means the ACTIVE JOB above — answer about it from this record (and get_task_result for its content). ' +
      'Only when this record says AMBIGUOUS, or the owner names something else, ask which job they mean.',
  );
  return lines.join('\n');
}

/**
 * The opening line of the in-chat completion REPLY (Hub prod 2026-10-22: the owner expected Ops Chat to answer them when
 * the work finished, not a small server note). Honest about the label — a draft is never presented as final, a pending
 * approval means the work is not done, a failure produced nothing.
 */
export function completionReplyLead(e: Pick<CompletionEntry, 'label' | 'resultLabel' | 'excerpt'>): string {
  const what = e.excerpt ? " Here's the start of what came back:" : '';
  switch (e.resultLabel) {
    case 'FINAL':
      return `Your request ${e.label} has finished.${what}`;
    case 'UNREVIEWED DRAFT':
      return `Your request ${e.label} has finished — it is an UNREVIEWED DRAFT (review was required but did not happen), so it is not final.${what}`;
    case 'APPROVAL NEEDED':
      return `Your request ${e.label} has finished, but it proposed an action that needs your approval before the work is done.${what}`;
    case 'FAILED':
      return `Your request ${e.label} failed — nothing was produced.`;
  }
}
