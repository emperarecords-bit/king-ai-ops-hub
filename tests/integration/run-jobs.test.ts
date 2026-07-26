import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { memberships, organizations, profiles, projectMembers, projects, runJobs, runs, tasks } from '@/db/schema';
import { claimJobForTask, claimNextJob, enqueueRun, reconcileStaleJobs } from '@/domain/jobs/jobs';

/**
 * Durable run jobs (O-21): atomic claim, idempotent enqueue, and restart
 * recovery — against real Postgres so FOR UPDATE SKIP LOCKED and the lease
 * semantics are exercised for real.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[run-jobs.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let ctxA: TenantContext;

async function makeWorkspace(): Promise<TenantContext> {
  const db = getSetupDb();
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('job'), name: 'Job Project' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  return { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
}

async function mkTask(ctx: TenantContext, status = 'pending'): Promise<string> {
  const t = await getSetupDb().insert(tasks).values({ orgId, projectId: ctx.projectId, title: 'Job task', input: 'x', providerSelection: 'openai', status: status as 'pending', createdBy: userId }).returning({ id: tasks.id });
  return t[0]!.id;
}

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `job-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = await db.insert(organizations).values({ name: 'Job Org', slug: `job-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  ctxA = await makeWorkspace();
});

afterAll(async () => {
  if (!available) return;
  // Clear this suite's own run_jobs. The durable-queue tests share one Postgres,
  // and claimNextJob() drains a GLOBAL FIFO — so a run must neither inherit nor
  // contribute to an accumulated queue of leftover `queued`/`running` jobs.
  await getSetupDb().delete(runJobs).where(eq(runJobs.orgId, orgId));
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('durable run jobs', () => {
  it('enqueue is idempotent — a duplicate live job is rejected', async () => {
    const t = await mkTask(ctxA);
    await withTenant(ctxA, (tx) => enqueueRun(tx, ctxA, t));
    await withTenant(ctxA, (tx) => enqueueRun(tx, ctxA, t));
    const jobs = await getSetupDb().select().from(runJobs).where(eq(runJobs.taskId, t));
    expect(jobs.filter((j) => j.status === 'queued')).toHaveLength(1);
  });

  it('a job is claimed exactly once (atomic)', async () => {
    const t = await mkTask(ctxA);
    await withTenant(ctxA, (tx) => enqueueRun(tx, ctxA, t));
    const [a, b] = await Promise.all([claimJobForTask(ctxA, t), claimJobForTask(ctxA, t)]);
    const claims = [a, b].filter(Boolean);
    expect(claims).toHaveLength(1); // one wins, the other gets null
  });

  it('Test 2 — restart recovery: an interrupted run becomes failed-recoverable, not lost', async () => {
    // Simulate: a job was claimed and the task set running, then the worker
    // died (lease expired) mid-run.
    const t = await mkTask(ctxA, 'running');
    const db = getSetupDb();
    const run = await db.insert(runs).values({ orgId, projectId: ctxA.projectId, taskId: t, status: 'running', primaryAgentId: await anAgent(ctxA) }).returning({ id: runs.id });
    await db.insert(runJobs).values({ orgId, projectId: ctxA.projectId, taskId: t, status: 'running', leasedUntil: new Date(Date.now() - 60_000) });

    const result = await reconcileStaleJobs();
    expect(result.recovered).toBeGreaterThanOrEqual(1);

    // The run is now failed with a recoverable reason; the task is failed
    // (retryable); nothing silently disappeared; provenance (the run row) intact.
    const runRow = (await db.select().from(runs).where(eq(runs.id, run[0]!.id)).limit(1))[0]!;
    expect(runRow.status).toBe('failed');
    expect(runRow.errorMessage).toMatch(/interrupted.*recoverable/i);
    const taskRow = (await db.select().from(tasks).where(eq(tasks.id, t)).limit(1))[0]!;
    expect(taskRow.status).toBe('failed');
    const jobRow = (await db.select().from(runJobs).where(eq(runJobs.taskId, t)).limit(1))[0]!;
    expect(jobRow.status).toBe('failed');
  });

  it('a stale job whose task never started is safely requeued', async () => {
    const t = await mkTask(ctxA, 'pending');
    await getSetupDb().insert(runJobs).values({ orgId, projectId: ctxA.projectId, taskId: t, status: 'running', leasedUntil: new Date(Date.now() - 60_000) });
    const result = await reconcileStaleJobs();
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    const jobRow = (await getSetupDb().select().from(runJobs).where(eq(runJobs.taskId, t)).limit(1))[0]!;
    expect(jobRow.status).toBe('queued');
  });

  it('claimNextJob claims across the queue and returns provenance', async () => {
    const t = await mkTask(ctxA);
    await withTenant(ctxA, (tx) => enqueueRun(tx, ctxA, t));
    // claimNextJob() drains a GLOBAL FIFO ordered by created_at, so any backlog
    // of unrelated `queued` jobs (left by prior runs, or concurrent suites)
    // would sit ahead of ours. Pin our job to the front by backdating it, so the
    // claim is deterministic no matter how large that backlog is — this test
    // asserts cross-queue claiming + provenance, not FIFO fairness, and must not
    // depend on, or drain, the shared queue's accumulated state.
    await getSetupDb()
      .update(runJobs)
      .set({ createdAt: new Date(0) })
      .where(and(eq(runJobs.taskId, t), eq(runJobs.status, 'queued')));

    // Our job now sorts first. The short guard loop only tolerates an equally
    // backdated stray from a crashed prior run: claiming it once hands it a fresh
    // lease so it won't reappear, and we continue. It never reaches — let alone
    // drains — the real (now()-dated) backlog, which always sorts after ours.
    let found: Awaited<ReturnType<typeof claimNextJob>> = null;
    for (let i = 0; i < 25 && !found; i += 1) {
      const j = await claimNextJob();
      if (!j) break;
      if (j.taskId === t) found = j;
    }
    expect(found?.taskId).toBe(t);
    expect(found?.projectId).toBe(ctxA.projectId);
    expect(found?.createdBy).toBe(userId);
  });
});

async function anAgent(ctx: TenantContext): Promise<string> {
  const { agents } = await import('@/db/schema');
  const a = await getSetupDb().insert(agents).values({ orgId, projectId: ctx.projectId, name: `A-${randomUUID().slice(0, 6)}`, role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x' }).returning({ id: agents.id });
  return a[0]!.id;
}

void sql;
