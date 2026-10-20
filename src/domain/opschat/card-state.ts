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

export interface StoredCard {
  kind: string;
  state: string;
  proposal: Record<string, unknown>;
  result: unknown;
  error: string | null;
  updatedAt: Date;
}

const STATE_TEXT: Record<string, string> = {
  pending: 'NOT confirmed — still waiting for the owner',
  confirming: 'being confirmed right now',
  done: 'CONFIRMED by the owner and executed',
  cancelled: 'CANCELLED by the owner — nothing was done',
  stale: 'STALE — not executed',
  error: 'FAILED when confirmed',
};

function str(v: unknown, max = 90): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
}

function cardLabel(c: StoredCard): string {
  const p = c.proposal;
  switch (c.kind) {
    case 'decide_approval':
      return `${str(p.decision) ?? 'decide'} approval ${str(p.approvalId, 36) ?? ''}`.trim();
    case 'rerun_task':
      return `re-run "${str(p.taskTitle) ?? str(p.taskId, 36) ?? 'task'}"`;
    case 'dispatch_task':
      return `dispatch "${str(p.title) ?? 'task'}"${str(p.agentName) ? ` to ${str(p.agentName)}` : ''}`;
    case 'answer_question':
      return `answer question ${str(p.questionId, 36) ?? ''}`.trim();
    default:
      return str(p.title) ?? str(p.summary) ?? c.kind;
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

/** The lines appended to one assistant reply, or '' when it had no cards. */
export function cardStateLines(cards: readonly StoredCard[]): string {
  if (cards.length === 0) return '';
  const lines = cards.map((c) => {
    const when = c.updatedAt.toISOString().slice(0, 16).replace('T', ' ');
    const state = STATE_TEXT[c.state] ?? c.state;
    const err = c.error && (c.state === 'stale' || c.state === 'error') ? `: ${c.error.slice(0, 160)}` : '';
    return `- [card ${c.kind}] ${cardLabel(c)} — ${state}${err} — as of ${when} UTC${resultIds(c.result)}`;
  });
  return `\n\n[SERVER RECORD — current state of the cards in this reply; authoritative over anything said above]\n${lines.join('\n')}`;
}
