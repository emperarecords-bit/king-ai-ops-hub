import { NextResponse } from 'next/server';
import { sql } from 'drizzle-orm';
import { getDb } from '@/db/client';

/**
 * Health check (O-21). Unauthenticated, cheap, and leaks nothing sensitive.
 * Reports process liveness, database connectivity, whether migrations have been
 * applied (the latest expected table exists), and whether the durable worker
 * has claimed a job recently. Returns 200 when healthy, 503 otherwise, so a
 * cloud load balancer can gate traffic and page on failure.
 */
export const dynamic = 'force-dynamic';

// Bump when a new migration adds a table that must exist for the app to serve.
const LATEST_EXPECTED_TABLE = 'run_jobs';

export async function GET() {
  const checks: Record<string, { ok: boolean; detail?: string }> = {};

  // Process is obviously up if this handler runs.
  checks.process = { ok: true };

  // Database connectivity.
  let db;
  try {
    db = getDb();
    await db.execute(sql`select 1`);
    checks.database = { ok: true };
  } catch (err) {
    checks.database = { ok: false, detail: err instanceof Error ? err.message.slice(0, 120) : 'unreachable' };
  }

  // Migration state: the latest expected table exists.
  if (checks.database.ok && db) {
    try {
      const r = await db.execute(
        sql`select to_regclass(${'public.' + LATEST_EXPECTED_TABLE}) is not null as present`,
      );
      const row = (r as unknown as { rows?: Array<{ present: boolean }> }).rows?.[0] ?? (Array.isArray(r) ? r[0] : undefined);
      checks.migrations = { ok: !!row?.present, detail: row?.present ? undefined : `missing ${LATEST_EXPECTED_TABLE}` };
    } catch (err) {
      checks.migrations = { ok: false, detail: err instanceof Error ? err.message.slice(0, 120) : 'unknown' };
    }
  }

  // Worker liveness: any job updated (claimed/finished) in the last 5 minutes,
  // OR no queued backlog. A queued backlog with no recent worker activity is
  // the unhealthy signal (jobs piling up, nothing executing).
  if (checks.database?.ok && db) {
    try {
      const r = await db.execute(sql`
        select
          count(*) filter (where status = 'queued') as queued,
          count(*) filter (where updated_at > now() - interval '5 minutes') as recent
        from run_jobs
      `);
      const row = (r as unknown as { rows?: Array<{ queued: string; recent: string }> }).rows?.[0]
        ?? (Array.isArray(r) ? r[0] : undefined);
      const queued = Number(row?.queued ?? 0);
      const recent = Number(row?.recent ?? 0);
      // Healthy unless there is a backlog with no recent activity at all.
      const ok = queued === 0 || recent > 0;
      checks.worker = { ok, detail: `queued=${queued} recentActivity=${recent}` };
    } catch {
      checks.worker = { ok: true, detail: 'no run_jobs table yet' };
    }
  }

  const healthy = Object.values(checks).every((c) => c.ok);
  return NextResponse.json(
    { status: healthy ? 'ok' : 'degraded', checks },
    { status: healthy ? 200 : 503 },
  );
}
