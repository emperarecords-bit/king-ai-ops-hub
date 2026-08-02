import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';

/**
 * Test-only helpers for the P1c fresh-database bootstrap suite. They create and drop DISPOSABLE databases named
 * `king_ai_hub_p1c_*` on the local Docker Postgres (never the shared `king_ai_hub`), and build trimmed migration
 * folders so an "incremental" database (migrated only through an earlier migration) can be simulated WITHOUT
 * editing any committed migration.
 */

const BASE_URL =
  process.env.DATABASE_MIGRATION_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

/** A disposable database name must match this so we can never accidentally target the shared DB. */
const DISPOSABLE_NAME = /^king_ai_hub_p1c_[a-z0-9_]+$/;

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

/** True if the local Postgres is reachable (else the suite skips, matching repo convention). */
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

/**
 * Build a temporary migrations folder containing migrations 0000..(0000+count-1) and a `meta/_journal.json`
 * sliced to those entries. Drizzle's runtime migrator reads only the journal + the `.sql` files (no snapshots),
 * so this faithfully migrates a database to an EARLIER point without touching the committed `drizzle/` tree.
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
 * Build a temporary migrations folder whose single migration contains INVALID SQL, to simulate a migration
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
