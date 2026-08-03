import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { assertDisposableDbForVerification } from '@tests/support/require-disposable-db';
import { type TenantContext } from '@/types/domain';
import type * as JobsModule from '@/domain/jobs/jobs';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import {
  agents,
  auditLogs,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  runJobs,
  runs,
  spendLimits,
  taskSchedules,
  tasks,
} from '@/db/schema';
import { setProviderOverrideForTests } from '@/providers/registry';
import { createSchedule } from '@/domain/standing/standing';

/**
 * Hub P1d Stage 1 — the standing-work scheduler is JOB-BACKED and occurrence-idempotent.
 *
 * A due occurrence creates EXACTLY one task + one queued `run_jobs` row (dispatch_kind='standing') and the
 * scheduler calls NO provider. Concurrent/back-to-back ticks for the same occurrence collapse to one task
 * (the second is suppressed). An atomic-dispatch failure rolls the whole transaction back — the schedule row
 * is byte-for-byte unchanged and still due. An invalid pinned assignment leaves the schedule unchanged and due
 * (P1c behavior preserved). The enqueued job then executes through the ordinary worker path with the pins
 * intact.
 *
 * Fake providers only; disposable DB (both URLs + REQUIRE_DISPOSABLE_DB=1) when opted in.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');

assertDisposableDbForVerification('standing-reliability.test');

// Inject an atomic-dispatch failure without disturbing any other call: enqueueRun throws only when the
// hoisted flag is set. claimNextJob/runClaimedJob/reconcileStaleJobs stay the real implementations.
const H = vi.hoisted(() => ({ throwOnEnqueue: false }));
vi.mock('@/domain/jobs/jobs', async (importActual) => {
  const actual = await importActual<typeof JobsModule>();
  return {
    ...actual,
    enqueueRun: async (...args: Parameters<typeof actual.enqueueRun>) => {
      if (H.throwOnEnqueue) throw new Error('injected atomic-dispatch failure (enqueue)');
      return actual.enqueueRun(...args);
    },
  };
});

const { runDueSchedules } = await import('@/domain/standing/standing');
const { claimNextJob, runClaimedJob } = await import('@/domain/jobs/jobs');

// Availability: the P1d schema (run_execution_checkpoints, occurrence columns) must be present. On the shared
// dev DB without migration 0056 this suite skips cleanly, exactly like the sibling DB-backed suites.
let available = false;
try {
  const db = getSetupDb();
  await db.select({ one: profiles.id }).from(profiles).limit(1);
  await db.execute(`select 1 from run_execution_checkpoints limit 1`);
  await db.execute(`select schedule_occurrence_at from tasks limit 1`);
  available = true;
} catch (err) {
  console.warn(`[standing-reliability.test] SKIPPING — P1d schema not present: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let userId = '';

interface Workspace {
  ctx: TenantContext;
  primaryId: string;
}

async function makeWorkspace(): Promise<Workspace> {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('p1d'), name: 'P1d' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  const primaryId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'P1d Primary', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'x', enabled: true })
      .returning({ id: agents.id })
  )[0]!.id;
  return { ctx: { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' }, primaryId };
}

/** Create a daily schedule (validates the pin) and force it DUE by backdating next_run_at to a fixed past
 *  instant, which becomes the occurrence identity. Returns the schedule id + occurrence timestamp. */
async function createDueSchedule(w: Workspace, occurrenceAt: Date): Promise<string> {
  const scheduleId = await withTenant(w.ctx, (tx) =>
    createSchedule(tx, w.ctx, {
      title: 'Daily brief',
      input: 'Summarize the day.',
      providerSelection: 'openai',
      cadence: 'daily',
      atHour: 6,
      reviewEnabled: false,
      assignedPrimaryAgentId: w.primaryId,
    }),
  );
  await db.update(taskSchedules).set({ nextRunAt: occurrenceAt }).where(eq(taskSchedules.id, scheduleId));
  return scheduleId;
}

const jobsFor = (taskId: string) => db.select().from(runJobs).where(eq(runJobs.taskId, taskId));
const tasksForSchedule = (scheduleId: string) =>
  db.select().from(tasks).where(and(eq(tasks.scheduleId, scheduleId), eq(tasks.orgId, orgId)));
async function scheduleRow(scheduleId: string) {
  return (await db.select().from(taskSchedules).where(eq(taskSchedules.id, scheduleId)))[0]!;
}
async function auditActionsFor(scheduleId: string): Promise<string[]> {
  const rows = await db
    .select({ a: auditLogs.action })
    .from(auditLogs)
    .where(and(eq(auditLogs.entityId, scheduleId), eq(auditLogs.orgId, orgId)));
  return rows.map((r) => r.a);
}

