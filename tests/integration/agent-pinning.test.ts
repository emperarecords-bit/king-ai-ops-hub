import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { assertDisposableDbForVerification } from '@tests/support/require-disposable-db';
import { type TenantContext } from '@/types/domain';
import { AssignmentRequiredError, ValidationError } from '@/lib/errors';
import { getSetupDb } from '@/db/client';
import {
  agents,
  auditLogs,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  runs,
  spendLimits,
  taskSchedules,
  tasks,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { setProviderOverrideForTests } from '@/providers/registry';
import { findAgentForRole } from '@/domain/agents/agents';
import { createTask } from '@/domain/tasks/tasks';
import { startRun } from '@/domain/tasks/runner';
import { claimJobForTask, runClaimedJob } from '@/domain/jobs/jobs';
import { createSchedule, runDueSchedules } from '@/domain/standing/standing';

/**
 * Hub Platform P1a — exact agent assignment & execution pinning.
 *
 * Proves the run executes EXACTLY the pinned employee (never a provider-derived substitute — the historical
 * bug), fails closed on any invalid/legacy pin, records immutable requested==actual evidence, and never
 * leaks a prompt/secret into an assignment audit. Drives the REAL dispatch path with a fake provider (no
 * external call, no spend).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');

// Refuse DB-backed P1a verification against the shared `king_ai_hub` when REQUIRE_DISPOSABLE_DB=1 is set —
// trips at module init, before the getSetupDb() probe below opens any connection. No-op without the flag.
assertDisposableDbForVerification('agent-pinning.test');

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[agent-pinning.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let userId = '';

// A distinctive secret embedded in every agent's system prompt — must NEVER appear in an assignment audit.
const SECRET_PROMPT = 'SUPER_SECRET_PROMPT_MARKER_DO_NOT_LEAK sk-test-abcdefghijklmnop';

interface Seeded {
  ctx: TenantContext;
  tomBrown: string; // openai primary
  leadEngineer: string; // openai primary (same provider — the regression pair)
  reviewer: string; // anthropic reviewer
  disabledPrimary: string; // openai primary, disabled
}

async function mkAgent(
  projectId: string,
  name: string,
  role: 'primary' | 'reviewer',
  provider: 'openai' | 'anthropic',
  enabled = true,
): Promise<string> {
  return (
    await db
      .insert(agents)
      .values({ orgId, projectId, name, role, provider, model: 'm-x', systemPrompt: SECRET_PROMPT, enabled })
      .returning({ id: agents.id })
  )[0]!.id;
}

async function freshWorkspace(): Promise<Seeded> {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('pin'), name: 'W' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  const ctx: TenantContext = { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' };
  return {
    ctx,
    tomBrown: await mkAgent(pid, 'Tom Brown', 'primary', 'openai'),
    leadEngineer: await mkAgent(pid, 'Lead Engineer', 'primary', 'openai'),
    reviewer: await mkAgent(pid, 'Principal Reviewer', 'reviewer', 'anthropic'),
    disabledPrimary: await mkAgent(pid, 'Retired Engineer', 'primary', 'openai', false),
  };
}

function fakeBoth() {
  const openai = new FakeProvider('openai').reply('primary answer').reply('revised answer');
  const anthropic = new FakeProvider('anthropic').reply('VERDICT: approve\n\nlooks good.');
  setProviderOverrideForTests((id) => (id === 'openai' ? openai : id === 'anthropic' ? anthropic : undefined));
  return { openai, anthropic };
}

async function runRow(taskId: string) {
  return (await db.select().from(runs).where(eq(runs.taskId, taskId)))[0];
}

/** Hub P1d — the standing tick now ENQUEUES a durable job instead of running inline. Drive the produced task
 *  through the ordinary worker path (claim → execute) so the run + its pins are exercised end to end. */
async function executeStandingTask(ctx: TenantContext, taskId: string) {
  const claimed = await claimJobForTask(ctx, taskId);
  expect(claimed).not.toBeNull();
  return runClaimedJob(claimed!);
}

beforeAll(async () => {
  if (!available) return;
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `pin-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `pin-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
});
afterAll(async () => {
  if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});
afterEach(() => setProviderOverrideForTests(null));

describe.skipIf(!available)('P1a exact agent pinning', () => {
  it('the selected employee executes exactly (run.primaryAgentId == task.assignedPrimaryAgentId)', async () => {
    const w = await freshWorkspace();
    fakeBoth();
    const taskId = await withTenant(w.ctx, (tx) =>
      createTask(tx, w.ctx, { title: 'T', input: 'do it', providerSelection: 'openai', reviewEnabled: false, primaryAgentId: w.tomBrown }),
    );
    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = await runRow(taskId);
    expect(run!.primaryAgentId).toBe(w.tomBrown);
    expect(run!.requestedPrimaryAgentId).toBe(w.tomBrown);
  });

  it('REGRESSION: two enabled primaries on the SAME provider — the non-selected one is never substituted', async () => {
    const w = await freshWorkspace();
    fakeBoth();
    // Assign Tom Brown; Lead Engineer is also an enabled openai primary. The old bug could return either.
    const taskId = await withTenant(w.ctx, (tx) =>
      createTask(tx, w.ctx, { title: 'T', input: 'do it', providerSelection: 'openai', reviewEnabled: false, primaryAgentId: w.tomBrown }),
    );
    await startRun(w.ctx, taskId);
    const run = await runRow(taskId);
    expect(run!.primaryAgentId).toBe(w.tomBrown);
    expect(run!.primaryAgentId).not.toBe(w.leadEngineer);
  });

  it('STRUCTURAL: findAgentForRole is bypassed — the pinned id executes even when it is NOT the fallback pick', async () => {
    const w = await freshWorkspace();
    fakeBoth();
    // findAgentForRole('primary','openai') is the OLD provider-derived fallback; with two enabled openai
    // primaries it returns one deterministic pick. Pin the OTHER one and prove the run executes the PINNED id,
    // demonstrating the runner never consults the fallback helper for a pinned task.
    const fallback = await withTenant(w.ctx, (tx) => findAgentForRole(tx, w.ctx, 'primary', 'openai'));
    expect(fallback).not.toBeNull();
    const pin = fallback!.id === w.tomBrown ? w.leadEngineer : w.tomBrown;
    expect(pin).not.toBe(fallback!.id);
    const taskId = await withTenant(w.ctx, (tx) =>
      createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: false, primaryAgentId: pin }),
    );
    await startRun(w.ctx, taskId);
    const run = await runRow(taskId);
    expect(run!.primaryAgentId).toBe(pin); // the pinned, non-fallback agent executed
    expect(run!.requestedPrimaryAgentId).toBe(pin); // requested == actual on the run row
    expect(run!.primaryAgentId).not.toBe(fallback!.id);
  });

  it('a disabled primary is rejected at createTask (fail closed, no task)', async () => {
    const w = await freshWorkspace();
    await expect(
      withTenant(w.ctx, (tx) =>
        createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: false, primaryAgentId: w.disabledPrimary }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a cross-workspace primary id is rejected at createTask', async () => {
    const w = await freshWorkspace();
    const other = await freshWorkspace();
    await expect(
      withTenant(w.ctx, (tx) =>
        createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: false, primaryAgentId: other.tomBrown }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a wrong-role primary (a reviewer-role agent used as primary) fails closed at createTask', async () => {
    const w = await freshWorkspace();
    await expect(
      withTenant(w.ctx, (tx) =>
        createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: false, primaryAgentId: w.reviewer }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a legacy task with null assignedPrimaryAgentId fails closed at startRun; no fallback; task not mutated', async () => {
    const w = await freshWorkspace();
    const { openai, anthropic } = fakeBoth();
    // Insert a legacy/unpinned task directly (bypassing createTask), as a pre-P1a row would look.
    const taskId = (await db
      .insert(tasks)
      .values({ orgId, projectId: w.ctx.projectId, title: 'Legacy', input: 'x', providerSelection: 'openai', reviewEnabled: false, status: 'pending', createdBy: userId })
      .returning({ id: tasks.id }))[0]!.id;

    await expect(startRun(w.ctx, taskId)).rejects.toBeInstanceOf(AssignmentRequiredError);
    // The fail-closed decision happened BEFORE any provider dispatch: ZERO provider calls were made. This
    // proves the requested==actual/assignment check precedes execution (it never provider-resolves a fallback).
    expect(openai.requests.length).toBe(0);
    expect(anthropic.requests.length).toBe(0);
    // No run created, task not mutated (still pending, still unpinned).
    expect(await runRow(taskId)).toBeUndefined();
    const t = (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
    expect(t.status).toBe('pending');
    expect(t.assignedPrimaryAgentId).toBeNull();
    // A fail-closed audit was written in a SEPARATE committed tx.
    const a = await db.select({ action: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.entityId, taskId), eq(auditLogs.action, 'task.assignment_required')));
    expect(a.length).toBe(1);
  });

  it('a disabled primary that was pinned earlier fails closed at startRun (validation_failed audit, no run)', async () => {
    const w = await freshWorkspace();
    const { openai, anthropic } = fakeBoth();
    const taskId = await withTenant(w.ctx, (tx) =>
      createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: false, primaryAgentId: w.tomBrown }),
    );
    // Disable the pinned primary AFTER assignment.
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, w.tomBrown));

    await expect(startRun(w.ctx, taskId)).rejects.toBeInstanceOf(AssignmentRequiredError);
    // Fail-closed BEFORE dispatch: the pinned primary is no longer assignable, and the runner never falls back
    // to a provider-derived agent (findAgentForRole) — so ZERO provider calls occurred.
    expect(openai.requests.length).toBe(0);
    expect(anthropic.requests.length).toBe(0);
    expect(await runRow(taskId)).toBeUndefined();
    const a = await db.select({ action: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.entityId, taskId), eq(auditLogs.action, 'run.assignment_validation_failed')));
    expect(a.length).toBeGreaterThanOrEqual(1);
  });

  it('the exact reviewer executes (run.reviewerAgentId == task.assignedReviewerAgentId) and requested==actual', async () => {
    const w = await freshWorkspace();
    fakeBoth();
    const taskId = await withTenant(w.ctx, (tx) =>
      createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: true, primaryAgentId: w.tomBrown, reviewerAgentId: w.reviewer }),
    );
    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = await runRow(taskId);
    expect(run!.primaryAgentId).toBe(w.tomBrown);
    expect(run!.reviewerAgentId).toBe(w.reviewer);
    expect(run!.requestedReviewerAgentId).toBe(w.reviewer);
    // requested == actual on the run row, by construction.
    expect(run!.requestedPrimaryAgentId).toBe(run!.primaryAgentId);
    expect(run!.requestedReviewerAgentId).toBe(run!.reviewerAgentId);
  });

  it('review enabled without a reviewer is rejected; review disabled forbids a reviewer', async () => {
    const w = await freshWorkspace();
    await expect(
      withTenant(w.ctx, (tx) => createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: true, primaryAgentId: w.tomBrown, reviewerAgentId: null })),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      withTenant(w.ctx, (tx) => createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: false, primaryAgentId: w.tomBrown, reviewerAgentId: w.reviewer })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a disabled / cross-workspace / wrong-role reviewer fails closed at createTask', async () => {
    const w = await freshWorkspace();
    const other = await freshWorkspace();
    // wrong-role reviewer: a primary agent used as reviewer.
    await expect(
      withTenant(w.ctx, (tx) => createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: true, primaryAgentId: w.tomBrown, reviewerAgentId: w.leadEngineer })),
    ).rejects.toBeInstanceOf(ValidationError);
    // cross-workspace reviewer.
    await expect(
      withTenant(w.ctx, (tx) => createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: true, primaryAgentId: w.tomBrown, reviewerAgentId: other.reviewer })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('a primary cannot be its own reviewer (rejected at createTask via schema refinement)', async () => {
    const w = await freshWorkspace();
    await expect(
      withTenant(w.ctx, (tx) => createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: true, primaryAgentId: w.tomBrown, reviewerAgentId: w.tomBrown })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('assignment audits carry identity IDs but NEVER a system prompt or secret', async () => {
    const w = await freshWorkspace();
    fakeBoth();
    const taskId = await withTenant(w.ctx, (tx) =>
      createTask(tx, w.ctx, { title: 'T', input: 'x', providerSelection: 'openai', reviewEnabled: true, primaryAgentId: w.tomBrown, reviewerAgentId: w.reviewer }),
    );
    await startRun(w.ctx, taskId);
    const run = await runRow(taskId);
    // Gather every assignment-related audit detail for this task + run.
    const rows = await db
      .select({ action: auditLogs.action, detail: auditLogs.detail })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.projectId, w.ctx.projectId)));
    const assignmentRows = rows.filter((r) => r.action.includes('assignment'));
    expect(assignmentRows.length).toBeGreaterThan(0);
    const blob = JSON.stringify(rows.map((r) => r.detail));
    // The identity ids ARE present…
    const created = rows.find((r) => r.action === 'task.assignment_created')!;
    expect(JSON.stringify(created.detail)).toContain(w.tomBrown);
    const confirmed = rows.find((r) => r.action === 'run.assignment_confirmed')!;
    expect(JSON.stringify(confirmed.detail)).toContain(w.tomBrown);
    expect(rows.some((r) => r.action === 'reviewer.assignment_confirmed')).toBe(true);
    expect(run).toBeDefined();
    // …but no prompt text / secret / api-key pattern ever is.
    expect(blob).not.toContain(SECRET_PROMPT);
    expect(blob).not.toContain('SUPER_SECRET_PROMPT_MARKER_DO_NOT_LEAK');
    expect(blob).not.toMatch(/sk-[a-z0-9]{16,}/i);
    expect(blob).not.toContain('APP_ENCRYPTION_KEY');
    expect(blob).not.toContain('systemPrompt');
  });

  it('historical completed tasks & runs (unpinned) remain readable — no read regression', async () => {
    const w = await freshWorkspace();
    const taskId = (await db
      .insert(tasks)
      .values({ orgId, projectId: w.ctx.projectId, title: 'Old done', input: 'x', providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: userId })
      .returning({ id: tasks.id }))[0]!.id;
    const runId = (await db
      .insert(runs)
      .values({ orgId, projectId: w.ctx.projectId, taskId, status: 'completed', primaryAgentId: w.tomBrown, classification: 'live' })
      .returning({ id: runs.id }))[0]!.id;
    // Readable via ordinary tenant reads.
    const read = await withTenant(w.ctx, (tx) => tx.select().from(runs).where(eq(runs.id, runId)));
    expect(read[0]!.requestedPrimaryAgentId).toBeNull();
    expect(read[0]!.primaryAgentId).toBe(w.tomBrown);
    const t = await withTenant(w.ctx, (tx) => tx.select().from(tasks).where(eq(tasks.id, taskId)));
    expect(t[0]!.assignedPrimaryAgentId).toBeNull();
  });
});

