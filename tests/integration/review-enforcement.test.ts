import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import {
  agents,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  runs,
  runExecutionCheckpoints,
  runSteps,
  spendLimits,
  tasks,
  usageEvents,
} from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { setProviderOverrideForTests } from '@/providers/registry';
import { anchorReviewClaims } from '@/orchestration/prompts';
import { startRun, resumeRun } from '@/domain/tasks/runner';
import { enqueueRun, claimJobForTask, runClaimedJob } from '@/domain/jobs/jobs';
import { BudgetExceededError } from '@/lib/errors';

/**
 * Answer-routing Phase 1 — END-TO-END enforcement through the REAL dispatch path (startRun → getProvider),
 * verified at the API/history level: the persisted `runs` row (requested/effective mode, policy decision,
 * forced override, review outcome), the run_steps, and the consolidated text. Fake providers injected via the
 * registry seam — NO external model call, NO spend. Because startRun is the single execution choke point for
 * UI-enqueue, the worker/queue, and direct scripts, enforcing here covers every entry point: a browser- or
 * model-supplied value never reaches the policy decision, which is made server-side from persisted task state.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');
// This suite starts many runs in quick succession; lift the per-minute run rate limit so the cases under test
// (budget, enforcement) are what gate, not the rate limiter. Does not affect production config.
process.env.RATE_LIMIT_RUNS_PER_MINUTE = '1000';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[review-enforcement.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let baseCtx: TenantContext;

const PRIMARY_TEXT = 'Primary draft answer.';

function reviewApprove() {
  return `\`\`\`review-result\n${JSON.stringify({ verdict: 'approve', findings: [] })}\n\`\`\``;
}
function reviewReject() {
  const anchor = anchorReviewClaims(PRIMARY_TEXT)[0]!.anchor;
  return `\`\`\`review-result\n${JSON.stringify({ verdict: 'reject', findings: [{ claimAnchor: anchor, severity: 'critical', rationale: 'A blocking problem.' }] })}\n\`\`\``;
}

/**
 * Injects a fresh pair of fake providers for one run. `reviewer` scripts the single reviewer call:
 *   fail             → 'auth' (CONCLUSIVE not-executed → a clean failed review step → required_unmet)
 *   ambiguous        → 'overloaded' (UNCERTAIN; may have executed+charged → reconciliation, NOT a draft)
 *   ambiguous_timeout→ 'timeout'    (UNCERTAIN → reconciliation)
 */
function injectProviders(reviewer: 'approve' | 'reject' | 'fail' | 'ambiguous' | 'ambiguous_timeout' | 'none') {
  const openai = new FakeProvider('openai');
  openai.reply(PRIMARY_TEXT); // primary step; later extraction calls fall back to defaultReply 'ok'
  const anthropic = new FakeProvider('anthropic');
  if (reviewer === 'approve') anthropic.reply(reviewApprove());
  else if (reviewer === 'reject') anthropic.reply(reviewReject());
  else if (reviewer === 'fail') anthropic.fail('auth');
  else if (reviewer === 'ambiguous') anthropic.fail('overloaded');
  else if (reviewer === 'ambiguous_timeout') anthropic.fail('timeout');
  setProviderOverrideForTests((id) => (id === 'openai' ? openai : id === 'anthropic' ? anthropic : undefined));
}

async function makeWorkspace(budgetMicros = 100_000_000n) {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('rev'), name: 'W' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: baseCtx.userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: budgetMicros });
  const ctx: TenantContext = { ...baseCtx, projectId: pid };
  const primaryId = (await db.insert(agents).values({ orgId, projectId: pid, name: 'Primary', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'You are primary.', temperatureMilli: 700, maxOutputTokens: 2048 }).returning({ id: agents.id }))[0]!.id;
  const reviewerId = (await db.insert(agents).values({ orgId, projectId: pid, name: 'Reviewer', role: 'reviewer', provider: 'anthropic', model: 'claude-x', systemPrompt: 'You are reviewer.', temperatureMilli: 500, maxOutputTokens: 2048 }).returning({ id: agents.id }))[0]!.id;
  return { ctx, pid, primaryId, reviewerId };
}

