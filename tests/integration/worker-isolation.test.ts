import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ProjectRole, type TenantContext } from '@/types/domain';
import { adminSql, appUrl, rlsAvailable } from '@tests/support/db';

/**
 * O-22 acceptance Test 5 — worker job isolation under the app_server role.
 *
 * Two workspaces (A, B) each get a queued run job. The REAL worker code
 * (src/domain/jobs/jobs.ts) claims and restores tenant context per job while
 * connected as app_server over a shared pool. We assert: each job carries only
 * its own tenant identity, no tenant GUC leaks between jobs or onto the pool,
 * and a job with a missing tenant identity fails closed (never runs).
 *
 * To exercise jobs.ts AS app_server we point DATABASE_URL at app_server for the
 * duration of this file and reset the cached pool, restoring both afterward so
 * sibling test files keep their migration-role connection.
 */

const available = await rlsAvailable('worker-isolation.test');

const originalDbUrl = process.env.DATABASE_URL;
if (available) {
  process.env.DATABASE_URL = appUrl();
  // Force src/db/client to build a FRESH pool from the app_server URL.
  delete (globalThis as unknown as { __kingDbPool?: unknown }).__kingDbPool;
}

// Import the code under test AFTER DATABASE_URL points at app_server.
const { claimJobForTask, runClaimedJob, reconcileStaleJobs } = await import('@/domain/jobs/jobs');
const { withTenant } = await import('@/db/tenant');
const { getDb } = await import('@/db/client');
const { tasks } = await import('@/db/schema');
const { sql } = await import('drizzle-orm');

const ids = {
  userA: randomUUID(),
  userB: randomUUID(),
  orgA: randomUUID(),
  orgB: randomUUID(),
  projA: randomUUID(),
  projB: randomUUID(),
  taskA: randomUUID(),
  taskB: randomUUID(),
};

function ctx(user: string, org: string, project: string, role: ProjectRole = 'admin'): TenantContext {
  return { userId: user, orgId: org, projectId: project, orgRole: 'owner', projectRole: role };
}

let admin: postgres.Sql;

beforeAll(async () => {
  if (!available) return;
  admin = adminSql();
  await admin`insert into profiles (id, email, display_name) values
    (${ids.userA}, ${`wa-${ids.userA.slice(0, 8)}@t.local`}, 'WA'),
    (${ids.userB}, ${`wb-${ids.userB.slice(0, 8)}@t.local`}, 'WB')`;
  await admin`insert into organizations (id, name, slug) values
    (${ids.orgA}, 'WOrg A', ${`wo22a-${ids.orgA.slice(0, 8)}`}),
    (${ids.orgB}, 'WOrg B', ${`wo22b-${ids.orgB.slice(0, 8)}`})`;
  await admin`insert into memberships (org_id, user_id, role) values
    (${ids.orgA}, ${ids.userA}, 'owner'), (${ids.orgB}, ${ids.userB}, 'owner')`;
  await admin`insert into projects (id, org_id, key, name) values
    (${ids.projA}, ${ids.orgA}, ${`zz-fixture-wa-${ids.projA.slice(0, 8)}`}, 'WA'),
    (${ids.projB}, ${ids.orgB}, ${`zz-fixture-wb-${ids.projB.slice(0, 8)}`}, 'WB')`;
  await admin`insert into project_members (org_id, project_id, user_id, role) values
    (${ids.orgA}, ${ids.projA}, ${ids.userA}, 'admin'),
    (${ids.orgB}, ${ids.projB}, ${ids.userB}, 'admin')`;
  await admin`insert into tasks (id, org_id, project_id, title, input, provider_selection, created_by, status) values
    (${ids.taskA}, ${ids.orgA}, ${ids.projA}, 'WA task', 'wsecret-A', 'openai', ${ids.userA}, 'pending'),
    (${ids.taskB}, ${ids.orgB}, ${ids.projB}, 'WB task', 'wsecret-B', 'openai', ${ids.userB}, 'pending')`;
  await admin`insert into run_jobs (org_id, project_id, task_id, status) values
    (${ids.orgA}, ${ids.projA}, ${ids.taskA}, 'queued'),
    (${ids.orgB}, ${ids.projB}, ${ids.taskB}, 'queued')`;
});

