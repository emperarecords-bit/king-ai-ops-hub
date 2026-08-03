import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureAppSchema } from '../../scripts/bootstrap-prerequisite';
import { ProbeInjectedFailure, tenantIsolationProbe, verifyBootstrap } from '../../scripts/bootstrap-verify';
import { assertDisposableDbForVerification } from '../support/require-disposable-db';
import {
  bootstrapDbAvailable,
  createDisposableDb,
  disposableUrl,
  dropDisposableDb,
  makeBadMigrationsFolder,
  makeTruncatedMigrationsFolder,
} from '../support/bootstrap-db';

/**
 * Hub P1c — fresh-database bootstrap. Proves the reliable-bootstrap contract end to end against DISPOSABLE
 * databases (`king_ai_hub_p1c_*`), never the shared `king_ai_hub`. Refuses the shared DB when the run opts in
 * via REQUIRE_DISPOSABLE_DB=1 (no-op otherwise); skips cleanly when the local Postgres is unreachable.
 */

assertDisposableDbForVerification('bootstrap.test');

const RLS_PATH = join(process.cwd(), 'src', 'db', 'rls.sql');
const DRIZZLE = join(process.cwd(), 'drizzle');
const committedJournalLength = (
  JSON.parse(readFileSync(join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as { entries: unknown[] }
).entries.length;

let available = false;
const created: string[] = [];

beforeAll(async () => {
  available = await bootstrapDbAvailable();
  if (!available) console.warn('[bootstrap.test] SKIPPING — local Postgres not reachable on the maintenance DB.');
});

afterAll(async () => {
  for (const name of created) await dropDisposableDb(name);
}, 60_000);

/** Provision a fresh disposable DB and return its name (tracked for teardown). */
async function fresh(tag: string): Promise<string> {
  const name = `king_ai_hub_p1c_${tag}_${Math.random().toString(36).slice(2, 8)}`;
  await createDisposableDb(name);
  created.push(name);
  return name;
}

/** The migrate.ts CORE path (prerequisite -> drizzle migrate -> rls), with injectable folder/rls for failure tests. */
async function bootstrapCore(
  name: string,
  opts: { migrationsFolder?: string; rlsPath?: string; runRls?: boolean } = {},
): Promise<void> {
  const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
  try {
    await ensureAppSchema(sql);
    await migrate(drizzle(sql), { migrationsFolder: opts.migrationsFolder ?? DRIZZLE });
    if (opts.runRls !== false) await sql.unsafe(readFileSync(opts.rlsPath ?? RLS_PATH, 'utf8'));
  } finally {
    await sql.end();
  }
}

async function journalCount(name: string): Promise<number> {
  const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
  try {
    return (await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]!.n;
  } finally {
    await sql.end();
  }
}

describe('P1c ensureAppSchema (bootstrap prerequisite)', () => {
  it('is idempotent: running twice yields exactly one `app` schema and no error', async () => {
    if (!available) return;
    const name = await fresh('idem');
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      await ensureAppSchema(sql);
      await ensureAppSchema(sql); // second run must be a harmless no-op
      const rows = await sql<{ n: number }[]>`select count(*)::int as n from pg_namespace where nspname = 'app'`;
      expect(rows[0]!.n).toBe(1);
    } finally {
      await sql.end();
    }
  });

  it('makes an otherwise-failing fresh migrate succeed (the root-cause fix)', async () => {
    if (!available) return;
    const name = await fresh('rootcause');
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      // Without the prerequisite, drizzle migrate aborts at 0052 (`schema "app" does not exist`). Drizzle wraps
      // the Postgres error, so the specific cause lives on `.cause`.
      let err: unknown;
      await migrate(drizzle(sql), { migrationsFolder: DRIZZLE }).catch((e) => {
        err = e;
      });
      expect(err).toBeTruthy();
      const msg = `${(err as { message?: string })?.message ?? ''} ${((err as { cause?: { message?: string } })?.cause?.message) ?? ''}`;
      expect(msg).toMatch(/schema "app" does not exist/);
      expect(await journalCount(name)).toBe(0); // clean rollback, nothing journaled
      // With the prerequisite it migrates fully.
      await ensureAppSchema(sql);
      await migrate(drizzle(sql), { migrationsFolder: DRIZZLE });
      expect(await journalCount(name)).toBe(committedJournalLength);
    } finally {
      await sql.end();
    }
  });
});

