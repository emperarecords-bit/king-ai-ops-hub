import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres, { type Sql } from 'postgres';
import {
  type GateConfig,
  type GateDbProbe,
  finalizeMigrationConnection,
  loadReleaseSourceInputs,
  resolveGateEnvironment,
  runPreMigrationGate,
} from './backup/premigration-gate';
import { createHttpsReceiptFetcher } from './backup/receipt-transport';

/**
 * G-Backup-B2a — the pre-migration VERIFICATION GATE replaces the old Windows-only best-effort backup. Before ANY
 * database mutation (`migrate()` and `src/db/rls.sql`), the gate runs UNDER the advisory lock and must resolve to a
 * verdict; on staging it is fail-closed (a non-empty database requires a valid signed receipt). Only a catalog-
 * verified bootstrap-empty database or an explicit local/dev/test bypass may proceed without a receipt.
 *
 * This release path is a CONSUMER only: it never signs a receipt and never holds Fly snapshot authority.
 */

const SOURCE_IDENTITY_PATH = join(process.cwd(), 'source-identity.json');

function parseHostAllowlist(v: string | undefined): ReadonlySet<string> | undefined {
  if (!v) return undefined;
  const hosts = v.split(',').map((h) => h.trim()).filter((h) => h.length > 0);
  return hosts.length > 0 ? new Set(hosts) : new Set();
}

function parseTrustBundle(v: string | undefined): readonly unknown[] | undefined {
  if (!v) return undefined;
  const parsed = JSON.parse(v) as unknown; // a malformed bundle throws here → fail-closed exit(1)
  if (!Array.isArray(parsed)) throw new Error('GBACKUP_RECEIPT_TRUST_BUNDLE must be a JSON array');
  return parsed;
}

function intEnv(v: string | undefined, dflt: number): number {
  if (v === undefined || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`expected a non-negative integer, got ${JSON.stringify(v)}`);
  return n;
}

function buildGateConfigFromEnv(): GateConfig {
  const env = process.env;
  const environment = resolveGateEnvironment({ gbackupEnvironment: env.GBACKUP_ENVIRONMENT, flyAppName: env.FLY_APP_NAME });
  const flyRuntimePresent = Boolean(env.FLY_APP_NAME || env.FLY_MACHINE_ID || env.FLY_ALLOC_ID || env.FLY_IMAGE_REF);
  return {
    environment,
    bypass: env.GBACKUP_GATE_BYPASS === '1',
    flyRuntimePresent,
    declaredBootstrap: env.GBACKUP_DECLARED_BOOTSTRAP === '1',
    expectedDatabaseIdentity: env.GBACKUP_EXPECTED_DB_IDENTITY ?? '',
    deploymentNonce: env.DEPLOYMENT_NONCE,
    receiptBaseUrl: env.GBACKUP_RECEIPT_BASE_URL,
    hostAllowlist: parseHostAllowlist(env.GBACKUP_RECEIPT_HOSTS),
    trustBundleEntries: parseTrustBundle(env.GBACKUP_RECEIPT_TRUST_BUNDLE),
    targetApplication: env.GBACKUP_TARGET_APPLICATION ?? env.FLY_APP_NAME,
    databaseApp: env.GBACKUP_DATABASE_APP,
    sourceVolumeId: env.GBACKUP_SOURCE_VOLUME_ID,
    expectedImageRef: env.FLY_IMAGE_REF,
    minRetentionDays: intEnv(env.GBACKUP_MIN_RETENTION_DAYS, 7),
    maxSnapshotAgeMs: intEnv(env.GBACKUP_MAX_SNAPSHOT_AGE_MS, 30 * 60 * 1000),
    transportMaxBytes: intEnv(env.GBACKUP_TRANSPORT_MAX_BYTES, 64 * 1024),
    transportTimeoutMs: intEnv(env.GBACKUP_TRANSPORT_TIMEOUT_MS, 2000),
  };
}

