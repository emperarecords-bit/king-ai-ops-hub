import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';

/**
 * Test-only helpers for the fresh-database bootstrap + migration-identity suites. They create and drop DISPOSABLE
 * databases named `king_ai_hub_p1c_*` / `king_ai_hub_p1d_*` on the local/CI Postgres (never the shared
 * `king_ai_hub`), and build migration folders so a specific migration IDENTITY (clean-current vs accepted-legacy
 * 0004) can be constructed WITHOUT editing any committed migration, journal row, or the shared database. The
 * expected migration count is read from the checked-out journal, so this is branch-count independent.
 */

const BASE_URL =
  process.env.DATABASE_MIGRATION_URL ??
  process.env.TEST_DATABASE_URL ??
  process.env.DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

/**
 * A disposable database name must match this so we can never accidentally target the shared DB. Accepts the P1c
 * bootstrap DBs and the P1d run-reliability / migration-identity DBs (`king_ai_hub_p1c_*`, `king_ai_hub_p1d_*`).
 * The shared name `king_ai_hub` (no `_p1c_`/`_p1d_` infix) never matches.
 */
const DISPOSABLE_NAME = /^king_ai_hub_p1[cd]_[a-z0-9_]+$/;

function withDb(name: string): string {
  const u = new URL(BASE_URL);
  u.pathname = `/${name}`;
  return u.toString();
}

/** The maintenance connection (the always-present `postgres` database) used to CREATE/DROP disposable DBs. */
export function maintenanceUrl(): string {
  return withDb('postgres');
}

export function disposableUrl(name: string): string {
  if (!DISPOSABLE_NAME.test(name)) throw new Error(`refusing non-disposable db name: ${name}`);
  return withDb(name);
}

