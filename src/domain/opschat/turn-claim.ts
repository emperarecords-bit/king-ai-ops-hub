import { getPool } from '@/db/client';

/**
 * Serialize Ops Chat model execution with session-level Postgres advisory locks, at TWO scopes:
 *
 *   - PER TURN (`opschat:turn:<ownerMessageId>`) — stops two HTTP retries of the SAME send from
 *     both entering the provider loop (duplicate-request protection).
 *   - PER CONVERSATION (`opschat:conversation:<conversationId>`) — stops two DIFFERENT owner
 *     messages in the same conversation (from two tabs/devices) from executing simultaneously,
 *     which would otherwise race on prompt history and let one turn answer against the other's
 *     message. The route acquires this before the spend gate/provider loop; if another turn in the
 *     conversation is already running, the caller returns an in-progress/retry and the persisted
 *     owner row simply runs later.
 *
 * The keys are NAMESPACED strings hashed with hashtextextended, not raw UUIDs, so a turn lock and a
 * conversation lock can never collide even if a client reused one UUID for both ids. Each lock is
 * held on its own reserved connection for the whole execution and freed via `release()` (idempotent;
 * if the connection drops, Postgres frees the lock automatically so a dead attempt never strands the
 * turn/conversation). Both `tryClaim*` use pg_try_advisory_lock (non-blocking), so there is no
 * deadlock risk between the two scopes — a lost acquire returns `{ claimed: false }` immediately.
 */
export interface TurnClaim {
  readonly claimed: boolean;
  readonly release: () => Promise<void>;
}

const NOOP_RELEASE = async (): Promise<void> => {};

/** Acquire a session advisory lock for a namespaced string key. */
async function acquireAdvisory(lockKey: string): Promise<TurnClaim> {
  const reserved = await getPool().reserve();
  try {
    const rows = await reserved<{ ok: boolean }[]>`select pg_try_advisory_lock(hashtextextended(${lockKey}, 0)) as ok`;
    if (rows[0]?.ok !== true) {
      reserved.release();
      return { claimed: false, release: NOOP_RELEASE };
    }
    // Idempotent release — safe to call more than once (e.g. a cleanup path plus a finally),
    // so releasing can never itself become a second failure path.
    let released = false;
    const release = async (): Promise<void> => {
      if (released) return;
      released = true;
      try {
        await reserved`select pg_advisory_unlock(hashtextextended(${lockKey}, 0))`;
      } finally {
        reserved.release();
      }
    };
    return { claimed: true, release };
  } catch (err) {
    reserved.release();
    throw err;
  }
}

/** Claim exclusive execution of ONE owner turn. Loser must replay a persisted reply or return
 *  "in progress" — never launch a duplicate provider turn. */
export function tryClaimTurn(ownerMessageId: string): Promise<TurnClaim> {
  return acquireAdvisory(`opschat:turn:${ownerMessageId}`);
}

/** Claim exclusive execution within ONE conversation. Loser means another turn in the same
 *  conversation is executing — return "busy, retry" and let the persisted owner turn run later. */
export function tryClaimConversation(conversationId: string): Promise<TurnClaim> {
  return acquireAdvisory(`opschat:conversation:${conversationId}`);
}