beforeAll(async () => {
  if (!available) return;
  // runDueSchedules scans GLOBALLY. Pause any schedule that is ALREADY DUE (a leftover from a prior run of
  // this suite on the same disposable DB) so this run's global counters reflect only its own schedules. Only
  // touches already-due rows — future-dated schedules created by sibling suites are left enabled.
  await getSetupDb().execute(`update task_schedules set enabled = false where enabled = true and next_run_at <= now()`);
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `p1d-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `p1d-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
});
afterAll(async () => {
  if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});
afterEach(async () => {
  H.throwOnEnqueue = false;
  setProviderOverrideForTests(null);
  // runDueSchedules scans schedules GLOBALLY; a test that intentionally leaves its schedule due (rollback /
  // suppression cases) must not inflate the next test's global counters. Pause this org's schedules so each
  // test starts from a clean due-set.
  if (available && orgId) {
    await getSetupDb().update(taskSchedules).set({ enabled: false }).where(eq(taskSchedules.orgId, orgId));
  }
});

describe.skipIf(!available)('Hub P1d — job-backed standing work', () => {
  it('a due occurrence creates exactly ONE task + ONE queued standing job, and the scheduler calls NO provider', async () => {
    const w = await makeWorkspace();
    const occurrenceAt = new Date('2020-01-02T06:00:00.000Z');
    const scheduleId = await createDueSchedule(w, occurrenceAt);

    // A provider override that would RECORD any call the scheduler wrongly made.
    const openai = new FakeProvider('openai').reply('should never be called');
    setProviderOverrideForTests((id) => (id === 'openai' ? openai : undefined));

    const result = await runDueSchedules(new Date());
    expect(result.enqueued).toBe(1);
    expect(result.suppressed).toBe(0);
    expect(result.assignmentRequired).toBe(0);

    // The scheduler invoked NO provider.
    expect(openai.requests.length).toBe(0);

    const producedTasks = await tasksForSchedule(scheduleId);
    expect(producedTasks).toHaveLength(1);
    const task = producedTasks[0]!;
    expect(task.scheduleOccurrenceAt?.toISOString()).toBe(occurrenceAt.toISOString());
    expect(task.assignedPrimaryAgentId).toBe(w.primaryId);
    expect(task.status).toBe('pending'); // enqueued, not executed by the scheduler

    const js = await jobsFor(task.id);
    expect(js).toHaveLength(1);
    expect(js[0]!.status).toBe('queued');
    expect(js[0]!.dispatchKind).toBe('standing');

    // The clock advanced past the occurrence only because task+job are durable.
    const s = await scheduleRow(scheduleId);
    expect(s.nextRunAt.getTime()).toBeGreaterThan(occurrenceAt.getTime());
    expect(s.lastRunAt).not.toBeNull();
    expect(await auditActionsFor(scheduleId)).toContain('schedule.occurrence_enqueued');
  });

  it('a repeated due scan of the same occurrence is suppressed — one task, one job, one suppression', async () => {
    const w = await makeWorkspace();
    const occurrenceAt = new Date('2020-02-02T06:00:00.000Z');
    const scheduleId = await createDueSchedule(w, occurrenceAt);

    const first = await runDueSchedules(new Date());
    expect(first.enqueued).toBe(1);

    // Simulate a second scheduler that still saw this occurrence as due (reset the clock to the SAME
    // occurrence) — the occurrence unique index makes the task insert conflict → suppressed, no advance.
    await db.update(taskSchedules).set({ nextRunAt: occurrenceAt }).where(eq(taskSchedules.id, scheduleId));
    const second = await runDueSchedules(new Date());
    expect(second.suppressed).toBe(1);
    expect(second.enqueued).toBe(0);

    expect(await tasksForSchedule(scheduleId)).toHaveLength(1);
    const task = (await tasksForSchedule(scheduleId))[0]!;
    expect(await jobsFor(task.id)).toHaveLength(1);
    const suppressed = (await auditActionsFor(scheduleId)).filter((a) => a === 'schedule.occurrence_suppressed');
    expect(suppressed).toHaveLength(1);
  });

  it('two concurrent ticks for the same due occurrence still yield exactly one task and one job', async () => {
    const w = await makeWorkspace();
    const occurrenceAt = new Date('2020-03-02T06:00:00.000Z');
    const scheduleId = await createDueSchedule(w, occurrenceAt);

    const [a, b] = await Promise.all([runDueSchedules(new Date()), runDueSchedules(new Date())]);
    // Exactly one occurrence is created across the two ticks; the other is suppressed (never a duplicate).
    expect(a.enqueued + b.enqueued).toBe(1);
    expect(a.suppressed + b.suppressed).toBe(1);

    const producedTasks = await tasksForSchedule(scheduleId);
    expect(producedTasks).toHaveLength(1);
    expect(await jobsFor(producedTasks[0]!.id)).toHaveLength(1);
  });

  it('a forced atomic-dispatch failure leaves the schedule byte-for-byte unchanged and still due — no task, no job', async () => {
    const w = await makeWorkspace();
    const occurrenceAt = new Date('2020-04-02T06:00:00.000Z');
    const scheduleId = await createDueSchedule(w, occurrenceAt);
    const before = await scheduleRow(scheduleId);

    H.throwOnEnqueue = true;
    const result = await runDueSchedules(new Date());
    expect(result.enqueued).toBe(0);
    expect(result.failures.length).toBe(1);

    // The whole transaction rolled back: no task, no job, and the schedule row is byte-for-byte identical
    // (next_run_at still the due occurrence, last_run_at/updated_at untouched).
    expect(await tasksForSchedule(scheduleId)).toHaveLength(0);
    const jobsAfter = await db
      .select()
      .from(runJobs)
      .where(and(eq(runJobs.projectId, w.ctx.projectId), eq(runJobs.orgId, orgId)));
    expect(jobsAfter).toHaveLength(0);
    expect(await scheduleRow(scheduleId)).toEqual(before);
    // Still due next tick.
    expect((await scheduleRow(scheduleId)).nextRunAt.getTime()).toBe(occurrenceAt.getTime());
  });

  it('an INVALID pinned assignment leaves the schedule unchanged and due (P1c preserved) — no task, no job', async () => {
    const w = await makeWorkspace();
    const occurrenceAt = new Date('2020-05-02T06:00:00.000Z');
    const scheduleId = await createDueSchedule(w, occurrenceAt);
    // Decay the pin AFTER creation: disable the pinned primary so it is no longer assignable.
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, w.primaryId));
    const before = await scheduleRow(scheduleId);

    const result = await runDueSchedules(new Date());
    expect(result.assignmentRequired).toBe(1);
    expect(result.enqueued).toBe(0);

    expect(await tasksForSchedule(scheduleId)).toHaveLength(0);
    expect(await scheduleRow(scheduleId)).toEqual(before); // unchanged, still due
    expect(await auditActionsFor(scheduleId)).toContain('schedule.assignment_required');
  });

  it('the queued standing job executes through the worker path with the pinned agent intact', async () => {
    const w = await makeWorkspace();
    const occurrenceAt = new Date('2020-06-02T06:00:00.000Z');
    const scheduleId = await createDueSchedule(w, occurrenceAt);
    await runDueSchedules(new Date());
    const task = (await tasksForSchedule(scheduleId))[0]!;

    // Pin our job to the front of the global FIFO so claimNextJob returns it deterministically.
    await db.update(runJobs).set({ createdAt: new Date(0) }).where(and(eq(runJobs.taskId, task.id), eq(runJobs.status, 'queued')));

    const openai = new FakeProvider('openai').reply('Standing brief produced by the worker.');
    setProviderOverrideForTests((id) => (id === 'openai' ? openai : undefined));

    let claimed: Awaited<ReturnType<typeof claimNextJob>> = null;
    for (let i = 0; i < 25 && !claimed; i += 1) {
      const j = await claimNextJob();
      if (!j) break;
      if (j.taskId === task.id) claimed = j;
    }
    expect(claimed?.taskId).toBe(task.id);

    const outcome = await runClaimedJob(claimed!);
    expect(outcome?.status).toBe('completed');
    // The provider WAS called now (by the worker path, not the scheduler).
    expect(openai.requests.length).toBeGreaterThanOrEqual(1);

    const run = (await db.select().from(runs).where(eq(runs.taskId, task.id)))[0]!;
    expect(run.status).toBe('completed');
    // The run executed the schedule's EXACT pinned primary (P1a pins survive the queue).
    expect(run.primaryAgentId).toBe(w.primaryId);
    const jobRow = (await jobsFor(task.id))[0]!;
    expect(jobRow.status).toBe('done');
  });
});