/** Read-only, git-independent catalog probe over the migration connection. */
function createPostgresGateProbe(sql: Sql): GateDbProbe {
  return {
    async migrationsTableMissing() {
      const r = await sql<{ t: string | null }[]>`select to_regclass('drizzle.__drizzle_migrations')::text as t`;
      return r[0]?.t == null;
    },
    async appliedRows() {
      const rows = await sql<{ id: number; hash: string; created_at: string }[]>`
        select id, hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at asc, id asc`;
      return rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at), id: r.id ?? null }));
    },
    async hasUnexplainedUserObjects() {
      const rel = await sql<{ n: number }[]>`
        select count(*)::int as n
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p','S','v','m')
          and n.nspname not in ('pg_catalog','information_schema','pg_toast')
          and n.nspname not like 'pg\\_temp\\_%' and n.nspname not like 'pg\\_toast\\_temp\\_%'
          and not exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')`;
      const fn = await sql<{ n: number }[]>`
        select count(*)::int as n
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog','information_schema','pg_toast')
          and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')`;
      return (rel[0]?.n ?? 0) > 0 || (fn[0]?.n ?? 0) > 0;
    },
    async currentDatabase() {
      const r = await sql<{ d: string }[]>`select current_database() as d`;
      return r[0]?.d ?? '';
    },
    async systemIdentifier() {
      const r = await sql<{ s: string }[]>`select system_identifier::text as s from pg_control_system()`;
      return r[0]?.s ?? '';
    },
  };
}

/**
 * Applies Drizzle migrations, then the hand-written RLS/trigger layer.
 * Uses the MIGRATION connection (DDL rights), never the app role.
 */
async function main() {
  const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_MIGRATION_URL or DATABASE_URL must be set.');

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const db = drizzle(sql);

  // Concurrency protection: a session-level advisory lock so two deploy tasks
  // (e.g. two web instances booting at once) cannot run migrations
  // simultaneously. The second waits; when it acquires the lock the migrations
  // are already applied and Drizzle's journal makes re-application a no-op.
  const LOCK_KEY = 4021; // arbitrary, stable per-app
  let locked = false;
  let primaryError: unknown = null;
  try {
    console.log('Acquiring migration advisory lock…');
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    locked = true;

    // Pre-migration verification gate — UNDER the lock, BEFORE any mutation. Fail-closed on staging.
    const config = buildGateConfigFromEnv();
    const fetcher = createHttpsReceiptFetcher({
      maxBytes: config.transportMaxBytes,
      timeoutMs: config.transportTimeoutMs,
      hostAllowlist: config.hostAllowlist ?? new Set(),
    });
    console.log(`Pre-migration gate (environment=${config.environment})…`);
    const verdict = await runPreMigrationGate({
      config,
      loadSource: () => loadReleaseSourceInputs(process.cwd(), SOURCE_IDENTITY_PATH, 'drizzle'),
      probe: createPostgresGateProbe(sql),
      fetcher,
      now: new Date(),
    });
    console.log(`Pre-migration gate passed: ${verdict.mode} — ${verdict.detail}`);

    console.log('Applying Drizzle migrations…');
    await migrate(db, { migrationsFolder: join(process.cwd(), 'drizzle') });

    console.log('Applying RLS, roles, and append-only triggers…');
    const rls = readFileSync(join(process.cwd(), 'src', 'db', 'rls.sql'), 'utf8');
    await sql.unsafe(rls);

    console.log('Migration complete.');
  } catch (e) {
    primaryError = e;
  }
  // Cleanup on every post-acquisition path: unlock (if locked) then close, always both; a cleanup failure never
  // masks an earlier gate/migrate/rls failure, and surfaces on its own when nothing else failed.
  await finalizeMigrationConnection(primaryError, {
    locked,
    unlock: () => sql`select pg_advisory_unlock(${LOCK_KEY})`.then(() => undefined),
    end: () => sql.end(),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