describe('P1c fresh-database bootstrap', () => {
  it('bootstraps a fresh empty DB fully through the last migration, applying each exactly once', async () => {
    if (!available) return;
    const name = await fresh('full');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      // journal length === committed length, and every applied migration is distinct (no duplicates/fabrication).
      const rows = await sql<{ n: number; distinct: number }[]>`
        select count(*)::int as n, count(distinct hash)::int as distinct from drizzle.__drizzle_migrations`;
      expect(rows[0]!.n).toBe(committedJournalLength);
      expect(rows[0]!.distinct).toBe(committedJournalLength);
    } finally {
      await sql.end();
    }
  });

  it('applies RLS AFTER migrations: app functions + policies exist post-bootstrap and verifyBootstrap passes', async () => {
    if (!available) return;
    const name = await fresh('rls');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      const fns = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
        where ns.nspname = 'app' and p.proname in ('current_user_id','claim_next_run_job','enforce_run_classification')`;
      expect(fns[0]!.n).toBe(3);
      const pol = await sql<{ n: number }[]>`select count(*)::int as n from pg_policies where tablename = 'tasks'`;
      expect(pol[0]!.n).toBeGreaterThan(0);
      const result = await verifyBootstrap(sql);
      expect(result.journalCount).toBe(committedJournalLength);
      expect(result.tenantIsolation.crossTenantRead).toBe(0);
      expect(result.tenantIsolation.crossTenantInsertRejected).toBe(true);
    } finally {
      await sql.end();
    }
  });

  it('leaves ZERO fixtures (0 orgs/projects/agents/tasks/runs) after bootstrap', async () => {
    if (!available) return;
    const name = await fresh('nofix');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      for (const t of ['organizations', 'projects', 'agents', 'tasks', 'runs']) {
        const rows = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(t)}`;
        expect(rows[0]!.n, `${t} should be empty`).toBe(0);
      }
    } finally {
      await sql.end();
    }
  });

  it('a SECOND bootstrap is a no-op apart from verification: no journal growth, no fixtures, no schema churn', async () => {
    if (!available) return;
    const name = await fresh('twice');
    await bootstrapCore(name);
    const first = await journalCount(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      const before = (await sql<{ n: number }[]>`
        select count(*)::int as n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname in ('public','app')`)[0]!.n;
      await bootstrapCore(name); // re-run
      const after = (await sql<{ n: number }[]>`
        select count(*)::int as n from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname in ('public','app')`)[0]!.n;
      expect(await journalCount(name)).toBe(first); // no journal growth
      expect(after).toBe(before); // no schema churn (same relation count)
      const result = await verifyBootstrap(sql);
      expect(result.fixtureCounts.organizations).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it('upgrades an INCREMENTAL DB (migrated only through the penultimate migration) to the latest', async () => {
    if (!available) return;
    const name = await fresh('incr');
    const truncated = makeTruncatedMigrationsFolder(committedJournalLength - 1);
    try {
      // Simulate an already-provisioned DB one migration behind (the prerequisite is harmless on it too).
      await bootstrapCore(name, { migrationsFolder: truncated.folder });
      expect(await journalCount(name)).toBe(committedJournalLength - 1);
      // The real bootstrap applies only the final migration.
      await bootstrapCore(name);
      expect(await journalCount(name)).toBe(committedJournalLength);
    } finally {
      truncated.cleanup();
    }
  });
});

describe('P1c bootstrap failure surfacing', () => {
  it('a MIGRATION failure surfaces (throws)', async () => {
    if (!available) return;
    const name = await fresh('migfail');
    const bad = makeBadMigrationsFolder();
    try {
      await expect(bootstrapCore(name, { migrationsFolder: bad.folder, runRls: false })).rejects.toThrow();
    } finally {
      bad.cleanup();
    }
  });

  it('an RLS-application failure surfaces (throws)', async () => {
    if (!available) return;
    const name = await fresh('rlsfail');
    const badRls = join(mkdtempSync(join(tmpdir(), 'p1c-badrls-')), 'rls.sql');
    writeFileSync(badRls, 'create policy nonsense on nonexistent_table using (true);');
    try {
      await expect(bootstrapCore(name, { rlsPath: badRls })).rejects.toThrow();
    } finally {
      rmSync(join(badRls, '..'), { recursive: true, force: true });
    }
  });

  it('verifyBootstrap THROWS when a fixture is present (fail-closed)', async () => {
    if (!available) return;
    const name = await fresh('fixfail');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      await sql`insert into organizations (id, name, slug) values (gen_random_uuid(), 'Rogue', 'rogue-fixture')`;
      await expect(verifyBootstrap(sql)).rejects.toThrow(/fixtures/);
      await sql`delete from organizations where slug = 'rogue-fixture'`;
    } finally {
      await sql.end();
    }
  });
});