/** True if the maintenance Postgres is reachable (else the suite skips, matching repo convention). */
export async function bootstrapDbAvailable(): Promise<boolean> {
  const sql = postgres(maintenanceUrl(), { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end();
  }
}

export async function createDisposableDb(name: string): Promise<void> {
  if (!DISPOSABLE_NAME.test(name)) throw new Error(`refusing non-disposable db name: ${name}`);
  const sql = postgres(maintenanceUrl(), { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`drop database if exists ${name} with (force)`);
    await sql.unsafe(`create database ${name}`);
  } finally {
    await sql.end();
  }
}

export async function dropDisposableDb(name: string): Promise<void> {
  if (!DISPOSABLE_NAME.test(name)) throw new Error(`refusing non-disposable db name: ${name}`);
  const sql = postgres(maintenanceUrl(), { max: 1, onnotice: () => {} });
  try {
    await sql.unsafe(`drop database if exists ${name} with (force)`);
  } finally {
    await sql.end();
  }
}

/** The `0004_knowledge_k1` migration tag whose two line-ending identities the detector must distinguish. */
export const TAG_0004 = '0004_knowledge_k1';

/**
 * The documented ACCEPTED-LEGACY sha256 of the irregular `0004` execution form: the committed 0004 blob (3805
 * bytes, LF) with ONE 0x0D inserted before the FINAL 0x0A → 3806 bytes. This LF-normalizes to the committed
 * content but is NOT the committed blob nor its single deterministic CRLF transform, so under the strict
 * clean-variant policy it is a HISTORICAL_HASH_MISMATCH unless covered by a valid legacy attestation.
 */
export const LEGACY_0004_SHA256 = 'c2c7463a277ae0c157775121b3c471fb99ce04f4f896334f070f2a8848830754';

/** Read the committed (git HEAD) bytes of a migration file. Throws if the tag is not committed at HEAD. */
function gitHeadBlob(folder: string, tag: string): Buffer {
  // stdio stderr 'ignore' so the expected "not in HEAD" message for an uncommitted tail is not printed.
  return execFileSync('git', ['show', `HEAD:${folder}/${tag}.sql`], { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** git's clean filter normalizes CRLF→LF on commit; the committed form is the LF-normalization of raw bytes. */
function lfNormalize(raw: Buffer): Buffer {
  return Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

/**
 * Reconstruct the irregular legacy `0004` execution bytes from the committed blob: insert ONE 0x0D directly
 * before the FINAL 0x0A. sha256(result) === {@link LEGACY_0004_SHA256}. Pure; never edits any file.
 */
export function reconstructLegacy0004Bytes(committed: Buffer): Buffer {
  let lastLf = -1;
  for (let i = committed.length - 1; i >= 0; i--) {
    if (committed[i] === 0x0a) { lastLf = i; break; }
  }
  if (lastLf < 0) throw new Error('0004 committed blob has no trailing LF to reconstruct the legacy form from');
  return Buffer.concat([committed.subarray(0, lastLf), Buffer.from([0x0d]), committed.subarray(lastLf)]);
}

/**
 * Build a temporary migrations folder that reproduces a specific 0004 IDENTITY, so a disposable DB can be
 * bootstrapped to either identity WITHOUT editing any committed migration, journal row, or the shared DB:
 *   - kind 'clean'  → every committed migration is its exact committed (git HEAD) blob; uncommitted tail is
 *                     LF-normalized. Applied 0004 === the clean committed bytes (an exact committed-blob match).
 *   - kind 'legacy' → identical, EXCEPT 0004 is the reconstructed 3806-byte irregular form ({@link
 *                     LEGACY_0004_SHA256}), which Drizzle then computes + records NATURALLY on migrate.
 *
 * The journal (meta/) is copied verbatim from the working tree so every `when`/`idx` matches the committed
 * journal, and the folder migrates the DB through the full checked-out migration set.
 */
export function makeIdentityMigrationsFolder(
  kind: 'clean' | 'legacy',
  sourceFolder = 'drizzle',
): { folder: string; cleanup: () => void; applied0004Sha256: string } {
  const journal = JSON.parse(readFileSync(join(sourceFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const dir = mkdtempSync(join(tmpdir(), `p1d-ident-${kind}-`));
  cpSync(join(sourceFolder, 'meta'), join(dir, 'meta'), { recursive: true });

  const committed0004 = gitHeadBlob(sourceFolder, TAG_0004); // 3805 bytes, LF
  const legacy0004 = reconstructLegacy0004Bytes(committed0004); // 3806 bytes

  for (const e of journal.entries) {
    let bytes: Buffer;
    if (e.tag === TAG_0004) {
      bytes = kind === 'legacy' ? legacy0004 : committed0004;
    } else {
      // Committed migrations → exact committed blob (fully deterministic, exact matches). Any uncommitted tail
      // has no HEAD blob → use its LF-normalized working-tree form (the committed-equivalent).
      try {
        bytes = gitHeadBlob(sourceFolder, e.tag);
      } catch {
        bytes = lfNormalize(readFileSync(join(sourceFolder, `${e.tag}.sql`)));
      }
    }
    writeFileSync(join(dir, `${e.tag}.sql`), bytes);
  }

  return {
    folder: dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    applied0004Sha256: kind === 'legacy' ? LEGACY_0004_SHA256 : createHash('sha256').update(committed0004).digest('hex'),
  };
}

/**
 * (P1c) Build a temporary migrations folder containing migrations 0000..(count-1) and a `meta/_journal.json`
 * sliced to those entries, so an "incremental" database (migrated only through an earlier migration) can be
 * simulated WITHOUT editing any committed migration. Drizzle's runtime migrator reads only the journal + `.sql`
 * files (no snapshots), so this faithfully migrates a database to an EARLIER point.
 */
export function makeTruncatedMigrationsFolder(count: number, sourceFolder = 'drizzle'): { folder: string; cleanup: () => void } {
  const journal = JSON.parse(readFileSync(join(sourceFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: { idx: number; tag: string }[];
  };
  const kept = journal.entries.slice(0, count);
  const dir = mkdtempSync(join(tmpdir(), 'p1c-mig-'));
  cpSync(join(sourceFolder, 'meta'), join(dir, 'meta'), { recursive: true });
  writeFileSync(join(dir, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }, null, 2));
  for (const e of kept) cpSync(join(sourceFolder, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return { folder: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * (P1c) Build a temporary migrations folder whose single migration contains INVALID SQL, to simulate a migration
 * failure without editing any committed migration.
 */
export function makeBadMigrationsFolder(): { folder: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'p1c-bad-'));
  const when = Date.now();
  cpSync(join('drizzle', 'meta'), join(dir, 'meta'), { recursive: true });
  writeFileSync(
    join(dir, 'meta', '_journal.json'),
    JSON.stringify(
      { version: '7', dialect: 'postgresql', entries: [{ idx: 0, version: '7', when, tag: '0000_bad', breakpoints: true }] },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, '0000_bad.sql'), 'CREATE TABLE this is not valid sql at all;');
  return { folder: dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
