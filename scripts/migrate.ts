import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Takes a safety dump before any DDL runs (SPRINT-03-PLAN.md §6). Best-effort
 * by design: on a fresh database there is nothing to dump and no container to
 * dump from, and that must not block the very first migration.
 * Set SKIP_PREMIGRATION_BACKUP=1 to bypass explicitly (e.g. in CI).
 */
function preMigrationBackup() {
  if (process.env.SKIP_PREMIGRATION_BACKUP === '1') {
    console.log('Pre-migration backup skipped (SKIP_PREMIGRATION_BACKUP=1).');
    return;
  }
  try {
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(process.cwd(), 'scripts', 'backup.ps1')],
      { stdio: 'inherit', timeout: 120_000 },
    );
  } catch {
    console.warn('Pre-migration backup failed (continuing — fresh DB or container not running).');
  }
}

/**
 * Applies Drizzle migrations, then the hand-written RLS/trigger layer.
 * Uses the MIGRATION connection (DDL rights), never the app role.
 */
async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');

  preMigrationBackup();

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql);

  // Concurrency protection: a session-level advisory lock so two deploy tasks
  // (e.g. two web instances booting at once) cannot run migrations
  // simultaneously. The second waits; when it acquires the lock the migrations
  // are already applied and Drizzle's journal makes re-application a no-op.
  const LOCK_KEY = 4021; // arbitrary, stable per-app
  console.log('Acquiring migration advisory lock…');
  await sql`select pg_advisory_lock(${LOCK_KEY})`;
  try {
    console.log('Applying Drizzle migrations…');
    await migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') });

    console.log('Applying RLS, roles, and append-only triggers…');
    const rls = readFileSync(join(process.cwd(), 'src', 'db', 'rls.sql'), 'utf8');
    await sql.unsafe(rls);

    console.log('Migration complete.');
  } finally {
    await sql`select pg_advisory_unlock(${LOCK_KEY})`;
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