describe('P1c rollback-only tenant-isolation probe', () => {
  /** The tenant tables the probe seeds; after a rolled-back probe every one of them must be untouched. */
  const PROBE_TABLES = ['profiles', 'organizations', 'memberships', 'projects', 'project_members', 'agents'] as const;

  async function counts(sql: postgres.Sql): Promise<Record<string, number>> {
    const out: Record<string, number> = {};
    for (const t of PROBE_TABLES) out[t] = (await sql<{ n: number }[]>`select count(*)::int as n from ${sql(t)}`)[0]!.n;
    return out;
  }

  it('(a) SUCCESS leaves zero probe rows (rolled back), and is non-vacuous under app_server', async () => {
    if (!available) return;
    const name = await fresh('probe_ok');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      const before = await counts(sql);
      const { isolation, ids } = await tenantIsolationProbe(sql);
      // Non-vacuous: B EXISTS in-txn (seeded) yet is HIDDEN by RLS; the same-tenant select saw ≥1 and the
      // cross-tenant insert was rejected — impossible if the assertions had run under an RLS-bypass identity.
      expect(isolation.sameTenantSelect).toBeGreaterThanOrEqual(1);
      expect(isolation.crossTenantRead).toBe(0);
      expect(isolation.sameTenantInsert).toBe(true);
      expect(isolation.crossTenantInsertRejected).toBe(true);
      expect(await counts(sql)).toEqual(before); // rollback = cleanup; not one probe row persisted
      // The generated ids are returned so the caller can prove zero residue; none may be found on a fresh read.
      for (const idVal of Object.values(ids)) {
        const n = (await sql<{ n: number }[]>`select count(*)::int as n from agents where id::text = ${idVal}
          union all select count(*)::int from organizations where id::text = ${idVal}
          union all select count(*)::int from projects where id::text = ${idVal}`).reduce((a, r) => a + r.n, 0);
        expect(n).toBe(0);
      }
    } finally {
      await sql.end();
    }
  });

  it('(b) failure AFTER insert but BEFORE role switch → throws, zero rows', async () => {
    if (!available) return;
    const name = await fresh('probe_ins');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      const before = await counts(sql);
      await expect(tenantIsolationProbe(sql, { injectFailAfter: 'insert' })).rejects.toBeInstanceOf(ProbeInjectedFailure);
      expect(await counts(sql)).toEqual(before);
    } finally {
      await sql.end();
    }
  });

  it('(c) failure AFTER role switch → throws, zero rows', async () => {
    if (!available) return;
    const name = await fresh('probe_role');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      const before = await counts(sql);
      await expect(tenantIsolationProbe(sql, { injectFailAfter: 'role' })).rejects.toBeInstanceOf(ProbeInjectedFailure);
      expect(await counts(sql)).toEqual(before);
    } finally {
      await sql.end();
    }
  });

  it('(d) failure AFTER the same-tenant assertion → throws, zero rows', async () => {
    if (!available) return;
    const name = await fresh('probe_same');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      const before = await counts(sql);
      await expect(tenantIsolationProbe(sql, { injectFailAfter: 'same_tenant' })).rejects.toBeInstanceOf(ProbeInjectedFailure);
      expect(await counts(sql)).toEqual(before);
    } finally {
      await sql.end();
    }
  });

  it('(e) failure AFTER the cross-tenant rejection → throws, zero rows', async () => {
    if (!available) return;
    const name = await fresh('probe_cross');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      const before = await counts(sql);
      await expect(tenantIsolationProbe(sql, { injectFailAfter: 'cross_reject' })).rejects.toBeInstanceOf(ProbeInjectedFailure);
      expect(await counts(sql)).toEqual(before);
    } finally {
      await sql.end();
    }
  });

  it('(f) a NON-ASSUMABLE role fails CLOSED — clear error, zero residue, NO fallback to owner', async () => {
    if (!available) return;
    const name = await fresh('probe_norole');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      const before = await counts(sql);
      // 'nonexistent_probe_role' cannot be assumed → SET LOCAL ROLE throws → probe throws a clear operational error.
      await expect(
        tenantIsolationProbe(sql, { roleName: 'nonexistent_probe_role' }),
      ).rejects.toThrow(/cannot assume nonexistent_probe_role.*will not fall back to an RLS-bypass role/s);
      // Fail-closed: the seed rows (inserted before the failed switch) were rolled back — NOT committed via any
      // owner/superuser fallback. Every probe table is byte-for-byte as before.
      expect(await counts(sql)).toEqual(before);
      // verifyBootstrap surfaces the same fail-closed error (nonzero → throw).
      await expect(
        verifyBootstrap(sql, { roleName: 'nonexistent_probe_role' }),
      ).rejects.toThrow(/cannot assume nonexistent_probe_role/);
    } finally {
      await sql.end();
    }
  });

  it('(g) running verify TWICE leaves zero residue both times', async () => {
    if (!available) return;
    const name = await fresh('probe_twice');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      const r1 = await verifyBootstrap(sql);
      expect(Object.values(r1.probeResidue).every((n) => n === 0)).toBe(true);
      const r2 = await verifyBootstrap(sql);
      expect(Object.values(r2.probeResidue).every((n) => n === 0)).toBe(true);
      // Both runs left the tenant tables empty (no accumulation across runs).
      const c = await counts(sql);
      expect(c.agents).toBe(0);
      expect(c.organizations).toBe(0);
    } finally {
      await sql.end();
    }
  });

  it('(h) pre-existing COMMITTED legit tenant data is byte-for-byte unchanged by the probe', async () => {
    if (!available) return;
    const name = await fresh('probe_legit');
    await bootstrapCore(name);
    const sql = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
    try {
      // Seed ONE committed legit org before the probe runs.
      const legitId = (await sql<{ id: string }[]>`
        insert into organizations (id, name, slug) values (gen_random_uuid(), 'Legit Co', 'legit-co')
        returning id`)[0]!.id;
      const rowBefore = (await sql`select id, name, slug from organizations where id = ${legitId}`)[0];

      const { ids } = await tenantIsolationProbe(sql);

      // The legit row is unchanged; no probe org was added; probe tenant tables are empty apart from the legit org.
      const rowAfter = (await sql`select id, name, slug from organizations where id = ${legitId}`)[0];
      expect(rowAfter).toEqual(rowBefore);
      expect((await sql<{ n: number }[]>`select count(*)::int as n from organizations`)[0]!.n).toBe(1);
      expect((await sql<{ n: number }[]>`select count(*)::int as n from agents`)[0]!.n).toBe(0);
      // And none of the probe's identifiers persisted.
      const probeOrg = (await sql<{ n: number }[]>`select count(*)::int as n from organizations where id::text = ${ids.org}`)[0]!.n;
      expect(probeOrg).toBe(0);

      await sql`delete from organizations where id = ${legitId}`;
    } finally {
      await sql.end();
    }
  });
});