afterAll(async () => {
  if (admin && available) {
    for (const org of [ids.orgA, ids.orgB]) {
      await admin`delete from run_jobs where org_id = ${org}`;
      await admin`delete from tasks where org_id = ${org}`;
      await admin`delete from project_members where org_id = ${org}`;
      await admin`delete from projects where org_id = ${org}`;
      await admin`delete from memberships where org_id = ${org}`;
      await admin`delete from organizations where id = ${org}`;
    }
    await admin`delete from profiles where id in (${ids.userA}, ${ids.userB})`;
  }
  await admin?.end();
  // Restore the environment for sibling test files.
  await (getDb() as unknown as { $client?: postgres.Sql }).$client?.end?.();
  delete (globalThis as unknown as { __kingDbPool?: unknown }).__kingDbPool;
  if (originalDbUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDbUrl;
});

describe.skipIf(!available)('O-22 Test 5 — worker job isolation (as app_server)', () => {
  it('reconcile + the confirming role check: jobs.ts runs as app_server', async () => {
    const who = await getDb().execute(sql`select current_user as u`);
    const u = (who as unknown as { rows?: Array<{ u: string }> }).rows?.[0]?.u
      ?? (Array.isArray(who) ? (who[0] as { u: string }).u : undefined);
    expect(u).toBe('app_server');
    // Reconcile must run without a tenant context (startup path) and not throw.
    await expect(reconcileStaleJobs()).resolves.toBeTruthy();
  });

  it('each sequential job restores ONLY its own tenant context; nothing leaks to the pool', async () => {
    // --- Job A ---
    const claimedA = await claimJobForTask(ctx(ids.userA, ids.orgA, ids.projA), ids.taskA);
    expect(claimedA).not.toBeNull();
    expect(claimedA!.orgId).toBe(ids.orgA);
    expect(claimedA!.projectId).toBe(ids.projA);

    const seenByA = await withTenant(
      ctx(claimedA!.createdBy, claimedA!.orgId, claimedA!.projectId),
      (tx) => tx.select({ input: tasks.input }).from(tasks),
    );
    expect(seenByA.map((r) => r.input)).toEqual(['wsecret-A']);

    // Between jobs, the pooled connection carries NO ambient tenant context.
    const leakProbe1 = await getDb().execute(sql`select count(*)::int as n from tasks`);
    const n1 = (leakProbe1 as unknown as { rows?: Array<{ n: number }> }).rows?.[0]?.n
      ?? (Array.isArray(leakProbe1) ? (leakProbe1[0] as { n: number }).n : -1);
    expect(n1).toBe(0);

    // --- Job B on the SAME worker/pool ---
    const claimedB = await claimJobForTask(ctx(ids.userB, ids.orgB, ids.projB), ids.taskB);
    expect(claimedB).not.toBeNull();
    expect(claimedB!.orgId).toBe(ids.orgB);
    expect(claimedB!.projectId).toBe(ids.projB);

    const seenByB = await withTenant(
      ctx(claimedB!.createdBy, claimedB!.orgId, claimedB!.projectId),
      (tx) => tx.select({ input: tasks.input }).from(tasks),
    );
    // B sees ONLY its own data — A's context did not carry over.
    expect(seenByB.map((r) => r.input)).toEqual(['wsecret-B']);
  });

  it('a job with a missing tenant identity fails closed (never runs)', async () => {
    // Reuse job B's row but strip the identity, as a corrupted/interrupted claim.
    const claimedB = await claimJobForTask(ctx(ids.userB, ids.orgB, ids.projB), ids.taskB);
    // Already claimed above→ may be null; seed a fresh queued job to fail closed.
    await admin`update run_jobs set status = 'queued', leased_until = null where task_id = ${ids.taskB}`;
    const reclaim = await claimJobForTask(ctx(ids.userB, ids.orgB, ids.projB), ids.taskB);
    const job = reclaim ?? claimedB;
    expect(job).not.toBeNull();

    const outcome = await runClaimedJob({ ...job!, createdBy: '' });
    expect(outcome).toBeNull();
    const row = await admin`select status, last_error from run_jobs where id = ${job!.jobId}`;
    expect(row[0]!.status).toBe('failed');
    expect(String(row[0]!.last_error)).toMatch(/identity/i);
  });
});
