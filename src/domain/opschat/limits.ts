/**
 * Ops Chat timeout limits — the single source of truth for the end-to-end
 * deadline, shared by the server stream route, the browser watchdog, and the
 * SSE consumer. Plain constants (NO `server-only`, NO `use client`) so every
 * layer imports the same values and they can never drift.
 *
 * An Ops Chat "Send" is a multi-turn provider + tool loop. Nothing must leave
 * the UI stuck on "Thinking…": the SERVER enforces an overall wall-clock
 * deadline (independent of the per-provider-call timeout and of how many
 * iterations the tool loop runs), and the BROWSER runs a watchdog that aborts
 * the request at its own deadline as a backstop. The browser deadline is set
 * slightly LONGER than the server's so, in the normal case, the server emits a
 * clean, retryable timeout error first; the watchdog guarantees the UI recovers
 * even if the response never arrives (e.g. the connection silently stalls).
 */

/**
 * Server-side overall deadline for one Ops Chat request (all iterations + tools). Raised from 118s to give a
 * broad, multi-connector "finish the release" turn room to finish, WITHOUT hiding inefficient tool planning
 * behind a several-minute ceiling (the system prompt steers such requests to a bounded inspection instead).
 */
export const OPS_CHAT_SERVER_DEADLINE_MS = 180_000;

/** Browser watchdog deadline — slightly LONGER than the server's so a clean server timeout error normally
 *  arrives first; the watchdog is the backstop that ALWAYS clears "Thinking…", even in a backgrounded tab. */
export const OPS_CHAT_CLIENT_TIMEOUT_MS = 188_000;

/** The single retryable message shown on any Ops Chat timeout. */
export const OPS_CHAT_TIMEOUT_MESSAGE = 'The AI request timed out. Nothing was changed. Try again.';

/** Shown when the stream closes without a terminal `done`/`error` event (abnormal close) — retryable, no write. */
export const OPS_CHAT_CONNECTION_CLOSED_MESSAGE = 'The connection closed before the reply finished. Nothing was changed — try again.';

/**
 * How many prior OWNER turns (up through the current one, in owner-message order) the server
 * reconstructs into the provider prompt — each owner message followed by its COMPLETE linked
 * assistant reply (via reply_to_message_id). Bounded so a long thread never bloats model context;
 * this is the MODEL window, tighter than the display window (loadConversation). The prompt is built
 * turn-by-turn (NOT by raw message seq) so an assistant reply that landed with a higher seq than a
 * later owner message is still attached to the correct turn. A turn yields up to 2 messages, so the
 * effective message cap is ~2× this value.
 */
export const OPS_CHAT_MAX_PROMPT_TURNS = 8;

/** Shown when the owner message persisted and the model answered, but writing the reply to the
 *  store failed — no `saved` is emitted, so the client keeps any cards disabled. Retryable: the
 *  turn id is already committed, so a retry replays if a reply exists or re-runs if not. */
export const OPS_CHAT_PERSIST_FAILED_MESSAGE = 'The reply could not be saved. Nothing was changed — try again.';

/** Shown when another request already holds this turn's execution claim and no reply exists yet. */
export const OPS_CHAT_TURN_IN_PROGRESS_MESSAGE = 'This message is already being answered. Reload in a moment to see the reply.';

/** Shown when a DIFFERENT turn in the same conversation is still executing (conversation-level
 *  serialization). The owner message stays persisted; retrying the same turn later runs it after
 *  the in-flight turn finishes. */
export const OPS_CHAT_CONVERSATION_BUSY_MESSAGE = 'Another message in this conversation is still being answered. Try again in a moment.';

/** Shown when an EARLIER owner message in the same conversation has not been answered yet. Owner
 *  turns execute in persisted order (FIFO), so this turn waits its place — retrying runs it once
 *  the earlier turn reaches a terminal reply. */
export const OPS_CHAT_EARLIER_TURN_PENDING_MESSAGE = 'An earlier message in this conversation is still waiting to be answered. Try again in a moment.';

/**
 * Appended (streamed + persisted) when a COMPLETED turn would otherwise end with no words after its
 * last tool — e.g. the model said "let me try…", a tool refused, and nothing followed. Honest and
 * neutral: it never claims anything happened, and points at any card the turn did prepare.
 */
export function opsChatClosingLine(proposalCount: number): string {
  return proposalCount > 0
    ? "That's prepared above — nothing happens until you click Confirm. Tell me if anything on it should change."
    : "I couldn't finish that step, and nothing was created or sent. Tell me how you'd like to continue, or ask me what got in the way.";
}

/**
 * Output room per Ops Chat model call (Hub prod 2026-10-23: at 1,500 the model's thinking used it all on big turns —
 * a pasted conversation + image, "do all 3" — and three replies came back as "I couldn't finish that step" with
 * nothing wrong but the limit). A call that still hits the limit before saying anything is retried once with more
 * room by the provider's tool loop.
 */
export const OPS_CHAT_MAX_OUTPUT_TOKENS = 8_000;

/**
 * Appended instead of opsChatClosingLine when the turn ended because a model call ran out of output room (after
 * the one retry with more room) — so the owner is told what actually happened, not "couldn't finish that step".
 */
export function opsChatCutOffLine(proposalCount: number, spoke: boolean): string {
  const lead = spoke ? 'My reply ran out of room before I finished.' : 'My reply ran out of room before I could write it.';
  return proposalCount > 0
    ? `${lead} What's prepared above is complete — nothing happens until you click Confirm. Ask me to continue for the rest.`
    : `${lead} Nothing was created or sent. Ask me to continue, or break the request into smaller steps.`;
}

/** Shown when replaying a persisted INTERRUPTED reply. An interrupted turn is kept for history but
 *  must never masquerade as a completed answer, so its replay ends in `error`, not `done`. */
export const OPS_CHAT_INTERRUPTED_REPLAY_MESSAGE = 'This reply was interrupted. Send a new message to continue.';