describe('P1c bootstrap does not fabricate journal rows', () => {
  it('never inserts into __drizzle_migrations from bootstrap source', () => {
    for (const f of ['scripts/bootstrap-prerequisite.ts', 'scripts/bootstrap-verify.ts', 'scripts/migrate.ts']) {
      const src = readFileSync(join(process.cwd(), f), 'utf8').toLowerCase();
      // The only permitted contact with the journal table is READING its row count — never an INSERT/UPDATE/DELETE.
      expect(src).not.toMatch(/(insert\s+into|update|delete\s+from)\s+(drizzle\.)?__drizzle_migrations/);
    }
  });
});

describe('P1c standard command (scripts/migrate.ts) — env + exit behavior', () => {
  it('fails BEFORE any connection when both DB URLs are missing (nonzero exit, clear message)', () => {
    const env: Record<string, string | undefined> = { ...process.env, SKIP_PREMIGRATION_BACKUP: '1' };
    delete env.DATABASE_MIGRATION_URL;
    delete env.DATABASE_URL;
    const r = spawnSync('npx', ['tsx', 'scripts/migrate.ts'], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', shell: true });
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}${r.stdout}`).toMatch(/must be set/);
  });

  it('runs the full bootstrap+verify path via `--verify` on a fresh disposable DB (exit 0, verified)', async () => {
    if (!available) return;
    const name = await fresh('cmd');
    const env: Record<string, string | undefined> = {
      ...process.env,
      SKIP_PREMIGRATION_BACKUP: '1',
      DATABASE_MIGRATION_URL: disposableUrl(name),
      DATABASE_URL: disposableUrl(name),
      // The reconciled migrate.ts runs the B2a pre-migration gate BEFORE ensureAppSchema. Declare this fresh
      // disposable database as a catalog-verified bootstrap (identity == the DB name the gate reads via
      // current_database()) so the gate takes its bootstrap_bypass path — no signed receipt, no gate bypass.
      GBACKUP_DECLARED_BOOTSTRAP: '1',
      GBACKUP_EXPECTED_DB_IDENTITY: name,
    };
    const r = spawnSync('npx', ['tsx', 'scripts/migrate.ts', '--verify'], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', shell: true });
    expect(`${r.stderr}${r.stdout}`).toMatch(/Bootstrap verified/);
    expect(r.status).toBe(0);
  }, 60_000);
});
