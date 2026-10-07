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

/** Server-side overall deadline for one Ops Chat request (all iterations + tools). */
export const OPS_CHAT_SERVER_DEADLINE_MS = 118_000;

/** Browser watchdog deadline — the backstop that always clears "Thinking…". */
export const OPS_CHAT_CLIENT_TIMEOUT_MS = 120_000;

/** The single retryable message shown on any Ops Chat timeout. */
export const OPS_CHAT_TIMEOUT_MESSAGE = 'The AI request timed out. Nothing was changed. Try again.';
