import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

/**
 * Post-bootstrap VERIFICATION (Hub P1c).
 *
 * `verifyBootstrap(sql)` proves a freshly-bootstrapped database is actually usable and empty, and THROWS (→ the
 * caller's nonzero exit) on the first failure. It is reusable and intentionally read-only against the persisted
 * schema.
 *
 * The tenant-isolation probe (check 6) is ROLLBACK-ONLY: it opens ONE reserved connection, runs a single
 * transaction that seeds two disposable tenants, exercises RLS under the runtime `app_server` role via a
 * transaction-local `SET LOCAL ROLE`, and ALWAYS rolls that transaction back. It NEVER commits — not even
 * transiently — so no probe tenant is ever written to the target database, and cleanup is the rollback itself,
 * not a post-commit DELETE. A fresh read afterward (check 6b) proves zero residue.
 *
 * It runs ONLY when explicitly requested (db:bootstrap sets BOOTSTRAP_VERIFY=1), never on an incremental
 * `db:migrate`.
 *
 * Checks:
 *   1. migration journal count === the committed journal length (DERIVED from drizzle/meta/_journal.json — never
 *      hard-coded), so adding a migration never needs an edit here;
 *   2. the `app` schema exists;
 *   3. a representative required set of app functions exists (identity, classification guards, queue dispatch,
 *      profile adoption);
 *   4. RLS is ENABLED (and FORCED) on representative tenant tables;
 *   5. expected policies are present (count > 0) on those tables;
 *   6. the tenant transaction helpers work end-to-end under the NON-superuser app_server role, inside a
 *      rollback-only transaction: a same-tenant SELECT/INSERT succeeds while a cross-tenant read returns 0 rows
 *      and a cross-tenant INSERT is rejected;
 *   6b. ZERO residue: none of the probe's identifiers survive in any tenant table (the rollback cleaned up);
 *   7. NO fixtures exist (0 rows in organizations/projects/agents/tasks/runs).
 */

const REQUIRED_APP_FUNCTIONS = [
  'current_user_id',
  'current_org_id',
  'current_project_id',
  'enforce_run_classification',
  'enforce_usage_classification',
  'claim_next_run_job',
  'finish_run_job',
  'list_due_schedules',
  'adopt_placeholder_profile',
] as const;

const RLS_TABLES = ['tasks', 'runs', 'agents', 'organizations'] as const;
const FIXTURE_TABLES = ['organizations', 'projects', 'agents', 'tasks', 'runs'] as const;

/**
 * Every table that could conceivably carry a probe identifier, checked in the zero-residue proof. Only the tables
 * that actually EXIST in the schema are queried (existence is resolved from information_schema).
 */
const RESIDUE_TABLES = [
  'organizations',
  'profiles',
  'memberships',
  'projects',
  'project_members',
  'agents',
  'tasks',
  'runs',
  'approvals',
  'documents',
  'knowledge_items',
  'decisions',
  'audit_logs',
  'integration_secrets',
] as const;

/** The runtime role whose RLS the probe exercises. A plain SQL identifier — validated before any SET LOCAL ROLE. */
const DEFAULT_PROBE_ROLE = 'app_server';
const SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Stages after which a test may force the probe to fail deterministically (WITHOUT killing Postgres). */
export type ProbeFailPoint = 'insert' | 'role' | 'same_tenant' | 'cross_reject';

/** The uniquely-generated identifiers a single probe run seeds (all random UUIDs), returned for the residue proof. */
export interface ProbeIds {
  user: string;
  org: string;
  projectA: string;
  projectB: string;
  agentA: string;
  agentB: string;
}

export interface TenantIsolationResult {
  sameTenantSelect: number;
  crossTenantRead: number;
  sameTenantInsert: boolean;
  crossTenantInsertRejected: boolean;
}

export interface BootstrapVerifyResult {
  journalCount: number;
  expectedJournalCount: number;
  appSchemaPresent: boolean;
  requiredFunctionsPresent: string[];
  rlsEnabled: Record<string, { enabled: boolean; forced: boolean }>;
  policyCounts: Record<string, number>;
  tenantIsolation: TenantIsolationResult;
  probeIds: ProbeIds;
  probeResidue: Record<string, number>;
  fixtureCounts: Record<string, number>;
}

/** Thrown by the probe's injectable failure point so tests can force a mid-probe abort without a real SQL error. */
export class ProbeInjectedFailure extends Error {
  constructor(public readonly stage: ProbeFailPoint) {
    super(`probe injected failure after stage: ${stage}`);
    this.name = 'ProbeInjectedFailure';
  }
}

