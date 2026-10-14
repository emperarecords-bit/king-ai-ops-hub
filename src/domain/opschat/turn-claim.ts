import { getPool } from '@/db/client';

/**
 * Serialize model execution per owner turn.
 *
 * Persisting the owner message before execution is not enough on its own: two HTTP retries
 * can both observe the same persisted owner row with "no reply yet" and both enter the
 * provider/tool loop. A session-level Postgres advisory lock keyed on the stable
 * `ownerMessageId` closes that race — AT MOST ONE server execution may hold the claim for a
 * given turn at a time. The lock is held on a reserved connection for the whole execution and
 * released (and the connection returned to the pool) via `release()`. If it drops (crash,
 * disconnect), Postgres frees the lock automatically, so a genuinely dead attempt does not
 * strand the turn.
 *
 * If the claim is NOT acquired, another request is actively running this turn: the caller must
 * replay an already-persisted result or return "in progress" — never launch a duplicate
 * provider turn. No migration: the key is a bigint derived from the id via hashtextextended,
 * and advisory locks are session-scoped.
 */
export interface TurnClaim {
  readonly claimed: boolean;
  readonly release: () => Promise<void>;
}

const NOOP_RELEASE = async (): Promise<void> => {};

export async function tryClaimTurn(ownerMessageId: string): Promise<TurnClaim> {
  const reserved = await getPool().reserve();
  try {
    const rows = await reserved<{ ok: boolean }[]>`select pg_try_advisory_lock(hashtextextended(${ownerMessageId}, 0)) as ok`;
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
        await reserved`select pg_advisory_unlock(hashtextextended(${ownerMessageId}, 0))`;
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
