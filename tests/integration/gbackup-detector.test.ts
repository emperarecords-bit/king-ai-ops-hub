import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPECTED_DRIZZLE_VERSION, computeExpectedMigrations, installedDrizzleVersion } from '../../scripts/backup/migration-hash';
import { buildSourceManifestFromGit } from '../../scripts/backup/source-manifest';
import { classifyMigrationState, detectMigrationState } from '../../scripts/backup/migration-detector';

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

describe('G-Backup-A hash mirror — drizzle equivalence + portable source manifest', () => {
  it('drizzleExecutionHash mirror reproduces drizzle readMigrationFiles byte-for-byte', () => {
    expect(installedDrizzleVersion()).toBe(EXPECTED_DRIZZLE_VERSION);
    const dz = readMigrationFiles({ migrationsFolder: 'drizzle' }) as Array<{ hash: string }>;
    const mine = computeExpectedMigrations('drizzle');
    expect(mine.length).toBe(dz.length);
    for (let i = 0; i < mine.length; i++) expect(mine[i]!.hash).toBe(dz[i]!.hash);
    const raw = readFileSync('drizzle/0000_illegal_black_knight.sql', 'utf8');
    expect(mine[0]!.hash).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('classifier recognizes CRLF variants of the REAL committed source (staging-shape proof, not hard-coded)', () => {
    // Build the portable source from Git, then simulate an applied history where two migrations were applied
    // from CRLF bytes (their recognized variant) — exactly staging's shape. The classifier must return
    // NO_PENDING with 2 recognized variants and 0 unknown mismatches, derived (not hard-coded).
    const manifest = buildSourceManifestFromGit('HEAD', 'drizzle');
    const variantIdx = new Set([4, 53]);
    const applied = manifest.entries.map((e) => ({
      hash: variantIdx.has(e.idx) && e.recognizedVariantSha256 ? e.recognizedVariantSha256 : e.committedBlobSha256,
      createdAt: e.when,
      id: e.idx + 1,
    }));
    const runtime = manifest.entries.map((e) => ({ when: e.when, tag: e.tag, rawHash: e.committedBlobSha256 }));
    const r = classifyMigrationState({
      source: manifest.entries,
      sourceMigrationSetHash: manifest.sourceMigrationSetHash,
      applied,
      runtime,
      migrationsTableMissing: false,
      declaredBootstrap: false,
      hasUnexplainedUserObjects: false,
      databaseIdentityMatches: true,
    });
    expect(r.state).toBe('NO_PENDING');
    expect(r.lineEndingVariantMatches).toBe(2);
    expect(r.unknownHistoricalMismatches).toBe(0);
    expect(r.unknownDatabaseDivergences).toBe(0);
    expect(r.variantDetails.map((v) => v.idx).sort((a, b) => a - b)).toEqual([4, 53]);
  });
});

describe('G-Backup-A detector — read-only against the real local DB', () => {
  it('classifies the migrated local DB deterministically under the STRICT clean-variant policy', async () => {
    if (!dbAvailable) return;
    const manifest = buildSourceManifestFromGit('HEAD', 'drizzle');
    const a = await detectMigrationState(sql, { sourceManifest: manifest, migrationsFolder: 'drizzle' });
    const b = await detectMigrationState(sql, { sourceManifest: manifest, migrationsFolder: 'drizzle' });
    expect(a.drizzleVersion).toBe(EXPECTED_DRIZZLE_VERSION);
    expect(a.appliedCount).toBe(54);
    expect(a.state).toBe(b.state); // deterministic
    // The local (and staging) dev DBs applied `0004_knowledge_k1` from an IRREGULAR/mixed line-ending form
    // (`c2c7463a…`) that LF-normalizes to the committed content but is NOT the committed blob nor its single
    // deterministic CRLF transform. Under the strict policy that is correctly HISTORICAL_HASH_MISMATCH — NOT a
    // recognized variant. (0053 IS a clean recognized variant.) See the correction report for the decision ask.
    expect(a.state).toBe('HISTORICAL_HASH_MISMATCH');
  });

  it('the catalog probe finds this DB non-empty (app schema/tables exist) — read-only', async () => {
    if (!dbAvailable) return;
    const rel = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind in ('r','p','S','v','m')
        and n.nspname not in ('pg_catalog','information_schema','pg_toast')
        and n.nspname not like 'pg\\_temp\\_%'
        and not exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')`;
    expect(rel[0]!.n).toBeGreaterThan(0); // proves the probe detects user objects (would block a false bootstrap)
  });
});