async function makeTask(opts: {
  ctx: TenantContext;
  primaryId: string;
  reviewerId: string | null;
  reviewEnabled: boolean;
  quickExempt: boolean | null;
}) {
  return (
    await db
      .insert(tasks)
      .values({
        orgId,
        projectId: opts.ctx.projectId,
        title: 'T',
        input: 'Do the thing.',
        providerSelection: 'both',
        reviewEnabled: opts.reviewEnabled,
        quickExempt: opts.quickExempt,
        status: 'pending',
        createdBy: opts.ctx.userId,
        assignedPrimaryAgentId: opts.primaryId,
        assignedReviewerAgentId: opts.reviewerId,
      })
      .returning({ id: tasks.id })
  )[0]!.id;
}

async function runRow(taskId: string) {
  return (await db.select().from(runs).where(eq(runs.taskId, taskId)).limit(1))[0]!;
}
async function reviewStep(runId: string) {
  return (await db.select().from(runSteps).where(and(eq(runSteps.runId, runId), eq(runSteps.kind, 'review'))).limit(1))[0] ?? null;
}

beforeAll(async () => {
  if (!available) return;
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `rev-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `rev-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  baseCtx = { userId, orgId, projectId: '', orgRole: 'owner', projectRole: 'admin' };
});

afterEach(() => setProviderOverrideForTests(null));
afterAll(() => setProviderOverrideForTests(null));

