import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, auditLogs, memberships, organizations, profiles, projectMembers, projects, runJobs, runs, spendLimits, tasks } from '@/db/schema';
import { setProviderOverrideForTests } from '@/providers/registry';
import { startRun } from '@/domain/tasks/runner';
import { claimJobForTask, enqueueRun, RerunRefusedError, requestRerun, runClaimedJob } from '@/domain/jobs/jobs';

/**
 * Regression — the 17:19 "reject and rerun" in the server-cooling conversation (Hub prod 2026-10-19).
 * Task 0a72c3bc had COMPLETED; the re-run card queued job ad2c49ee, the worker saw a non-runnable status and
 * finished it `done` 0.42 s later with ZERO runs — while Ops Chat said "✓ Re-run queued". A re-run is now a
 * real new attempt through the real queue + worker (a NEW run row; the old run and result kept), or an
 * explicit refusal with a reason. A duplicate enqueue is never audited as if a job had been queued.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');
process.env.RATE_LIMIT_RUNS_PER_MINUTE = '1000';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[rerun-semantics.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let baseCtx: TenantContext;

async function makeWorkspace() {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('rr'), name: 'W' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: baseCtx.userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  const ctx: TenantContext = { ...baseCtx, projectId: pid };
  const primaryId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Marketing Lead', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 2048 })
      .returning({ id: agents.id })
  )[0]!.id;
  const taskId = (
    await db
      .insert(tasks)
      .values({ orgId, projectId: pid, title: 'Duct CFM calc', input: 'Size the ducts.', providerSelection: 'openai', reviewEnabled: false, quickExempt: true, status: 'pending', createdBy: baseCtx.userId, assignedPrimaryAgentId: primaryId })
      .returning({ id: tasks.id })
  )[0]!.id;
  return { ctx, taskId };
}

function inject(...replies: string[]) {
  const openai = new FakeProvider('openai');
  for (const r of replies) openai.reply(r);
  setProviderOverrideForTests((id) => (id === 'openai' ? openai : undefined));
}

const runsOf = (taskId: string) => db.select().from(runs).where(eq(runs.taskId, taskId)).orderBy(asc(runs.createdAt));
const statusOf = async (taskId: string) => (await db.select({ s: tasks.status }).from(tasks).where(eq(tasks.id, taskId)))[0]!.s;
const audits = (taskId: string, action: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.entityId, taskId), eq(auditLogs.action, action)));

beforeAll(async () => {
  if (!available) return;
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `rr-${randomUUID().slice(0, 8)}@t.local`, displayName: 'Owner' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `rr-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  baseCtx = { userId, orgId, projectId: '', orgRole: 'owner', projectRole: 'admin' } as TenantContext;
});
afterEach(() => setProviderOverrideForTests(null));
afterAll(() => setProviderOverrideForTests(null));

describe.skipIf(!available)('re-run semantics (server-cooling 17:19 regression)', () => {
  it('re-running a COMPLETED task creates a NEW run through the real queue + worker; the first run and its result are untouched', async () => {
    const { ctx, taskId } = await makeWorkspace();
    inject('First answer: 3,160 CFM.');
    await startRun(ctx, taskId);
    expect(await statusOf(taskId)).toBe('completed');
    const [first] = await runsOf(taskId);

    const r = await withTenant(ctx, (tx) => requestRerun(tx, ctx, taskId));
    expect(r).toMatchObject({ status: 'started', previousStatus: 'completed', previousRunId: first!.id });
    inject('Second answer: 3,200 CFM.');
    const job = await claimJobForTask(ctx, taskId);
    expect(job).not.toBeNull();
    await runClaimedJob(job!);

    const all = await runsOf(taskId);
    expect(all).toHaveLength(2); // the 17:19 bug: this was 1 (job drained with no run)
    expect(all[0]!.id).toBe(first!.id);
    expect(all[0]!.consolidatedResult).toBe(first!.consolidatedResult); // history preserved
    expect(all[1]!.consolidatedResult).toContain('Second answer');
    expect(await statusOf(taskId)).toBe('completed');
    expect(await audits(taskId, 'task.rerun_requested')).toHaveLength(1);
    expect(await audits(taskId, 'run_job.drained_without_run')).toHaveLength(0);
  });

  it('a task waiting on an approval is refused explicitly (no job, no status change)', async () => {
    const { ctx, taskId } = await makeWorkspace();
    await db.update(tasks).set({ status: 'awaiting_approval' }).where(eq(tasks.id, taskId));
    await expect(withTenant(ctx, (tx) => requestRerun(tx, ctx, taskId))).rejects.toMatchObject({ reason: 'awaiting_approval' });
    expect(await db.select().from(runJobs).where(eq(runJobs.taskId, taskId))).toHaveLength(0);
    expect(await statusOf(taskId)).toBe('awaiting_approval');
  });

  it('a cancelled task is refused explicitly', async () => {
    const { ctx, taskId } = await makeWorkspace();
    await db.update(tasks).set({ status: 'cancelled' }).where(eq(tasks.id, taskId));
    const err = await withTenant(ctx, (tx) => requestRerun(tx, ctx, taskId)).catch((e) => e);
    expect(err).toBeInstanceOf(RerunRefusedError);
    expect(err.reason).toBe('cancelled');
  });

  it('a duplicate enqueue reports inserted:false, returns the live job, and is NOT audited as enqueued', async () => {
    const { ctx, taskId } = await makeWorkspace();
    const first = await withTenant(ctx, (tx) => enqueueRun(tx, ctx, taskId));
    const second = await withTenant(ctx, (tx) => enqueueRun(tx, ctx, taskId));
    expect(first.inserted).toBe(true);
    expect(second).toEqual({ inserted: false, jobId: first.jobId });
    expect(await audits(taskId, 'run_job.enqueued')).toHaveLength(1);
    expect(await audits(taskId, 'run_job.enqueue_skipped')).toHaveLength(1);
    const again = await withTenant(ctx, (tx) => requestRerun(tx, ctx, taskId));
    expect(again).toMatchObject({ status: 'already_queued', jobId: first.jobId });
  });

  it('a job that still drains with no run (legacy path) is recorded, never silent', async () => {
    const { ctx, taskId } = await makeWorkspace();
    inject('Answer.');
    await startRun(ctx, taskId);
    // The OLD confirm path: enqueue directly against a completed task (no rerun request).
    await withTenant(ctx, (tx) => enqueueRun(tx, ctx, taskId));
    const job = await claimJobForTask(ctx, taskId);
    await runClaimedJob(job!);
    expect(await runsOf(taskId)).toHaveLength(1);
    expect(await audits(taskId, 'run_job.drained_without_run')).toHaveLength(1);
  });
});
