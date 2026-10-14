/**
 * Ops Chat transcript + recovery model (browser side, but framework-free so it is unit-tested
 * in node, like ops-chat-stream.ts). Pure functions only — no fetch, no React.
 *
 * Three responsibilities:
 *
 * 1. TRANSCRIPT — turn the persisted conversation into display order. Order is TURN-AWARE: owner
 *    messages in persisted order, each immediately followed by its own linked reply
 *    (reply_to_message_id) — never raw seq, because a second owner message can be persisted while the
 *    first turn is still running, so the first reply can have a higher seq than the second owner row.
 *
 * 2. RECOVERY — an owner turn with no terminal assistant reply ("awaiting") is a first-class recovery
 *    state, derived from the DATABASE FACT, never from guessing why it happened (rate limit, setup
 *    failure, a reply generated but not persisted, a dropped connection…). The earliest awaiting turn
 *    blocks new sends in that conversation (the server runs owner turns FIFO) and is offered for an
 *    explicit, owner-clicked "Resume message" that re-sends the exact (conversationId, turnId,
 *    content). It is NEVER auto-retried: a retry can spend a new model call.
 *
 * 3. CONFIRM OUTCOMES — map /api/ops-chat/confirm responses to card states. A card is actionable
 *    only while `pending` AND it carries a persisted proposalId. Any outcome the client cannot prove
 *    (`unrecorded`, a 409 race, a network failure mid-confirm) disables the card and asks for a
 *    reload — a card is never auto-confirmed again.
 */

export type MessageStatus = 'complete' | 'interrupted';

/** Server-side proposal states plus two client-only "we can't prove the state" outcomes. */
export type CardState = 'pending' | 'confirming' | 'done' | 'error' | 'cancelled' | 'stale' | 'unrecorded' | 'conflict';

export interface TranscriptCard {
  /** The proposal payload exactly as streamed/persisted (display only — confirm sends just the id). */
  proposal: Record<string, unknown>;
  /** Streamed correlation key; `saved` maps it to the persisted proposalId. */
  correlationKey?: string;
  /** The persisted proposal id. Absent ⇒ never actionable. */
  proposalId?: string;
  state: CardState;
  error?: string;
  /** The executed result as returned by confirm / stored on the proposal row. */
  executed?: Record<string, unknown> | null;
}

export interface TranscriptMsg {
  /** Owner rows: the owner message id, which IS the client-minted turnId. Assistant rows: message id or a local id. */
  id: string;
  role: 'owner' | 'assistant';
  content: string;
  /** Owner only: no terminal (complete/interrupted) reply exists for this turn. */
  awaitingReply?: boolean;
  /** Assistant only. */
  status?: MessageStatus;
  /** Assistant only: the owner question that produced it (Council). */
  question?: string;
  /** Assistant only: the owner turn it answers. */
  replyTo?: string;
  cards?: TranscriptCard[];
}

/** The persisted shape the page hands over (a plain, serializable subset of LoadedMessage). */
export interface PersistedMessage {
  id: string;
  role: 'user' | 'assistant';
  status: MessageStatus;
  content: string;
  question: string | null;
  replyToMessageId: string | null;
  proposals: Array<{ id: string; proposal: unknown; state: string; result: unknown; error: string | null }>;
}

export interface PendingTurn {
  turnId: string;
  content: string;
}

const SERVER_STATES: ReadonlySet<string> = new Set(['pending', 'confirming', 'done', 'error', 'cancelled', 'stale']);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Persisted messages (chronological by seq) → turn-aware display order. */
export function buildTranscript(persisted: readonly PersistedMessage[]): TranscriptMsg[] {
  const owners = persisted.filter((m) => m.role === 'user');
  const ownerIds = new Set(owners.map((m) => m.id));
  const replyFor = new Map<string, PersistedMessage>();
  const orphans: PersistedMessage[] = [];
  for (const m of persisted) {
    if (m.role !== 'assistant') continue;
    // One reply per owner turn is a DB invariant; a reply whose owner fell outside the display window
    // (or an unlinked legacy row) is shown first, in seq order, rather than dropped.
    if (m.replyToMessageId && ownerIds.has(m.replyToMessageId) && !replyFor.has(m.replyToMessageId)) replyFor.set(m.replyToMessageId, m);
    else orphans.push(m);
  }
  const toAssistant = (m: PersistedMessage): TranscriptMsg => ({
    id: m.id,
    role: 'assistant',
    content: m.content,
    status: m.status,
    question: m.question ?? undefined,
    replyTo: m.replyToMessageId ?? undefined,
    // Interrupted turns never persist proposals; ignore any defensively.
    cards:
      m.status === 'complete' && m.proposals.length > 0
        ? m.proposals.map((p) => ({
            proposal: asRecord(p.proposal) ?? {},
            proposalId: p.id,
            state: (SERVER_STATES.has(p.state) ? p.state : 'unrecorded') as CardState,
            error: p.error ?? undefined,
            executed: asRecord(p.result),
          }))
        : undefined,
  });
  const out: TranscriptMsg[] = orphans.map(toAssistant);
  for (const o of owners) {
    const reply = replyFor.get(o.id);
    out.push({ id: o.id, role: 'owner', content: o.content, awaitingReply: !reply });
    if (reply) out.push(toAssistant(reply));
  }
  return out;
}

