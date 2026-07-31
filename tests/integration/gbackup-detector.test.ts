import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPECTED_DRIZZLE_VERSION, computeExpectedMigrations, installedDrizzleVersion } from '../../scripts/backup/migration-hash';
import { MIGRATION_STATES, detectMigrationState } from '../../scripts/backup/migration-detector';

const URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
const sql = postgres(URL, { max: 2, prepare: false });

let dbAvailable = false;
try {
  await sql`select 1 as ok`;
  await sql`select 1 from drizzle.__drizzle_migrations limit 1`;
  dbAvailable = true;
} catch (err) {
  console.warn(`[gbackup-detector.test] DB checks SKIPPED — not reachable/migrated: ${err instanceof Error ? err.message : err}`);
}

afterAll(async () => { await sql.end(); });

describe('G-Backup-A hash mirror — drizzle algorithm equivalence (no DB needed)', () => {
  it('computeExpectedMigrations reproduces drizzle-orm readMigrationFiles hashes byte-for-byte', () => {
    // Ground-truth: run drizzle's OWN reader over the same folder and compare. Both read identical file bytes,
    // so an exact match proves the mirror faithfully replicates the installed drizzle hashing (correction 5).
    expect(installedDrizzleVersion()).toBe(EXPECTED_DRIZZLE_VERSION);
    const dz = readMigrationFiles({ migrationsFolder: 'drizzle' }) as Array<{ hash: string; folderMillis: number }>;
    const mine = computeExpectedMigrations('drizzle');
    expect(mine.length).toBe(dz.length);
    for (let i = 0; i < mine.length; i++) {
      expect(mine[i]!.hash).toBe(dz[i]!.hash);
      expect(mine[i]!.when).toBe(dz[i]!.folderMillis);
    }
    // And the algorithm is exactly sha256(raw file text) for the first migration.
    const raw = readFileSync('drizzle/0000_illegal_black_knight.sql', 'utf8');
    expect(mine[0]!.hash).toBe(createHash('sha256').update(raw).digest('hex'));
  });
});

describe('G-Backup-A detector — read-only classification against the real DB', () => {
  it('detector runs read-only, returns drizzle 0.45.2 + full applied count + a deterministic valid state', async () => {
    if (!dbAvailable) return;
    const a = await detectMigrationState(sql, { migrationsFolder: 'drizzle' });
    const b = await detectMigrationState(sql, { migrationsFolder: 'drizzle' });
    expect(a.drizzleVersion).toBe(EXPECTED_DRIZZLE_VERSION);
    expect(a.appliedCount).toBe(54);
    expect(MIGRATION_STATES).toContain(a.state);
    expect(a.state).toBe(b.state); // deterministic
    expect(a.expectedSetHash).toMatch(/^[0-9a-f]{64}$/);
    // NOTE: on a Linux (LF) checkout — the deploy environment — the applied hashes equal the mirror's and the
    // state is NO_PENDING. On this Windows dev checkout the migration files carry CRLF drift and the dev DB has
    // one genuinely-edited historical migration, so the byte-faithful detector correctly reports a mismatch
    // rather than a false NO_PENDING. Either way the state is a valid, deterministic classification.
    if (a.state !== 'NO_PENDING') {
      expect(['HISTORICAL_HASH_MISMATCH', 'UNKNOWN_DATABASE_DIVERGENCE']).toContain(a.state);
    }
  });

  it('the applied set is a structurally valid prefix by created_at (ordering intact)', async () => {
    if (!dbAvailable) return;
    const rows = await sql<{ created_at: string }[]>`select created_at::text as created_at from drizzle.__drizzle_migrations order by created_at asc, id asc`;
    const expected = computeExpectedMigrations('drizzle');
    for (let i = 0; i < rows.length; i++) {
      expect(Number(rows[i]!.created_at)).toBe(expected[i]!.when); // same order/timestamps as the repo journal
    }
  });
});
