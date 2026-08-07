import { randomUUID } from 'node:crypto';
import { and, eq, isNotNull, lt } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { assertDisposableDbForVerification } from '@tests/support/require-disposable-db';
import { type TenantContext } from '@/types/domain';
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
  runExecutionCheckpoints,
  runJobs,
  runs,
  runSteps,
  spendLimits,
  tasks,
  usageEvents,
} from '@/db/schema';
import { setProviderOverrideForTests } from '@/providers/registry';
import { __setRunTestHookForTests, resumeRun, startRun } from '@/domain/tasks/runner';
import { requestCancellation } from '@/domain/tasks/tasks';
import { enqueueRun, renewRunJobLease, runClaimedJob } from '@/domain/jobs/jobs';
import { LeaseLostSignal } from '@/orchestration/engine';
import { anchorReviewClaims } from '@/orchestration/prompts';

/**
 * Hub P1d Stage 2 — crash-safe queued runs + idempotent finalization.
 *
 * Fake providers with a deterministic crash-injection seam (`__setRunTestHookForTests`) drive the real
 * dispatch path against real Postgres (disposable DB when opted in). Each crash point commits everything up
 * to it and throws, exactly as a process death would; a resume then proves: no re-bill of a checkpointed
 * step, ZERO automatic retry on an uncertain dispatch, idempotent finalization, lease-owner-only finalize,
 * and cooperative cancellation with no fabricated result.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');
// Many runs by one user in one minute would otherwise trip the per-user run rate limit; lift it for this suite.
process.env.RATE_LIMIT_RUNS_PER_MINUTE = '100000';

assertDisposableDbForVerification('run-reliability.test');

let available = false;
try {
  const db = getSetupDb();
  await db.select({ one: profiles.id }).from(profiles).limit(1);
  await db.execute(`select 1 from run_execution_checkpoints limit 1`);
  available = true;
} catch (err) {
  console.warn(`[run-reliability.test] SKIPPING — P1d schema not present: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let userId = '';

interface Workspace {
  ctx: TenantContext;
  primaryId: string;
  reviewerId: string;
}

async function makeWorkspace(): Promise<Workspace> {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('rel'), name: 'Rel' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  const primaryId = (
    await db.insert(agents).values({ orgId, projectId: pid, name: `P-${randomUUID().slice(0, 6)}`, role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'primary' }).returning({ id: agents.id })
  )[0]!.id;
  const reviewerId = (
    await db.insert(agents).values({ orgId, projectId: pid, name: `R-${randomUUID().slice(0, 6)}`, role: 'reviewer', provider: 'anthropic', model: 'claude-x', systemPrompt: 'reviewer' }).returning({ id: agents.id })
  )[0]!.id;
  return { ctx: { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' }, primaryId, reviewerId };
}

async function mkTask(w: Workspace, opts: { review?: boolean } = {}): Promise<string> {
  const review = opts.review ?? false;
  const t = await db
    .insert(tasks)
    .values({
      orgId,
      projectId: w.ctx.projectId,
      title: 'Rel task',
      input: 'Do the work.',
      providerSelection: review ? 'both' : 'openai',
      reviewEnabled: review,
      status: 'pending',
      createdBy: userId,
      assignedPrimaryAgentId: w.primaryId,
      assignedReviewerAgentId: review ? w.reviewerId : null,
    })
    .returning({ id: tasks.id });
  return t[0]!.id;
}

const runFor = async (taskId: string) => (await db.select().from(runs).where(eq(runs.taskId, taskId)))[0]!;
const runsFor = async (taskId: string) => db.select().from(runs).where(eq(runs.taskId, taskId));
const taskRow = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
// ENGINE-step checkpoints only (primary=1 / review=2 / revision=3). Hub P1d models post-run extraction as
// reserved reliability steps (decision=101, knowledge=102) with their own checkpoints + fenced provider calls;
// those are asserted separately (see `extractionCheckpoints` below and extraction-reliability.test.ts), so the
// engine-step crash-safety assertions here stay focused and unaffected by extraction.
const EXTRACTION_STEP_MIN = 100;
const checkpoints = async (runId: string) =>
  db
    .select()
    .from(runExecutionCheckpoints)
    .where(and(eq(runExecutionCheckpoints.runId, runId), lt(runExecutionCheckpoints.stepNumber, EXTRACTION_STEP_MIN)))
    .orderBy(runExecutionCheckpoints.stepNumber);
const stepUsage = async (runId: string) =>
  db.select().from(usageEvents).where(and(eq(usageEvents.runId, runId), isNotNull(usageEvents.runStepId)));
const stepsFor = async (runId: string) => db.select().from(runSteps).where(eq(runSteps.runId, runId)).orderBy(runSteps.stepNumber);
async function auditsFor(runId: string): Promise<string[]> {
  const rows = await db.select({ a: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.entityId, runId), eq(auditLogs.orgId, orgId)));
  return rows.map((r) => r.a);
}

function openaiOnly(reply = 'Primary answer.'): FakeProvider {
  const p = new FakeProvider('openai').reply(reply);
  p.defaultReply = 'noop'; // extraction calls fall through to this, never a scripted primary reply
  setProviderOverrideForTests((id) => (id === 'openai' ? p : undefined));
  return p;
}
function crossPair(reviewText: string, primaryReply = 'Primary answer.', revisionReply = 'Revised answer.') {
  const openai = new FakeProvider('openai').reply(primaryReply).reply(revisionReply);
  openai.defaultReply = 'noop';
  const anthropic = new FakeProvider('anthropic').reply(reviewText);
  anthropic.defaultReply = 'noop';
  setProviderOverrideForTests((id) => (id === 'openai' ? openai : id === 'anthropic' ? anthropic : undefined));
  return { openai, anthropic };
}

const APPROVE = 'VERDICT: approve\n\nLooks good.';
const REVISE = `\`\`\`review-result\n${JSON.stringify({ verdict: 'revise', findings: [{ claimAnchor: anchorReviewClaims('Primary answer.')[0]!.anchor, severity: 'minor', rationale: 'Add a step.', requestedRevision: 'Add the missing step.' }] })}\n\`\`\``;

beforeAll(async () => {
  if (!available) return;
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `rel-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `rel-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
});
afterAll(async () => {
  if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});
afterEach(() => {
  __setRunTestHookForTests(null);
  setProviderOverrideForTests(null);
});

describe.skipIf(!available)('Hub P1d Stage 2 — crash-safe runs', () => {
  // ---- PRIMARY ------------------------------------------------------------
  it('crash BEFORE dispatch → safe retry resumes the SAME run, exactly one provider bill total', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const p = openaiOnly();

    __setRunTestHookForTests(async (label, step) => {
      if (label === 'before-dispatch' && step === 1) throw new Error('CRASH before dispatch');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);

    const crashed = await runFor(taskId);
    expect(crashed.reliabilityState).toBe('not_dispatched');
    expect(crashed.status).toBe('running');
    expect((await checkpoints(crashed.id)).length).toBe(0);
    expect((await stepUsage(crashed.id)).length).toBe(0); // nothing billed before dispatch

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    expect((await runsFor(taskId)).length).toBe(1); // SAME run reused, no new run
    const done = await runFor(taskId);
    expect(done.id).toBe(crashed.id);
    expect(done.reliabilityState).toBe('completed');
    expect((await checkpoints(done.id)).length).toBe(1); // one provider step (primary)
    expect((await stepUsage(done.id)).length).toBe(1); // billed exactly once, total
    expect(done.consolidatedResult).toContain('Primary answer.');
    void p;
  });

  it('crash AFTER dispatch-start but BEFORE result checkpoint → reconciliation_required, ZERO auto retry, no provider bill', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const p = openaiOnly();

    __setRunTestHookForTests(async (label, step) => {
      if (label === 'after-intent' && step === 1) throw new Error('CRASH after intent');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    const crashed = await runFor(taskId);
    expect(crashed.reliabilityState).toBe('dispatching');
    expect((await checkpoints(crashed.id)).length).toBe(0);

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const done = await runFor(taskId);
    expect(done.reliabilityState).toBe('reconciliation_required');
    expect(done.status).toBe('failed');
    expect((await taskRow(taskId)).status).toBe('failed');
    expect((await checkpoints(done.id)).length).toBe(0);
    expect((await stepUsage(done.id)).length).toBe(0); // NEVER billed — no silent rebill
    expect(await auditsFor(done.id)).toContain('run.uncertain_outcome_detected');
    // The provider was never called on the resume (no auto retry of an uncertain dispatch).
    expect(p.requests.length).toBe(0);
  });

  it('crash AFTER the provider returns but BEFORE the checkpoint → the request crossed the boundary (count=1), reconciliation_required, never auto-repeated', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const p = openaiOnly('Boundary answer.');

    // Crash at the durable boundary AFTER provider.execute() returned but BEFORE persistStep commits the
    // checkpoint. The fake provider has already RECORDED (counted) the request — proving it crossed the
    // provider boundary — so this is a genuine mid-call uncertain outcome, not a pre-dispatch crash.
    __setRunTestHookForTests(async (label, step) => {
      if (label === 'before-checkpoint' && step === 1) throw new Error('CRASH after provider returned, before checkpoint');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    expect(p.requests.length).toBe(1); // the request crossed the provider boundary exactly once

    const crashed = await runFor(taskId);
    expect(crashed.reliabilityState).toBe('dispatching'); // dispatch intent durable, result unknown
    expect((await checkpoints(crashed.id)).length).toBe(0); // no result checkpoint committed
    expect((await stepUsage(crashed.id)).length).toBe(0); // no fabricated token/cost

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const done = await runFor(taskId);
    expect(done.reliabilityState).toBe('reconciliation_required');
    expect(done.status).toBe('failed');
    expect(done.consolidatedResult).toBeNull(); // ambiguous outcome — NOT asserted as a real (zero-cost) result
    expect((await stepUsage(done.id)).length).toBe(0); // the uncertain charge is represented as UNKNOWN, not 0
    expect(p.requests.length).toBe(1); // NEVER auto-repeated after the uncertain dispatch
    expect(await auditsFor(done.id)).toContain('run.uncertain_outcome_detected');
  });

  it('crash AFTER result checkpoint → finalization resumes with NO second provider call and the same result', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    openaiOnly('Deterministic primary.');

    __setRunTestHookForTests(async (label, step) => {
      if (label === 'after-checkpoint' && step === 1) throw new Error('CRASH after checkpoint');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    const crashed = await runFor(taskId);
    expect(crashed.reliabilityState).toBe('result_checkpointed');
    expect((await checkpoints(crashed.id)).length).toBe(1);
    expect((await stepUsage(crashed.id)).length).toBe(1);
    const originalText = (await checkpoints(crashed.id))[0]!.responseText;

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const done = await runFor(taskId);
    expect(done.reliabilityState).toBe('completed');
    expect((await checkpoints(done.id)).length).toBe(1); // still ONE — not re-run
    expect((await stepUsage(done.id)).length).toBe(1); // no double bill
    expect((await checkpoints(done.id))[0]!.responseText).toBe(originalText); // same result
    expect(done.consolidatedResult).toContain('Deterministic primary.');
  });

  it('resumed finalization is idempotent (finalization_resumed) — no duplicate usage/steps/audits', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    openaiOnly();

    // Crash between the finalizing marker (phase 1) and the terminal apply (phase 2).
    __setRunTestHookForTests(async (label) => {
      if (label === 'after-finalizing-marker') throw new Error('CRASH mid-finalize');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    const crashed = await runFor(taskId);
    expect(crashed.reliabilityState).toBe('finalizing');
    expect(crashed.checkpointedResult).toContain('Primary answer.');
    const usageBefore = (await stepUsage(crashed.id)).length;
    const stepsBefore = (await stepsFor(crashed.id)).length;

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const done = await runFor(taskId);
    expect(done.reliabilityState).toBe('completed');
    expect((await stepUsage(done.id)).length).toBe(usageBefore); // no duplicate billing
    expect((await stepsFor(done.id)).length).toBe(stepsBefore); // no duplicate steps
    const acts = await auditsFor(done.id);
    expect(acts).toContain('run.finalization_resumed');
    expect(acts).toContain('run.finalization_completed');
    expect(acts.filter((a) => a === 'run.completed').length).toBe(1); // completed exactly once
  });

  it('crash after finalization but before job ack → a reclaim drains the job with no provider replay / no duplicate finalization', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    openaiOnly();
    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = await runFor(taskId);
    const usageBefore = (await stepUsage(run.id)).length;
    const cpBefore = (await checkpoints(run.id)).length;

    // Simulate a job that finished the run but was never ack'd (still 'running').
    const jr = (
      await db.insert(runJobs).values({ orgId, projectId: w.ctx.projectId, taskId, status: 'running', leasedUntil: new Date(Date.now() + 60_000) }).returning({ id: runJobs.id })
    )[0]!.id;
    const result = await runClaimedJob({ jobId: jr, taskId, orgId, projectId: w.ctx.projectId, createdBy: userId, projectRole: 'admin', attempt: 1 });
    expect(result).toBeNull(); // completed task → drained, nothing executed
    expect((await db.select().from(runJobs).where(eq(runJobs.id, jr)))[0]!.status).toBe('done');
    // No provider replay, no duplicate finalization.
    expect((await stepUsage(run.id)).length).toBe(usageBefore);
    expect((await checkpoints(run.id)).length).toBe(cpBefore);
    expect((await runFor(taskId)).reliabilityState).toBe('completed');
  });

  // ---- REVIEW -------------------------------------------------------------
  it('checkpointed primary is NOT re-run after crash-before-review; reviewer then runs once', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w, { review: true });
    crossPair(APPROVE);

    __setRunTestHookForTests(async (label, step) => {
      if (label === 'after-checkpoint' && step === 1) throw new Error('CRASH after primary checkpoint');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    const crashed = await runFor(taskId);
    expect((await checkpoints(crashed.id)).map((c) => c.stepNumber)).toEqual([1]);

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const done = await runFor(taskId);
    const cps = await checkpoints(done.id);
    expect(cps.map((c) => c.stepNumber)).toEqual([1, 2]); // primary (from checkpoint) + review (fresh)
    // Primary billed once total (not re-run); review billed once.
    expect((await stepUsage(done.id)).length).toBe(2);
  });

  it('an UNCERTAIN reviewer dispatch is not auto-repeated → reconciliation_required, primary preserved', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w, { review: true });
    const { anthropic } = crossPair(APPROVE);

    __setRunTestHookForTests(async (label, step) => {
      if (label === 'after-intent' && step === 2) throw new Error('CRASH after review intent');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    const crashed = await runFor(taskId);
    expect(crashed.reliabilityState).toBe('dispatching');
    expect((await checkpoints(crashed.id)).map((c) => c.stepNumber)).toEqual([1]); // primary checkpointed

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const done = await runFor(taskId);
    expect(done.reliabilityState).toBe('reconciliation_required');
    expect((await checkpoints(done.id)).map((c) => c.stepNumber)).toEqual([1]); // primary intact, no review checkpoint
    expect(anthropic.requests.length).toBe(0); // reviewer NEVER called after the uncertain dispatch
  });

  it('a checkpointed reviewer resumes without another reviewer call', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w, { review: true });
    const { anthropic } = crossPair(APPROVE);

    __setRunTestHookForTests(async (label, step) => {
      if (label === 'after-checkpoint' && step === 2) throw new Error('CRASH after review checkpoint');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    const crashed = await runFor(taskId);
    expect((await checkpoints(crashed.id)).map((c) => c.stepNumber)).toEqual([1, 2]);
    const reviewerCallsAtCrash = anthropic.requests.length;

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    // The reviewer was not called again on resume (its result came from the checkpoint).
    expect(anthropic.requests.length).toBe(reviewerCallsAtCrash);
    expect((await stepUsage((await runFor(taskId)).id)).length).toBe(2); // primary + review, each once
  });

  it('the ≤1 revision loop runs bounded and non-duplicating (MAX_REVISIONS enforced)', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w, { review: true });
    crossPair(REVISE);
    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = await runFor(taskId);
    expect((await stepsFor(run.id)).map((s) => s.kind)).toEqual(['primary', 'review', 'revision', 'consolidate']);
    // Exactly three provider steps, each billed once — the revision does not duplicate primary/review usage.
    expect((await stepUsage(run.id)).length).toBe(3);
    expect((await checkpoints(run.id)).map((c) => c.stepNumber)).toEqual([1, 2, 3]);
    expect(run.consolidatedResult).toContain('Revised answer.');
  });

  // ---- LEASE --------------------------------------------------------------
  it('lease ownership token: a claim owns it; a reclaim invalidates the old token and the new one wins', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    await withTenant(w.ctx, (tx) => enqueueRun(tx, w.ctx, taskId));
    // Claim via the dispatcher (the interactive path) to get a real attempt token.
    const { claimJobForTask } = await import('@/domain/jobs/jobs');
    const claimed = await claimJobForTask(w.ctx, taskId);
    expect(claimed).not.toBeNull();
    expect(await renewRunJobLease(claimed!.jobId, claimed!.attempt)).toBe(true);

    // Reclaim: expire + requeue + claim again → attempts increments → the OLD token loses, the NEW wins.
    await db.update(runJobs).set({ leasedUntil: new Date(Date.now() - 60_000) }).where(eq(runJobs.id, claimed!.jobId));
    await getSetupDb().execute(`select app.requeue_run_job('${claimed!.jobId}')`);
    const reclaim = await claimJobForTask(w.ctx, taskId);
    expect(reclaim!.attempt).toBeGreaterThan(claimed!.attempt);
    expect(await renewRunJobLease(claimed!.jobId, claimed!.attempt)).toBe(false); // stale token rejected
    expect(await renewRunJobLease(reclaim!.jobId, reclaim!.attempt)).toBe(true); // winner owns it
  });

  it('a stale worker cannot dispatch or finalize — it aborts at the boundary; the winner finalizes', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    openaiOnly();
    await withTenant(w.ctx, (tx) => enqueueRun(tx, w.ctx, taskId));
    const { claimJobForTask } = await import('@/domain/jobs/jobs');
    const staleClaim = await claimJobForTask(w.ctx, taskId);
    // The stale worker's lease is reclaimed before it runs.
    await db.update(runJobs).set({ leasedUntil: new Date(Date.now() - 60_000) }).where(eq(runJobs.id, staleClaim!.jobId));
    await getSetupDb().execute(`select app.requeue_run_job('${staleClaim!.jobId}')`);
    const winnerClaim = await claimJobForTask(w.ctx, taskId);

    const staleCtx = { jobId: staleClaim!.jobId, attempt: staleClaim!.attempt, ownsLease: () => renewRunJobLease(staleClaim!.jobId, staleClaim!.attempt) };
    // The stale worker fails closed at the first dispatch boundary (no provider call, no finalize).
    await expect(startRun(w.ctx, taskId, undefined, staleCtx)).rejects.toBeInstanceOf(LeaseLostSignal);
    const afterStale = await runFor(taskId);
    expect(afterStale.reliabilityState).toBe('not_dispatched'); // untouched by the stale worker

    // The winner (a fresh token) resumes the same run and finalizes it.
    const winnerCtx = { jobId: winnerClaim!.jobId, attempt: winnerClaim!.attempt, ownsLease: () => renewRunJobLease(winnerClaim!.jobId, winnerClaim!.attempt) };
    const outcome = await resumeRun(w.ctx, taskId, undefined, winnerCtx);
    expect(outcome.status).toBe('completed');
    expect((await runsFor(taskId)).length).toBe(1); // one terminal outcome, same run
  });

  // ---- CANCELLATION -------------------------------------------------------
  it('cancelling QUEUED work = zero provider calls (task cancelled, job drained, no run)', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const p = openaiOnly();
    await withTenant(w.ctx, (tx) => enqueueRun(tx, w.ctx, taskId));
    const decision = await withTenant(w.ctx, (tx) => requestCancellation(tx, w.ctx, taskId, 'not needed'));
    expect(decision).toBe('cancelled_queued');
    expect((await taskRow(taskId)).status).toBe('cancelled');

    // A worker that later claims the job drains it with zero provider calls and creates no run.
    const jobId = (await db.select().from(runJobs).where(eq(runJobs.taskId, taskId)))[0]!.id;
    const result = await runClaimedJob({ jobId, taskId, orgId, projectId: w.ctx.projectId, createdBy: userId, projectRole: 'admin', attempt: 1 });
    expect(result).toBeNull();
    expect((await db.select().from(runJobs).where(eq(runJobs.id, jobId)))[0]!.status).toBe('done');
    expect((await runsFor(taskId)).length).toBe(0);
    expect(p.requests.length).toBe(0);
  });

  it('cancel BEFORE dispatch (claimed, not yet dispatched) prevents dispatch — zero provider calls', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const p = openaiOnly();

    // At the first dispatch boundary, inject a cooperative cancel; the boundary then honors it.
    __setRunTestHookForTests(async (label, step) => {
      if (label === 'before-dispatch' && step === 1) {
        await withTenant(w.ctx, (tx) => requestCancellation(tx, w.ctx, taskId, 'stop now'));
      }
    });
    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('cancelled');
    const run = await runFor(taskId);
    expect(run.reliabilityState).toBe('cancelled');
    expect((await taskRow(taskId)).status).toBe('cancelled');
    expect((await checkpoints(run.id)).length).toBe(0);
    expect((await stepUsage(run.id)).length).toBe(0);
    expect(p.requests.length).toBe(0); // never dispatched
    expect(await auditsFor(run.id)).toContain('run.cancelled');
  });

  it('cancel DURING an uncertain dispatch is recorded honestly — the uncertain outcome is preserved, not fabricated', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    openaiOnly();

    __setRunTestHookForTests(async (label, step) => {
      if (label === 'after-intent' && step === 1) throw new Error('CRASH after intent');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    // A cancel arrives while the run is uncertain (dispatching, result unknown).
    await withTenant(w.ctx, (tx) => requestCancellation(tx, w.ctx, taskId, 'cancel please'));

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    // Uncertain outcome WINS over the late cancel — no fabricated result, no false "cancelled/completed".
    expect(outcome.status).toBe('reconciliation_required');
    const run = await runFor(taskId);
    expect(run.reliabilityState).toBe('reconciliation_required');
    expect(run.consolidatedResult).toBeNull();
  });

  it('a late cancel cannot overwrite an already-finalized completed run', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    openaiOnly();
    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const before = await runFor(taskId);

    // The task is completed → the cooperative cancel is refused; the checkpointed result stands.
    await expect(withTenant(w.ctx, (tx) => requestCancellation(tx, w.ctx, taskId, 'too late'))).rejects.toThrow();
    const after = await runFor(taskId);
    expect(after.reliabilityState).toBe('completed');
    expect(after.consolidatedResult).toBe(before.consolidatedResult);
    expect((await stepUsage(after.id)).length).toBe(1); // no duplicate billing from the cancel attempt
  });
});