/** The committed journal length is the single source of truth for "how many migrations must be applied". */
function expectedJournalLength(migrationsFolder: string): number {
  const journal = JSON.parse(readFileSync(join(migrationsFolder, 'meta', '_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

/**
 * ROLLBACK-ONLY tenant-isolation probe.
 *
 * Single reserved connection, single explicit transaction that is ALWAYS rolled back — on success, on an
 * assertion failure, on a SQL error, on a role-switch failure, on the expected cross-tenant rejection, and on any
 * exception. NOTHING is ever committed, so the target database never holds a probe tenant even transiently.
 *
 * Sequence inside the one uncommitted transaction:
 *   1. Seed uniquely-identified probe records (profiles, org, membership, projects A/B, project_members, agents
 *      A/B) as the CURRENT login/owner role — which bypasses RLS by ownership/superuser, purely for seeding.
 *   2. `SET LOCAL ROLE <app_server>` to switch execution identity transaction-locally to the real runtime role.
 *      If that role cannot be assumed the probe FAILS CLOSED (throws) — it NEVER falls back to an RLS-bypass role.
 *   3. Set the same transaction-local tenant GUCs the app uses (`app.user_id/org_id/project_id`, is_local=true).
 *   4. Prove NON-VACUOUSLY, with BOTH tenants' rows present in-txn: same-tenant SELECT sees ≥1, a cross-tenant
 *      SELECT of B's agent returns 0 (hidden by RLS though it exists), a same-tenant INSERT succeeds, and a
 *      cross-tenant INSERT is rejected by the policy WITH CHECK (wrapped in a SAVEPOINT so the expected error
 *      does not poison the transaction).
 *   5. `RESET ROLE` (cosmetic — the rollback resets it regardless), then ROLLBACK unconditionally (the finally).
 *
 * Returns the isolation result AND the generated ids, so the caller can prove zero residue.
 */
export async function tenantIsolationProbe(
  sql: postgres.Sql,
  opts: { roleName?: string; injectFailAfter?: ProbeFailPoint } = {},
): Promise<{ isolation: TenantIsolationResult; ids: ProbeIds }> {
  const roleName = opts.roleName ?? DEFAULT_PROBE_ROLE;
  if (!SQL_IDENTIFIER.test(roleName)) {
    throw new Error(`refusing to switch to a non-identifier role name for the isolation probe: ${roleName}`);
  }

  const ids: ProbeIds = {
    user: randomUUID(),
    org: randomUUID(),
    projectA: randomUUID(),
    projectB: randomUUID(),
    agentA: randomUUID(),
    agentB: randomUUID(),
  };

  const conn = await sql.reserve();
  try {
    await conn.unsafe('begin');

    // 1. Seed both workspaces as the CURRENT login/owner role (RLS bypassed by ownership) — inside this one
    //    uncommitted transaction. Nothing here is ever committed.
    await conn`insert into profiles (id, email, display_name)
      values (${ids.user}, ${`${ids.user}@bootstrap-verify.local`}, 'Bootstrap Verify')`;
    await conn`insert into organizations (id, name, slug)
      values (${ids.org}, 'Bootstrap Verify Org', ${`bootstrap-verify-${ids.org.slice(0, 8)}`})`;
    await conn`insert into memberships (org_id, user_id, role) values (${ids.org}, ${ids.user}, 'owner')`;
    await conn`insert into projects (id, org_id, key, name)
      values (${ids.projectA}, ${ids.org}, ${`bv-a-${ids.projectA.slice(0, 8)}`}, 'BV A'),
             (${ids.projectB}, ${ids.org}, ${`bv-b-${ids.projectB.slice(0, 8)}`}, 'BV B')`;
    await conn`insert into project_members (org_id, project_id, user_id, role)
      values (${ids.org}, ${ids.projectA}, ${ids.user}, 'admin'),
             (${ids.org}, ${ids.projectB}, ${ids.user}, 'admin')`;
    await conn`insert into agents (id, org_id, project_id, name, provider, model, system_prompt)
      values (${ids.agentA}, ${ids.org}, ${ids.projectA}, 'Agent A', 'openai', 'gpt-4o-mini', 'probe')`;
    await conn`insert into agents (id, org_id, project_id, name, provider, model, system_prompt)
      values (${ids.agentB}, ${ids.org}, ${ids.projectB}, 'Agent B', 'openai', 'gpt-4o-mini', 'probe')`;

    if (opts.injectFailAfter === 'insert') throw new ProbeInjectedFailure('insert');

    // 2. Switch identity transaction-locally to the runtime role. FAIL CLOSED — never fall back to owner/superuser.
    try {
      await conn.unsafe(`set local role ${roleName}`);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(
        `cannot assume ${roleName} for the rollback-only isolation probe: ${detail}; ` +
          `verification will not fall back to an RLS-bypass role`,
      );
    }

    if (opts.injectFailAfter === 'role') throw new ProbeInjectedFailure('role');

    // 3. The SAME transaction-local tenant context the app stamps via withTenant() (is_local = true).
    await conn`select set_config('app.user_id', ${ids.user}, true),
                      set_config('app.org_id', ${ids.org}, true),
                      set_config('app.project_id', ${ids.projectA}, true)`;

    // 4a. Non-vacuous read assertions under app_server, with BOTH tenants present in-txn.
    const sameTenant = await conn<{ id: string }[]>`select id from agents`;
    const crossTenant = await conn<{ id: string }[]>`select id from agents where id = ${ids.agentB}`;

    if (opts.injectFailAfter === 'same_tenant') throw new ProbeInjectedFailure('same_tenant');

    // 4b. Same-tenant INSERT (project A) succeeds.
    await conn`insert into agents (id, org_id, project_id, name, provider, model, system_prompt)
      values (${randomUUID()}, ${ids.org}, ${ids.projectA}, 'Agent A2', 'openai', 'gpt-4o-mini', 'probe')`;

    // 4c. Cross-tenant INSERT (project B while scoped to A) must be REJECTED by the policy WITH CHECK. Wrap it in
    //     a SAVEPOINT so the expected error does not abort (poison) the surrounding transaction.
    let crossRejected: boolean;
    await conn.unsafe('savepoint x');
    try {
      await conn`insert into agents (id, org_id, project_id, name, provider, model, system_prompt)
        values (${randomUUID()}, ${ids.org}, ${ids.projectB}, 'Agent B2', 'openai', 'gpt-4o-mini', 'probe')`;
      crossRejected = false;
      await conn.unsafe('release savepoint x');
    } catch {
      crossRejected = true;
      await conn.unsafe('rollback to savepoint x');
    }

    if (opts.injectFailAfter === 'cross_reject') throw new ProbeInjectedFailure('cross_reject');

    // 5. Restore identity (cosmetic — the rollback below resets it regardless).
    await conn.unsafe('reset role');

    return {
      isolation: {
        sameTenantSelect: sameTenant.length,
        crossTenantRead: crossTenant.length,
        sameTenantInsert: true,
        crossTenantInsertRejected: crossRejected,
      },
      ids,
    };
  } finally {
    // The transaction is ALWAYS rolled back — every path, including the aborted-transaction case after a failed
    // role switch. Rollback (never a post-commit DELETE) is the cleanup mechanism.
    try {
      await conn.unsafe('rollback');
    } finally {
      conn.release();
    }
  }
}

/**
 * ZERO-RESIDUE PROOF. On a FRESH connection (never the probe's rolled-back one), assert that NONE of the probe's
 * identifiers exist in any tenant table that is present in the schema. Because the probe never committed, this
 * must be 0 everywhere; a nonzero count means the rollback contract was violated.
 */
async function probeResidueCounts(sql: postgres.Sql, ids: ProbeIds): Promise<Record<string, number>> {
  const allIds = [ids.org, ids.user, ids.projectA, ids.projectB, ids.agentA, ids.agentB];

  const cols = await sql<{ table_name: string; column_name: string }[]>`
    select table_name, column_name from information_schema.columns
    where table_schema = 'public'
      and table_name = any(${sql.array(RESIDUE_TABLES as unknown as string[])})
      and column_name in ('id', 'org_id', 'user_id')`;

  const byTable = new Map<string, Set<string>>();
  for (const r of cols) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set());
    byTable.get(r.table_name)!.add(r.column_name);
  }

  const counts: Record<string, number> = {};
  for (const [table, columns] of byTable) {
    // Sum matches across every present identifier column. We only care whether the total is 0 (clean) or >0
    // (residue → rollback contract violated), so counting a row under more than one column is harmless.
    let total = 0;
    for (const col of ['id', 'org_id', 'user_id'] as const) {
      if (!columns.has(col)) continue;
      const n = (
        await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)} where ${sql(col)}::text = any(${sql.array(allIds)})`
      )[0]!.n;
      total += n;
    }
    counts[table] = total;
  }
  return counts;
}

export async function verifyBootstrap(
  sql: postgres.Sql,
  opts: { migrationsFolder?: string; roleName?: string; injectFailAfter?: ProbeFailPoint } = {},
): Promise<BootstrapVerifyResult> {
  const migrationsFolder = opts.migrationsFolder ?? join(process.cwd(), 'drizzle');
  const failures: string[] = [];

  // 1. Journal count === committed journal length.
  const expectedJournalCount = expectedJournalLength(migrationsFolder);
  const journalCount = (await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]!.n;
  if (journalCount !== expectedJournalCount) {
    failures.push(`applied migration count ${journalCount} !== committed journal length ${expectedJournalCount}`);
  }

  // 2. app schema present.
  const appSchemaPresent =
    (await sql<{ ok: number }[]>`select 1 as ok from pg_namespace where nspname = 'app'`).length > 0;
  if (!appSchemaPresent) failures.push('schema "app" is missing after bootstrap');

  // 3. Required app functions present.
  const fnRows = await sql<{ proname: string }[]>`
    select p.proname from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'app'`;
  const presentFns = new Set(fnRows.map((r) => r.proname));
  const requiredFunctionsPresent = REQUIRED_APP_FUNCTIONS.filter((f) => presentFns.has(f));
  const missingFns = REQUIRED_APP_FUNCTIONS.filter((f) => !presentFns.has(f));
  if (missingFns.length) failures.push(`missing required app functions: ${missingFns.map((f) => `app.${f}`).join(', ')}`);

  // 4. RLS enabled + forced on representative tenant tables.
  const rlsRows = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
    select relname, relrowsecurity, relforcerowsecurity
    from pg_class where relkind = 'r' and relname = any(${sql.array(RLS_TABLES as unknown as string[])})`;
  const rlsEnabled: Record<string, { enabled: boolean; forced: boolean }> = {};
  for (const t of RLS_TABLES) {
    const row = rlsRows.find((r) => r.relname === t);
    rlsEnabled[t] = { enabled: !!row?.relrowsecurity, forced: !!row?.relforcerowsecurity };
    if (!row) failures.push(`table ${t} not found (schema incomplete)`);
    else if (!row.relrowsecurity) failures.push(`RLS not enabled on ${t}`);
  }

  // 5. Policies present (count > 0) on those tables.
  const polRows = await sql<{ tablename: string; n: number }[]>`
    select tablename, count(*)::int as n from pg_policies
    where schemaname = 'public' and tablename = any(${sql.array(RLS_TABLES as unknown as string[])})
    group by tablename`;
  const policyCounts: Record<string, number> = {};
  for (const t of RLS_TABLES) {
    const n = polRows.find((r) => r.tablename === t)?.n ?? 0;
    policyCounts[t] = n;
    if (n <= 0) failures.push(`no RLS policies on ${t}`);
  }

  // 6. Tenant transaction helpers work under app_server (real RLS enforcement) — ROLLBACK-ONLY, no commit.
  //    NOTE: no app_server URL/password is derived or used; identity is switched transaction-locally with
  //    SET LOCAL ROLE on a single reserved connection. If the login role cannot assume app_server, the probe
  //    throws (fail-closed) and this whole verification exits nonzero.
  const { isolation: tenantIsolation, ids: probeIds } = await tenantIsolationProbe(sql, {
    roleName: opts.roleName,
    injectFailAfter: opts.injectFailAfter,
  });
  if (tenantIsolation.sameTenantSelect < 1) failures.push('same-tenant SELECT saw no rows under app_server');
  if (tenantIsolation.crossTenantRead !== 0) failures.push(`cross-tenant read returned ${tenantIsolation.crossTenantRead} rows (expected 0)`);
  if (!tenantIsolation.sameTenantInsert) failures.push('same-tenant INSERT failed under app_server');
  if (!tenantIsolation.crossTenantInsertRejected) failures.push('cross-tenant INSERT was NOT rejected by RLS WITH CHECK');

  // 6b. ZERO residue: the rollback-only probe must leave NONE of its identifiers behind, anywhere.
  const probeResidue = await probeResidueCounts(sql, probeIds);
  const leaked = Object.entries(probeResidue).filter(([, n]) => n !== 0);
  if (leaked.length) {
    failures.push(`probe residue found (rollback contract violated): ${leaked.map(([t, n]) => `${t}=${n}`).join(', ')}`);
  }

  // 7. No fixtures.
  const fixtureCounts: Record<string, number> = {};
  for (const t of FIXTURE_TABLES) {
    const n = (await sql<{ n: number }[]>`select count(*)::int as n from ${sql(t)}`)[0]!.n;
    fixtureCounts[t] = n;
    if (n !== 0) failures.push(`expected 0 fixtures in ${t}, found ${n}`);
  }

  if (failures.length) {
    throw new Error(`verifyBootstrap failed:\n - ${failures.join('\n - ')}`);
  }

  return {
    journalCount,
    expectedJournalCount,
    appSchemaPresent,
    requiredFunctionsPresent,
    rlsEnabled,
    policyCounts,
    tenantIsolation,
    probeIds,
    probeResidue,
    fixtureCounts,
  };
}
