import { sql } from 'drizzle-orm';
import { RateLimitedError } from '@/lib/errors';
import { type DbTx } from '@/db/client';

/**
 * Fixed-window rate limiting backed by rate_limit_buckets. Atomic via a single
 * upsert with a conditional count check, so concurrent requests cannot both
 * slip under the limit.
 */

export async function consumeRateLimit(
  tx: DbTx,
  scopeKey: string,
  limitPerMinute: number,
): Promise<void> {
  const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);

  const rows = await tx.execute(sql`
    insert into rate_limit_buckets (scope_key, window_start, count)
    values (${scopeKey}, ${windowStart.toISOString()}, 1)
    on conflict (scope_key, window_start)
    do update set count = rate_limit_buckets.count + 1
      where rate_limit_buckets.count < ${limitPerMinute}
    returning count
  `);

  // No row returned → the conditional update refused: over the limit.
  if (rows.length === 0) {
    throw new RateLimitedError();
  }

  // A7 hygiene: stale windows for THIS scope die with the successful consume.
  // Targeted (indexed by scope_key) and piggybacked, so the table stays
  // bounded without a scheduler.
  await tx.execute(sql`
    delete from rate_limit_buckets
    where scope_key = ${scopeKey}
      and window_start < ${new Date(windowStart.getTime() - 60 * 60_000).toISOString()}
  `);
}