describe('answer-routing Phase 1 — review enforcement (API/history level)', () => {
  it.runIf(available)('allowed Quick (exempt task) — runs primary-only, outcome omitted', async () => {
    const ws = await makeWorkspace();
    injectProviders('none');
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: null, reviewEnabled: false, quickExempt: true });
    const outcome = await startRun(ws.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = await runRow(taskId);
    expect(run.requestedMode).toBe('quick');
    expect(run.effectiveMode).toBe('quick');
    expect(run.reviewRequired).toBe(false);
    expect(run.reviewForced).toBe(false);
    expect(run.reviewOutcome).toBe('omitted');
    expect(await reviewStep(run.id)).toBeNull();
    expect(run.consolidatedResult).not.toContain('UNREVIEWED DRAFT');
  });

  it.runIf(available)('ordinary Reviewed — reviewer approves, outcome reviewed', async () => {
    const ws = await makeWorkspace();
    injectProviders('approve');
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: ws.reviewerId, reviewEnabled: true, quickExempt: null });
    await startRun(ws.ctx, taskId);
    const run = await runRow(taskId);
    expect(run.effectiveMode).toBe('reviewed');
    expect(run.reviewForced).toBe(false);
    expect(run.reviewOutcome).toBe('reviewed');
    expect((await reviewStep(run.id))?.verdict).toBe('approve');
  });

  it.runIf(available)('forced Reviewed — Quick request on a NON-exempt task is forced to Reviewed (direct-call bypass blocked)', async () => {
    const ws = await makeWorkspace();
    injectProviders('approve');
    // reviewEnabled:false is a QUICK request from the caller; the task is not exempt, so the server forces review.
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: ws.reviewerId, reviewEnabled: false, quickExempt: false });
    await startRun(ws.ctx, taskId);
    const run = await runRow(taskId);
    expect(run.requestedMode).toBe('quick');
    expect(run.effectiveMode).toBe('reviewed');
    expect(run.reviewRequired).toBe(true);
    expect(run.reviewForced).toBe(true);
    expect(run.reviewOutcome).toBe('reviewed');
    expect(await reviewStep(run.id)).not.toBeNull(); // the reviewer actually ran
  });

  it.runIf(available)('forced review that subsequently FAILS — outcome required_unmet, unreviewed-draft banner', async () => {
    const ws = await makeWorkspace();
    injectProviders('fail');
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: ws.reviewerId, reviewEnabled: false, quickExempt: false });
    await startRun(ws.ctx, taskId);
    const run = await runRow(taskId);
    expect(run.reviewForced).toBe(true);
    expect(run.reviewOutcome).toBe('required_unmet');
    expect(run.consolidatedResult).toContain('UNREVIEWED DRAFT');
    expect((await reviewStep(run.id))?.succeeded).toBe(false);
  });

  it.runIf(available)('required review with NO reviewer assigned — proceeds as unreviewed draft, does not hard-fail', async () => {
    const ws = await makeWorkspace();
    injectProviders('none');
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: null, reviewEnabled: false, quickExempt: false });
    const outcome = await startRun(ws.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = await runRow(taskId);
    expect(run.effectiveMode).toBe('reviewed');
    expect(run.reviewForced).toBe(true);
    expect(run.reviewOutcome).toBe('required_unmet');
    expect(run.consolidatedResult).toContain('UNREVIEWED DRAFT');
  });

  it.runIf(available)('REQUIRED vs OPTIONAL reviewer failure are distinguished', async () => {
    // Required: not exempt → required_unmet.
    const req = await makeWorkspace();
    injectProviders('fail');
    const reqTask = await makeTask({ ctx: req.ctx, primaryId: req.primaryId, reviewerId: req.reviewerId, reviewEnabled: true, quickExempt: null });
    await startRun(req.ctx, reqTask);
    const reqRun = await runRow(reqTask);
    expect(reqRun.reviewRequired).toBe(true);
    expect(reqRun.reviewOutcome).toBe('required_unmet');
    expect(reqRun.consolidatedResult).toContain('UNREVIEWED DRAFT');

    // Optional: exempt task but caller chose Reviewed → optional review; a failure degrades, no required banner.
    const opt = await makeWorkspace();
    injectProviders('fail');
    const optTask = await makeTask({ ctx: opt.ctx, primaryId: opt.primaryId, reviewerId: opt.reviewerId, reviewEnabled: true, quickExempt: true });
    await startRun(opt.ctx, optTask);
    const optRun = await runRow(optTask);
    expect(optRun.reviewRequired).toBe(false);
    expect(optRun.reviewOutcome).toBe('optional_degraded');
    expect(optRun.consolidatedResult).not.toContain('UNREVIEWED DRAFT');
  });

  it.runIf(available)('negative verdict (reject) is a completed review, not unmet', async () => {
    const ws = await makeWorkspace();
    injectProviders('reject');
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: ws.reviewerId, reviewEnabled: true, quickExempt: null });
    await startRun(ws.ctx, taskId);
    const run = await runRow(taskId);
    expect(run.reviewOutcome).toBe('reviewed');
    expect((await reviewStep(run.id))?.verdict).toBe('reject');
    expect(run.consolidatedResult).not.toContain('UNREVIEWED DRAFT');
  });

  it.runIf(available)('UNCERTAIN reviewer outcome (ambiguous overload) is PRESERVED as reconciliation, not a draft', async () => {
    const ws = await makeWorkspace();
    injectProviders('ambiguous');
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: ws.reviewerId, reviewEnabled: true, quickExempt: null });
    const outcome = await startRun(ws.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const run = await runRow(taskId);
    expect(run.status).toBe('failed');
    expect(run.reliabilityState).toBe('reconciliation_required');
    // Provider uncertainty is NOT erased into an unreviewed draft: no outcome, no consolidated banner.
    expect(run.reviewOutcome).toBeNull();
    expect(run.consolidatedResult).toBeNull();
  });

  it.runIf(available)('UNCERTAIN reviewer outcome (ambiguous timeout) is PRESERVED as reconciliation', async () => {
    const ws = await makeWorkspace();
    injectProviders('ambiguous_timeout');
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: ws.reviewerId, reviewEnabled: true, quickExempt: null });
    const outcome = await startRun(ws.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const run = await runRow(taskId);
    expect(run.reliabilityState).toBe('reconciliation_required');
    expect(run.reviewOutcome).toBeNull();
  });

  it.runIf(available)('exact pinned reviewer — forced run uses the assigned reviewer, withholds (null) when unresolved; no substitution', async () => {
    // Forced + reviewer assigned → the run executes EXACTLY that reviewer.
    const a = await makeWorkspace();
    injectProviders('approve');
    const t1 = await makeTask({ ctx: a.ctx, primaryId: a.primaryId, reviewerId: a.reviewerId, reviewEnabled: false, quickExempt: false });
    await startRun(a.ctx, t1);
    const r1 = await runRow(t1);
    expect(r1.reviewerAgentId).toBe(a.reviewerId);
    expect(r1.primaryAgentId).toBe(a.primaryId);
    // Forced + no reviewer → reviewer WITHHELD (null), recorded required_unmet — not substituted with another agent.
    const b = await makeWorkspace();
    injectProviders('none');
    const t2 = await makeTask({ ctx: b.ctx, primaryId: b.primaryId, reviewerId: null, reviewEnabled: false, quickExempt: false });
    await startRun(b.ctx, t2);
    const r2 = await runRow(t2);
    expect(r2.reviewerAgentId).toBeNull();
    expect(r2.reviewOutcome).toBe('required_unmet');
  });

  it.runIf(available)('cross-workspace reviewer assignment is rejected at the data boundary', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    // Assigning project A's task a reviewer that lives in project B must fail (composite same-workspace FK).
    await expect(
      makeTask({ ctx: a.ctx, primaryId: a.primaryId, reviewerId: b.reviewerId, reviewEnabled: true, quickExempt: null }),
    ).rejects.toThrow();
  });

  it.runIf(available)('negative verdict stays VISIBLE — reviewed ≠ approved (reject caution in the result)', async () => {
    const ws = await makeWorkspace();
    injectProviders('reject');
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: ws.reviewerId, reviewEnabled: true, quickExempt: null });
    await startRun(ws.ctx, taskId);
    const run = await runRow(taskId);
    expect(run.reviewOutcome).toBe('reviewed');
    expect((await reviewStep(run.id))?.verdict).toBe('reject');
    // The consolidated answer surfaces the rejection + caution (reviewed is not the same as approved).
    expect(run.consolidatedResult).toContain('reject');
    expect(run.consolidatedResult!.toLowerCase()).toContain('caution');
  });

  it.runIf(available)('QUEUE/WORKER path enforces identically — a Quick request forced to Reviewed via the dispatcher', async () => {
    const ws = await makeWorkspace();
    injectProviders('approve');
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: ws.reviewerId, reviewEnabled: false, quickExempt: false });
    await withTenant(ws.ctx, (tx) => enqueueRun(tx, ws.ctx, taskId));
    const job = await claimJobForTask(ws.ctx, taskId);
    expect(job).not.toBeNull();
    await runClaimedJob(job!); // real worker entry: runClaimedJob → startRun (with a job lease)
    const run = await runRow(taskId);
    expect(run.requestedMode).toBe('quick');
    expect(run.effectiveMode).toBe('reviewed');
    expect(run.reviewForced).toBe(true);
    expect(run.reviewOutcome).toBe('reviewed');
  });

  it.runIf(available)('RESUME path carries the review decision — an interrupted required run resumes to the SAME outcome', async () => {
    const ws = await makeWorkspace();
    // Crash the fresh run AFTER the finalizing marker is written but BEFORE terminal apply, leaving the run
    // mid-finalize; then resumeRun re-enters executeAndFinalize and finalizes idempotently.
    injectProviders('approve');
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: ws.reviewerId, reviewEnabled: true, quickExempt: null });
    const { __setRunTestHookForTests } = await import('@/domain/tasks/runner');
    __setRunTestHookForTests(async (label) => {
      if (label === 'after-finalizing-marker') throw new Error('injected crash (mid-finalize)');
    });
    await expect(startRun(ws.ctx, taskId)).rejects.toThrow(/injected crash/);
    __setRunTestHookForTests(null);
    injectProviders('approve'); // re-arm providers for the resumed attempt (checkpoints replay; no re-bill)
    const outcome = await resumeRun(ws.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = await runRow(taskId);
    expect(run.reviewRequired).toBe(true);
    expect(run.reviewOutcome).toBe('reviewed');
  });

  // Correction 1 — a CONCLUSIVE failed review, interrupted immediately after it persists, must REPLAY on resume
  // (no hidden same-step re-dispatch). One provider pair spans the crash+resume so the reviewer call count is
  // authoritative. First attempt + recovery both run through the worker (runClaimedJob → startRun/resumeRun).
  async function failedReviewCrashResume(required: boolean) {
    const ws = await makeWorkspace();
    const openai = new FakeProvider('openai');
    openai.reply(PRIMARY_TEXT);
    const anthropic = new FakeProvider('anthropic');
    anthropic.fail('auth'); // ONE conclusive not-executed failure; any SECOND call would default to a success
    setProviderOverrideForTests((id) => (id === 'openai' ? openai : id === 'anthropic' ? anthropic : undefined));

    const taskId = await makeTask({
      ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: ws.reviewerId,
      reviewEnabled: true, quickExempt: required ? null : true, // required: policy required; optional: exempt
    });

    // First attempt through the worker, crashed right after the failed review step persists (after-checkpoint #2).
    const { __setRunTestHookForTests } = await import('@/domain/tasks/runner');
    __setRunTestHookForTests(async (label, step) => {
      if (label === 'after-checkpoint' && step === 2) throw new Error('injected crash after failed-review persist');
    });
    await withTenant(ws.ctx, (tx) => enqueueRun(tx, ws.ctx, taskId));
    const job1 = await claimJobForTask(ws.ctx, taskId);
    await runClaimedJob(job1!); // crashes internally; the worker fails the job and leaves the run 'running'
    __setRunTestHookForTests(null);

    // Recovery through the worker: the task is 'running' → runClaimedJob → resumeRun → replay.
    await withTenant(ws.ctx, (tx) => enqueueRun(tx, ws.ctx, taskId));
    const job2 = await claimJobForTask(ws.ctx, taskId);
    const outcome = await runClaimedJob(job2!);

    const run = await runRow(taskId);
    const steps = await db.select().from(runSteps).where(eq(runSteps.runId, run.id));
    const reviewSteps = steps.filter((s) => s.kind === 'review');
    const ckpts = await db.select().from(runExecutionCheckpoints).where(eq(runExecutionCheckpoints.runId, run.id));
    const usage = await db.select().from(usageEvents).where(eq(usageEvents.runId, run.id));

    // The reviewer was called EXACTLY ONCE across crash + resume — no hidden same-step re-dispatch.
    expect(anthropic.requests).toHaveLength(1);
    // Exactly one review step row, recorded as the conclusive failure.
    expect(reviewSteps).toHaveLength(1);
    expect(reviewSteps[0]!.succeeded).toBe(false);
    // No checkpoint and no usage for the failed review step (step 2) — and no duplicate from a second attempt.
    expect(ckpts.filter((c) => c.stepNumber === 2)).toHaveLength(0);
    expect(usage.filter((u) => u.runStepId === reviewSteps[0]!.id)).toHaveLength(0);
    // Run finalized conclusively with the correct outcome and reliability state.
    expect(run.reliabilityState).toBe('completed');
    expect(outcome?.status).toBe('completed');
    return run;
  }

  it.runIf(available)('failed REQUIRED review, crash after persist, resume → replay (no re-dispatch) → required_unmet', async () => {
    const run = await failedReviewCrashResume(true);
    expect(run.reviewRequired).toBe(true);
    expect(run.reviewOutcome).toBe('required_unmet');
    expect(run.consolidatedResult).toContain('UNREVIEWED DRAFT');
  });

  it.runIf(available)('failed OPTIONAL review, crash after persist, resume → replay (no re-dispatch) → optional_degraded', async () => {
    const run = await failedReviewCrashResume(false);
    expect(run.reviewRequired).toBe(false);
    expect(run.reviewOutcome).toBe('optional_degraded');
    expect(run.consolidatedResult).not.toContain('UNREVIEWED DRAFT');
  });

  it.runIf(available)('insufficient budget — run refuses to start (no bypass)', async () => {
    const ws = await makeWorkspace(0n);
    injectProviders('approve');
    const taskId = await makeTask({ ctx: ws.ctx, primaryId: ws.primaryId, reviewerId: ws.reviewerId, reviewEnabled: true, quickExempt: null });
    await expect(startRun(ws.ctx, taskId)).rejects.toBeInstanceOf(BudgetExceededError);
    const run = (await db.select().from(runs).where(eq(runs.taskId, taskId)).limit(1))[0];
    expect(run).toBeUndefined(); // refused in preflight — no run row
  });
});