/**
 * The turn that must be resumed before anything else can be sent in this conversation: the server's
 * earliest unanswered owner turn when it is OUTSIDE the loaded window (still unresolved), otherwise
 * the first owner message in the transcript still awaiting a terminal reply. Null ⇒ sending is open.
 */
export function pendingTurnOf(messages: readonly TranscriptMsg[], outsideWindow: PendingTurn | null): PendingTurn | null {
  if (outsideWindow) return outsideWindow;
  const first = messages.find((m) => m.role === 'owner' && m.awaitingReply);
  return first ? { turnId: first.id, content: first.content } : null;
}

/** Is the server's pending turn absent from the loaded window? (Then the page-supplied copy is authoritative.) */
export function pendingOutsideWindow(messages: readonly TranscriptMsg[], serverPending: PendingTurn | null): PendingTurn | null {
  if (!serverPending) return null;
  return messages.some((m) => m.role === 'owner' && m.id === serverPending.turnId) ? null : serverPending;
}

/** Apply a `saved` mapping: attach each persisted proposalId to its streamed card by correlationKey. */
export function applySavedMapping(
  cards: readonly TranscriptCard[] | undefined,
  mapping: ReadonlyArray<{ correlationKey: string; proposalId: string }>,
): TranscriptCard[] | undefined {
  if (!cards) return cards;
  const byKey = new Map(mapping.map((m) => [m.correlationKey, m.proposalId]));
  return cards.map((c) => {
    const id = c.correlationKey ? byKey.get(c.correlationKey) : undefined;
    return id ? { ...c, proposalId: id } : c;
  });
}

/** A card the owner may act on: still pending AND backed by a persisted proposal row. */
export function isActionable(card: TranscriptCard): boolean {
  return card.state === 'pending' && typeof card.proposalId === 'string' && card.proposalId.length > 0;
}

export const RELOAD_TO_SEE_STATE = 'The outcome could not be confirmed — reload to see the true state. This card will not be confirmed again.';

/**
 * Map a confirm/cancel response to the card's next state.
 *  - `state` present ⇒ the server reached (or failed to record) a CAS: adopt it. `unrecorded` is never
 *    shown as done or retried.
 *  - 409 ⇒ another tab/device changed the card: disable and ask for a reload.
 *  - non-OK with no `state` ⇒ rejected BEFORE the pending→confirming CAS (auth, rate limit, invalid):
 *    the card is still pending server-side, so it stays actionable with the error shown.
 *  - OK with no recognizable state ⇒ cannot prove the outcome: fail closed (unrecorded).
 */
export function confirmOutcome(httpStatus: number, json: unknown): Pick<TranscriptCard, 'state' | 'error' | 'executed'> {
  const j = asRecord(json) ?? {};
  const error = typeof j.error === 'string' ? j.error : undefined;
  const warning = typeof j.warning === 'string' ? j.warning : undefined;
  const executed = asRecord(j.executed);
  const state = typeof j.state === 'string' ? j.state : undefined;
  if (httpStatus === 409) return { state: 'conflict', error: error ? `${error} Reload to see its current state.` : RELOAD_TO_SEE_STATE };
  if (state === 'unrecorded') return { state: 'unrecorded', error: warning ?? error ?? RELOAD_TO_SEE_STATE, executed };
  if (state === 'done' || state === 'cancelled' || state === 'stale' || state === 'error') {
    return { state, error: state === 'done' || state === 'cancelled' ? undefined : (error ?? 'That did not go through.'), executed };
  }
  if (httpStatus < 200 || httpStatus >= 300) return { state: 'pending', error: error ?? 'That did not go through.' };
  return { state: 'unrecorded', error: RELOAD_TO_SEE_STATE, executed };
}