describe.skipIf(!available)('P1a composite-FK / RLS tenant integrity', () => {
  it('the DB rejects pinning a task to a cross-workspace agent (composite FK)', async () => {
    const w = await freshWorkspace();
    const other = await freshWorkspace();
    // Direct insert (migration role) that tries to pin w's task to other's agent — the composite FK on
    // (org_id, project_id, agent_id) makes this impossible regardless of RLS.
    await expect(
      db.insert(tasks).values({
        orgId,
        projectId: w.ctx.projectId,
        title: 'X',
        input: 'x',
        providerSelection: 'openai',
        reviewEnabled: false,
        status: 'pending',
        createdBy: userId,
        assignedPrimaryAgentId: other.tomBrown,
      }),
    ).rejects.toThrow();
  });
});

describe.skipIf(!available)('P1a standing work pins exact employees', () => {
  it('createSchedule persists the assigned ids; a due tick pins the produced task to them', async () => {
    const w = await freshWorkspace();
    const scheduleId = await withTenant(w.ctx, (tx) =>
      createSchedule(tx, w.ctx, {
        title: 'Daily brief',
        input: 'summarize',
        providerSelection: 'openai',
        cadence: 'daily',
        reviewEnabled: true,
        assignedPrimaryAgentId: w.tomBrown,
        assignedReviewerAgentId: w.reviewer,
      }),
    );
    const sched = (await db.select().from(taskSchedules).where(eq(taskSchedules.id, scheduleId)))[0]!;
    expect(sched.assignedPrimaryAgentId).toBe(w.tomBrown);
    expect(sched.assignedReviewerAgentId).toBe(w.reviewer);

    // Make it due, then run the tick (fake provider so nothing bills).
    fakeBoth();
    await db.update(taskSchedules).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(taskSchedules.id, scheduleId));
    const result = await runDueSchedules(new Date());
    expect(result.enqueued).toBeGreaterThanOrEqual(1); // Hub P1d — the tick enqueues, it no longer runs inline.

    const produced = (await db.select().from(tasks).where(eq(tasks.scheduleId, scheduleId)))[0];
    expect(produced).toBeDefined();
    expect(produced!.assignedPrimaryAgentId).toBe(w.tomBrown);
    expect(produced!.assignedReviewerAgentId).toBe(w.reviewer);
    // The durable standing job executes through the worker path — and its run executed the pinned pair.
    await executeStandingTask(w.ctx, produced!.id);
    const run = (await db.select().from(runs).where(eq(runs.taskId, produced!.id)))[0];
    expect(run!.primaryAgentId).toBe(w.tomBrown);
    expect(run!.reviewerAgentId).toBe(w.reviewer);
  });

  // ---- Part B: a due schedule with a missing/invalid pin must NOT advance the clock. -------------------
  // Validation happens BEFORE any dispatch or clock advance: no task, no run, the schedule row is left
  // byte-for-byte unchanged (so the occurrence is neither consumed nor skipped — it stays due), and the only
  // side effect is one append-only schedule.assignment_required audit.

  const fullRow = async (id: string) => (await db.select().from(taskSchedules).where(eq(taskSchedules.id, id)))[0]!;
  const makeDue = (id: string) => db.update(taskSchedules).set({ nextRunAt: new Date(Date.now() - 60_000) }).where(eq(taskSchedules.id, id));
  const assignmentAudits = (scheduleId: string) =>
    db.select({ action: auditLogs.action, detail: auditLogs.detail }).from(auditLogs).where(and(eq(auditLogs.entityId, scheduleId), eq(auditLogs.action, 'schedule.assignment_required')));
  const tasksFor = (scheduleId: string) => db.select().from(tasks).where(eq(tasks.scheduleId, scheduleId));

  async function validSchedule(w: Seeded): Promise<string> {
    return withTenant(w.ctx, (tx) =>
      createSchedule(tx, w.ctx, {
        title: 'Daily brief',
        input: 'summarize',
        providerSelection: 'openai',
        cadence: 'daily',
        reviewEnabled: true,
        assignedPrimaryAgentId: w.tomBrown,
        assignedReviewerAgentId: w.reviewer,
      }),
    );
  }

  /** Break a valid schedule some way, make it due, tick once, and assert the row is byte-identical + no dispatch. */
  async function expectLeftDueUnchanged(scheduleId: string, expectedReason: string) {
    await makeDue(scheduleId);
    const before = await fullRow(scheduleId);
    fakeBoth();
    const result = await runDueSchedules(new Date());
    const after = await fullRow(scheduleId);
    // The ENTIRE row is unchanged — nextRunAt, lastRunAt, cadence, enabled, updatedAt, everything.
    expect(after).toEqual(before);
    // Still due (nextRunAt in the past) — the occurrence was neither consumed nor skipped.
    expect(after.nextRunAt.getTime()).toBeLessThan(Date.now());
    // No task and therefore no run were produced.
    expect((await tasksFor(scheduleId)).length).toBe(0);
    // Exactly the append-only audit, with a structured reason and the scheduleId.
    const audits = await assignmentAudits(scheduleId);
    expect(audits.length).toBe(1);
    expect(JSON.stringify(audits[0]!.detail)).toContain(expectedReason);
    expect(JSON.stringify(audits[0]!.detail)).toContain(scheduleId);
    // The tick summary counts it as assignment-required, not started.
    expect(result.assignmentRequired).toBeGreaterThanOrEqual(1);
    return before;
  }

  it('missing primary (legacy null pin): full row identical before/after, no task/run, one assignment_required audit', async () => {
    const w = await freshWorkspace();
    const scheduleId = (await db
      .insert(taskSchedules)
      .values({
        orgId, projectId: w.ctx.projectId, title: 'Legacy schedule', input: 'x', providerSelection: 'openai',
        reviewEnabled: false, cadence: 'daily', atHour: 6, nextRunAt: new Date(Date.now() - 60_000), enabled: true, createdBy: userId,
      })
      .returning({ id: taskSchedules.id }))[0]!.id;
    await expectLeftDueUnchanged(scheduleId, 'no_assigned_primary');
  });

  it('disabled pinned primary: row unchanged, no dispatch', async () => {
    const w = await freshWorkspace();
    const scheduleId = await validSchedule(w);
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, w.tomBrown));
    await expectLeftDueUnchanged(scheduleId, 'primary_not_assignable');
  });

  it('wrong-role pinned primary (role flipped to reviewer): row unchanged, no dispatch', async () => {
    const w = await freshWorkspace();
    const scheduleId = await validSchedule(w);
    // Simulate the pinned primary decaying into a non-primary role — getAssignableAgentById(...'primary') fails.
    await db.update(agents).set({ role: 'reviewer' }).where(eq(agents.id, w.tomBrown));
    await expectLeftDueUnchanged(scheduleId, 'primary_not_assignable');
  });

  it('disabled pinned reviewer (review enabled): row unchanged, no dispatch', async () => {
    const w = await freshWorkspace();
    const scheduleId = await validSchedule(w);
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, w.reviewer));
    await expectLeftDueUnchanged(scheduleId, 'reviewer_not_assignable');
  });

  it('review-enabled legacy schedule with a null reviewer pin: row unchanged, no dispatch', async () => {
    const w = await freshWorkspace();
    // Insert directly a review-enabled schedule whose reviewer pin was never set (a pre-P1a / decayed row).
    // Its primary is valid, so the reviewer branch is what fails closed.
    const scheduleId = (await db
      .insert(taskSchedules)
      .values({
        orgId, projectId: w.ctx.projectId, title: 'Review-enabled legacy', input: 'x', providerSelection: 'openai',
        reviewEnabled: true, assignedPrimaryAgentId: w.tomBrown, assignedReviewerAgentId: null,
        cadence: 'daily', atHour: 6, nextRunAt: new Date(Date.now() - 60_000), enabled: true, createdBy: userId,
      })
      .returning({ id: taskSchedules.id }))[0]!.id;
    await expectLeftDueUnchanged(scheduleId, 'review_enabled_without_reviewer');
  });

  it('a corrected schedule (valid exact assignment) dispatches normally and advances', async () => {
    const w = await freshWorkspace();
    const scheduleId = await validSchedule(w);
    // Break it, tick (stays due, unchanged), then FIX it and tick again → dispatches + advances.
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, w.tomBrown));
    await expectLeftDueUnchanged(scheduleId, 'primary_not_assignable');
    // Correct the assignment.
    await db.update(agents).set({ enabled: true }).where(eq(agents.id, w.tomBrown));
    const beforeFix = await fullRow(scheduleId);
    fakeBoth();
    const result = await runDueSchedules(new Date());
    const produced = await tasksFor(scheduleId);
    expect(produced.length).toBe(1);
    expect(produced[0]!.assignedPrimaryAgentId).toBe(w.tomBrown);
    expect(produced[0]!.assignedReviewerAgentId).toBe(w.reviewer);
    // Hub P1d — the tick enqueued a durable job; execute it through the worker path and assert the run's pins.
    expect(result.enqueued).toBeGreaterThanOrEqual(1);
    await executeStandingTask(w.ctx, produced[0]!.id);
    const run = (await db.select().from(runs).where(eq(runs.taskId, produced[0]!.id)))[0]!;
    expect(run.primaryAgentId).toBe(w.tomBrown);
    expect(run.reviewerAgentId).toBe(w.reviewer);
    // The clock advanced this time (nextRunAt moved into the future; lastRunAt was set).
    const after = await fullRow(scheduleId);
    expect(after.nextRunAt.getTime()).toBeGreaterThan(beforeFix.nextRunAt.getTime());
    expect(after.lastRunAt).not.toBeNull();
  });

  it('N repeated ticks on an invalid schedule: row still identical and still due each time', async () => {
    const w = await freshWorkspace();
    const scheduleId = await validSchedule(w);
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, w.tomBrown));
    await makeDue(scheduleId);
    const before = await fullRow(scheduleId);
    for (let i = 0; i < 3; i++) {
      fakeBoth();
      await runDueSchedules(new Date());
      const after = await fullRow(scheduleId);
      expect(after).toEqual(before); // unchanged every tick
      expect(after.nextRunAt.getTime()).toBeLessThan(Date.now()); // still due
      expect((await tasksFor(scheduleId)).length).toBe(0); // never dispatched
    }
    // One audit per tick (append-only), and never a produced task.
    expect((await assignmentAudits(scheduleId)).length).toBe(3);
  });
});
