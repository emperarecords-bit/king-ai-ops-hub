import type postgres from 'postgres';

/**
 * Fresh-database bootstrap PREREQUISITE (Hub P1c).
 *
 * A fresh, empty database fails to migrate: `drizzle/0052_classification_guard.sql` is the ONLY migration that
 * references the `app` schema (`CREATE OR REPLACE FUNCTION app.enforce_run_classification()` and three more
 * `app.*` references), yet NO migration ever creates `app`. The schema is created only by `src/db/rls.sql`
 * (`create schema if not exists app`), which `scripts/migrate.ts` applies AFTER `migrate()`. So on an empty DB
 * `migrate()` aborts at 0052 with `ERROR: schema "app" does not exist` before Drizzle can journal it — the whole
 * migrate() rolls back cleanly (0 journal rows, no `app` schema). Incremental databases already carry `app` from
 * a prior rls.sql run, which is why the gap only ever bites a truly fresh database.
 *
 * The fix is a one-line schema pre-creation that runs BEFORE `migrate()`. It deliberately lives in the bootstrap
 * PATH — not in a new migration — so migrations 0000–0055 (and their snapshots/journal) stay byte-for-byte
 * unchanged, and so this same prerequisite can slot behind the future G-Backup-B2a premigration-backup gate as a
 * reusable seam ([B2a gate] -> ensureAppSchema -> migrate -> rls -> verify).
 */

/**
 * Ensure the `app` schema exists. Idempotent and transaction-safe.
 *
 * The identifier `app` is a FIXED source constant baked into this statement — it is never user input and is
 * never interpolated into the SQL, so there is no injection surface. `create schema if not exists` makes the
 * call a no-op when `app` already exists, so it is safe on BOTH an empty database and one that has already been
 * migrated. It creates no fixture, sample, or tenant data — only the empty schema the migrations require.
 */
export async function ensureAppSchema(sql: postgres.Sql): Promise<void> {
  await sql`create schema if not exists app`;
}
