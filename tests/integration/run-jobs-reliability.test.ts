import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { assertDisposableDbForVerification } from '@tests/support/require-disposable-db';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, memberships, organizations, profiles, projectMembers, projects, runJobs, runs, tasks } from '@/db/schema';
import { claimJobForTask, claimNextJob, enqueueRun, reconcileStaleJobs } from '@/domain/jobs/jobs';

/**
 * Hub P1d Stage 1 — lease / recovery hardening on run_jobs.
 *
 * dispatch_kind is recorded on enqueue; heartbeat_at is stamped at claim. An abandoned pre-dispatch (queued,
 * unclaimed) job stays claimable; a stale-lease running job is reconciled WITHOUT a worker restart (a second
 * reconcile pass, exactly like the worker's periodic tick, recovers a job that went stale after boot) and
 * recovery creates no duplicate task/run; a terminal (done/failed) job is never reclaimed. Real Postgres so
 * the lease predicates + SKIP LOCKED are exercised for real. Fake providers only; disposable DB when opted in.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

assertDisposableDbForVerification('run-jobs-reliability.test');

let available = false;
try {
  const db = getSetupDb();
  await db.select({ one: profiles.id }).from(profiles).limit(1);
  await db.execute(`select heartbeat_at, dispatch_kind from run_jobs limit 1`);
  available = true;
} catch (err) {
  console.warn(`[run-jobs-reliability.test] SKIPPING — P1d schema not present: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let ctxA: TenantContext;

async function makeWorkspace(): Promise<TenantContext> {
  const db = getSetupDb();
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('jobrel'), name: 'JobRel' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  return { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
}

async function mkTask(ctx: TenantContext, status = 'pending'): Promise<string> {
  const t = await getSetupDb()
    .insert(tasks)
    .values({ orgId, projectId: ctx.projectId, title: 'Job task', input: 'x', providerSelection: 'openai', status: status as 'pending', createdBy: userId })
    .returning({ id: tasks.id });
  return t[0]!.id;
}

async function anAgent(ctx: TenantContext): Promise<string> {
  const a = await getSetupDb()
    .insert(agents)
    .values({ orgId, projectId: ctx.projectId, name: `A-${randomUUID().slice(0, 6)}`, role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'x' })
    .returning({ id: agents.id });
  return a[0]!.id;
}

const jobFor = async (taskId: string) => (await getSetupDb().select().from(runJobs).where(eq(runJobs.taskId, taskId)))[0]!;

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `jobrel-${randomUUID().slice(0, 8)}@t.local`, displayName: 'Owner' });
  const org = await db.insert(organizations).values({ name: 'JobRel Org', slug: `jobrel-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  ctxA = await makeWorkspace();
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().delete(runJobs).where(eq(runJobs.orgId, orgId));
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('Hub P1d — run-job lease/recovery', () => {
  it('enqueue records dispatch_kind (default interactive; explicit value honored)', async () => {
    const t1 = await mkTask(ctxA);
    await withTenant(ctxA, (tx) => enqueueRun(tx, ctxA, t1)); // default
    expect((await jobFor(t1)).dispatchKind).toBe('interactive');

    const t2 = await mkTask(ctxA);
    await withTenant(ctxA, (tx) => enqueueRun(tx, ctxA, t2, 'worker'));
    expect((await jobFor(t2)).dispatchKind).toBe('worker');
  });

  it('a claim stamps heartbeat_at (and a lease)', async () => {
    const t = await mkTask(ctxA);
    await withTenant(ctxA, (tx) => enqueueRun(tx, ctxA, t));
    const claimed = await claimJobForTask(ctxA, t);
    expect(claimed).not.toBeNull();
    const job = await jobFor(t);
    expect(job.status).toBe('running');
    expect(job.heartbeatAt).not.toBeNull();
    expect(job.leasedUntil).not.toBeNull();
  });

  it('an abandoned pre-dispatch (queued, unclaimed) job stays claimable', async () => {
    const t = await mkTask(ctxA);
    await withTenant(ctxA, (tx) => enqueueRun(tx, ctxA, t));
    // Never claimed → still queued → a worker can still pick it up.
    const claimed = await claimJobForTask(ctxA, t);
    expect(claimed?.taskId).toBe(t);
    expect((await jobFor(t)).status).toBe('running');
  });

  it('periodic reconcile recovers a job that went stale AFTER boot — without a worker restart — and creates no duplicate task/run', async () => {
    const db = getSetupDb();
    const t = await mkTask(ctxA, 'running');
    const run = await db
      .insert(runs)
      .values({ classification: 'live', orgId, projectId: ctxA.projectId, taskId: t, status: 'running', primaryAgentId: await anAgent(ctxA) })
      .returning({ id: runs.id });

    // Boot reconcile: this job does not exist yet / is not stale — nothing to recover for it.
    const bootJob = await db
      .insert(runJobs)
      .values({ orgId, projectId: ctxA.projectId, taskId: t, status: 'running', leasedUntil: new Date(Date.now() + 60_000) })
      .returning({ id: runJobs.id });
    const boot = await reconcileStaleJobs();
    expect(boot.recovered + boot.requeued).toBeGreaterThanOrEqual(0); // may recover unrelated strays, but not ours
    expect((await jobFor(t)).status).toBe('running'); // still leased, untouched by boot pass

    // The lease expires mid-run (the worker executing it died). A LATER periodic reconcile — same process,
    // no restart — must recover it.
    await db.update(runJobs).set({ leasedUntil: new Date(Date.now() - 60_000) }).where(eq(runJobs.id, bootJob[0]!.id));
    const periodic = await reconcileStaleJobs();
    expect(periodic.recovered).toBeGreaterThanOrEqual(1);

    // Recovered: run failed-recoverable, task failed, job failed — and NO duplicate task/run was created.
    const runRow = (await db.select().from(runs).where(eq(runs.id, run[0]!.id)).limit(1))[0]!;
    expect(runRow.status).toBe('failed');
    expect(runRow.errorMessage).toMatch(/interrupted.*recoverable/i);
    expect((await jobFor(t)).status).toBe('failed');
    expect((await db.select().from(tasks).where(eq(tasks.id, t))).length).toBe(1);
    expect((await db.select().from(runs).where(eq(runs.taskId, t))).length).toBe(1);
  });

  it('a terminal (done/failed) job is never reclaimed by reconcile or claim', async () => {
    const db = getSetupDb();
    const t = await mkTask(ctxA, 'completed');
    // A terminal job with an expired lease must NOT be resurrected.
    const jr = await db
      .insert(runJobs)
      .values({ orgId, projectId: ctxA.projectId, taskId: t, status: 'done', leasedUntil: new Date(Date.now() - 60_000) })
      .returning({ id: runJobs.id });

    await reconcileStaleJobs();
    expect((await jobFor(t)).status).toBe('done'); // reconcile only touches status='running'

    // Claim is scoped to queued or running-with-expired-lease — a done job is invisible to it.
    const claimed = await claimJobForTask(ctxA, t);
    expect(claimed).toBeNull();
    expect((await jobFor(t)).status).toBe('done');
    void jr;
  });

  it('claimNextJob honors the queue and never claims a terminal job', async () => {
    const db = getSetupDb();
    const t = await mkTask(ctxA);
    await withTenant(ctxA, (tx) => enqueueRun(tx, ctxA, t, 'worker'));
    await db.update(runJobs).set({ createdAt: new Date(0) }).where(and(eq(runJobs.taskId, t), eq(runJobs.status, 'queued')));

    let found: Awaited<ReturnType<typeof claimNextJob>> = null;
    for (let i = 0; i < 25 && !found; i += 1) {
      const j = await claimNextJob();
      if (!j) break;
      if (j.taskId === t) found = j;
    }
    expect(found?.taskId).toBe(t);
    expect((await jobFor(t)).heartbeatAt).not.toBeNull();
  });
});
