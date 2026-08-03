import { afterAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { isNonZeroCanonicalUint64Decimal } from '../../scripts/backup/receipt-v2-encoding';

/**
 * G-Backup-B2a — capability check: the MIGRATION role can read the PostgreSQL system identifier via
 * `pg_control_system()`, and it is a nonzero canonical unsigned-64-bit decimal (the value the gate binds into the
 * receipt expectation). Skips when no database is reachable.
 */

const url =
  process.env.DATABASE_MIGRATION_URL ??
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

const sql = postgres(url, { max: 1, onnotice: () => {} });
let available = false;
try {
  await sql`select 1`;
  available = true;
} catch (err) {
  console.warn(`[gbackup-pgcontrol-capability] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

afterAll(async () => {
  await sql.end();
});

describe('B2a pg_control_system() capability (migration role)', () => {
  it.runIf(available)('reads a nonzero canonical uint64 system identifier', async () => {
    const rows = await sql<{ s: string }[]>`select system_identifier::text as s from pg_control_system()`;
    const s = rows[0]?.s ?? '';
    expect(isNonZeroCanonicalUint64Decimal(s)).toBe(true);
  });
  it.runIf(available)('current_database() is readable (bootstrap identity check)', async () => {
    const rows = await sql<{ d: string }[]>`select current_database() as d`;
    expect(typeof rows[0]?.d).toBe('string');
    expect((rows[0]?.d ?? '').length).toBeGreaterThan(0);
  });
});
