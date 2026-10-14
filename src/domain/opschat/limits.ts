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
 * How many prior messages (by seq, most recent) the server loads from the persisted
 * conversation to build the provider prompt. Bounded so a long thread never bloats model
 * context — this is the MODEL window, deliberately tighter than the display window
 * (loadConversation). The just-persisted owner message is included as the final turn.
 */
export const OPS_CHAT_MAX_PROMPT_MESSAGES = 16;

/** Shown when the owner message persisted and the model answered, but writing the reply to the
 *  store failed — no `saved` is emitted, so the client keeps any cards disabled. Retryable: the
 *  turn id is already committed, so a retry replays if a reply exists or re-runs if not. */
export const OPS_CHAT_PERSIST_FAILED_MESSAGE = 'The reply could not be saved. Nothing was changed — try again.';

/** Shown when another request already holds this turn's execution claim and no reply exists yet. */
export const OPS_CHAT_TURN_IN_PROGRESS_MESSAGE = 'This message is already being answered. Reload in a moment to see the reply.';
