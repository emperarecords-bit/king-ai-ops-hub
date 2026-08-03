import { randomUUID } from 'node:crypto';
import { and, eq, gte, isNull } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { assertDisposableDbForVerification } from '@tests/support/require-disposable-db';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import {
  agents,
  auditLogs,
  decisions,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  runExecutionCheckpoints,
  runJobs,
  runs,
  spendLimits,
  tasks,
  usageEvents,
} from '@/db/schema';
import { setProviderOverrideForTests } from '@/providers/registry';
import { __setRunTestHookForTests, resumeRun, startRun } from '@/domain/tasks/runner';
import { runClaimedJob } from '@/domain/jobs/jobs';
import { LeaseLostSignal } from '@/orchestration/engine';

/**
 * Hub P1d correction — post-run decision/knowledge extraction brought INSIDE the reliability boundary.
 *
 * Extraction is now modeled as reserved deterministic reliability steps (decision=101, knowledge=102): the
 * provider call is lease-fenced + checkpointed BEFORE the run is marked terminal, and proposal creation is
 * idempotent + fail-safe. These tests drive the real dispatch path against real Postgres and prove: a stale
 * worker issues zero extraction calls / usage; an uncertain extraction dispatch → reconciliation with no auto
 * retry and no fabricated cost; a checkpointed extraction resumes proposal creation with no second call;
 * repeated finalize/drain never duplicates usage or proposals; checkpoints are immutable (fail closed); and
 * primary/reviewer counters + proposal shape are unchanged.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');
process.env.RATE_LIMIT_RUNS_PER_MINUTE = '100000';

assertDisposableDbForVerification('extraction-reliability.test');

let available = false;
try {
  const db = getSetupDb();
  await db.select({ one: profiles.id }).from(profiles).limit(1);
  await db.execute(`select 1 from run_execution_checkpoints limit 1`);
  available = true;
} catch (err) {
  console.warn(`[extraction-reliability.test] SKIPPING — P1d schema not present: ${err instanceof Error ? err.message : err}`);
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
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('extrel'), name: 'ExtRel' }).returning({ id: projects.id }))[0]!.id;
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
      title: 'Extraction rel task',
      input: 'SECRET-BRIEF: do the confidential work.',
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

// One valid decision candidate (no supportingRefs → grounded for a no-document task) so a decision proposal
// is actually created; knowledge stays empty (no citable sources in this workspace).
const DECISION_JSON =
  '{"candidates":[{"title":"Runtime fixed at 22:00","summary":"The nightly runtime was fixed at 22:00.","decisionType":"operational","supportingRefs":[],"confidence":"high","evidence":"Explicitly concluded in the result."}]}';
const EMPTY_JSON = '{"candidates":[]}';

/** openai provider scripted as primary → decision-extraction → knowledge-extraction. */
function openaiRun(primaryReply = 'Primary answer.', decisionJson = DECISION_JSON, knowledgeJson = EMPTY_JSON): FakeProvider {
  const p = new FakeProvider('openai').reply(primaryReply).reply(decisionJson).reply(knowledgeJson);
  p.defaultReply = EMPTY_JSON; // any further extraction call falls through to a valid empty envelope
  setProviderOverrideForTests((id) => (id === 'openai' ? p : undefined));
  return p;
}
function crossRun(reviewText: string, primaryReply = 'Primary answer.') {
  const openai = new FakeProvider('openai').reply(primaryReply).reply(DECISION_JSON).reply(EMPTY_JSON);
  openai.defaultReply = EMPTY_JSON;
  const anthropic = new FakeProvider('anthropic').reply(reviewText);
  anthropic.defaultReply = EMPTY_JSON;
  setProviderOverrideForTests((id) => (id === 'openai' ? openai : id === 'anthropic' ? anthropic : undefined));
  return { openai, anthropic };
}

// Classify a fake provider's recorded requests by the fixed extraction system prompts.
const decisionCalls = (p: FakeProvider) => p.requests.filter((r) => r.system.includes('DECISION CANDIDATES')).length;
const knowledgeCalls = (p: FakeProvider) => p.requests.filter((r) => r.system.includes('KNOWLEDGE CANDIDATES')).length;
const engineCalls = (p: FakeProvider) => p.requests.filter((r) => !r.system.includes('CANDIDATES')).length;

const EXTRACTION_STEP_MIN = 100;
const runFor = async (taskId: string) => (await db.select().from(runs).where(eq(runs.taskId, taskId)))[0]!;
const taskRow = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const extractionCheckpoints = async (runId: string) =>
  db
    .select()
    .from(runExecutionCheckpoints)
    .where(and(eq(runExecutionCheckpoints.runId, runId), gte(runExecutionCheckpoints.stepNumber, EXTRACTION_STEP_MIN)))
    .orderBy(runExecutionCheckpoints.stepNumber);
// Extraction usage carries no run_step_id (it is not an engine step); this isolates extraction billing.
const extractionUsage = async (runId: string) =>
  db.select().from(usageEvents).where(and(eq(usageEvents.runId, runId), isNull(usageEvents.runStepId)));
const decisionProposals = async (runId: string) =>
  db.select().from(decisions).where(eq(decisions.suggestedByRunId, runId));
async function auditRows(runId: string) {
  return db.select({ action: auditLogs.action, detail: auditLogs.detail }).from(auditLogs).where(and(eq(auditLogs.entityId, runId), eq(auditLogs.orgId, orgId)));
}

beforeAll(async () => {
  if (!available) return;
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `extrel-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `extrel-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
});
afterAll(async () => {
  if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});
afterEach(() => {
  __setRunTestHookForTests(null);
  setProviderOverrideForTests(null);
});

describe.skipIf(!available)('Hub P1d — extraction inside the reliability boundary', () => {
  it('baseline: a completed run checkpoints BOTH extraction steps and creates the decision proposal, before terminal', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const p = openaiRun();

    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = await runFor(taskId);
    expect(run.reliabilityState).toBe('completed');
    // Extraction ran as reserved reliability steps 101 (decision) + 102 (knowledge), each checkpointed + billed.
    expect((await extractionCheckpoints(run.id)).map((c) => c.stepNumber)).toEqual([EXTRACTION_STEP_MIN + 1, EXTRACTION_STEP_MIN + 2]);
    expect((await extractionUsage(run.id)).length).toBe(2);
    expect(decisionCalls(p)).toBe(1);
    expect(knowledgeCalls(p)).toBe(1);
    // The decision proposal was created — and with the same shape acceptance relies on (unchanged behavior).
    const props = await decisionProposals(run.id);
    expect(props.length).toBe(1);
    expect(props[0]!.status).toBe('proposed'); // AI can never self-approve
    expect(props[0]!.applicability).toBe('record'); // record-only until a human accepts
    expect(props[0]!.suggestedByRunId).toBe(run.id);
  });

  it('lease loss BEFORE extraction → zero extraction provider calls, zero extraction usage', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const p = openaiRun();
    // ownsLease is true for the primary dispatch, then reclaimed before extraction.
    let owns = 0;
    const jobCtx = { jobId: randomUUID(), attempt: 1, ownsLease: async () => (++owns <= 1) };

    await expect(startRun(w.ctx, taskId, undefined, jobCtx)).rejects.toBeInstanceOf(LeaseLostSignal);
    const run = await runFor(taskId);
    expect(engineCalls(p)).toBe(1); // primary ran under the owned lease
    expect(decisionCalls(p)).toBe(0); // extraction never dispatched by the stale worker
    expect(knowledgeCalls(p)).toBe(0);
    expect((await extractionCheckpoints(run.id)).length).toBe(0);
    expect((await extractionUsage(run.id)).length).toBe(0); // a stale worker wrote NO extraction usage
    expect(await decisionProposals(run.id)).toHaveLength(0);
  });

  it('crash BEFORE the extraction dispatch intent permits safe later execution', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const p = openaiRun();

    __setRunTestHookForTests(async (label, step) => {
      if (label === 'before-extract-intent' && step === EXTRACTION_STEP_MIN + 1) throw new Error('CRASH before extraction intent');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    const crashed = await runFor(taskId);
    expect(crashed.reliabilityState).toBe('result_checkpointed'); // primary done; no extraction intent yet
    expect((await extractionCheckpoints(crashed.id)).length).toBe(0);
    expect(decisionCalls(p)).toBe(0);

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const done = await runFor(taskId);
    expect((await extractionCheckpoints(done.id)).map((c) => c.stepNumber)).toEqual([EXTRACTION_STEP_MIN + 1, EXTRACTION_STEP_MIN + 2]);
    expect(decisionCalls(p)).toBe(1); // extraction executed exactly once, on resume
    expect(await decisionProposals(done.id)).toHaveLength(1);
  });

  it('crash AFTER the extraction provider returns but BEFORE its checkpoint → reconciliation_required, called once, no usage, not auto-retried', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const p = openaiRun();

    __setRunTestHookForTests(async (label, step) => {
      if (label === 'before-extract-checkpoint' && step === EXTRACTION_STEP_MIN + 1) throw new Error('CRASH after extraction provider, before checkpoint');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    expect(decisionCalls(p)).toBe(1); // the extraction request crossed the provider boundary exactly once
    const crashed = await runFor(taskId);
    expect(crashed.reliabilityState).toBe('dispatching'); // intent durable, result unknown
    expect((await extractionCheckpoints(crashed.id)).length).toBe(0);
    expect((await extractionUsage(crashed.id)).length).toBe(0); // no fabricated token/cost

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const done = await runFor(taskId);
    expect(done.reliabilityState).toBe('reconciliation_required');
    expect(decisionCalls(p)).toBe(1); // NEVER auto-repeated after the uncertain dispatch
    expect((await extractionUsage(done.id)).length).toBe(0); // uncertain charge stays UNKNOWN, not recorded as 0
    expect(await decisionProposals(done.id)).toHaveLength(0); // no proposal from an uncertain extraction
    expect((await auditRows(done.id)).map((a) => a.action)).toContain('run.uncertain_outcome_detected');
  });

  it('crash AFTER the extraction checkpoint → resumes proposal creation with NO second provider call', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const p = openaiRun();

    __setRunTestHookForTests(async (label, step) => {
      if (label === 'after-extract-checkpoint' && step === EXTRACTION_STEP_MIN + 1) throw new Error('CRASH after extraction checkpoint');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    const crashed = await runFor(taskId);
    expect((await extractionCheckpoints(crashed.id)).map((c) => c.stepNumber)).toEqual([EXTRACTION_STEP_MIN + 1]); // decision checkpointed
    expect(decisionCalls(p)).toBe(1);
    expect(await decisionProposals(crashed.id)).toHaveLength(0); // proposal not yet applied at the crash

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const done = await runFor(taskId);
    expect(decisionCalls(p)).toBe(1); // decision NOT re-called — its result came from the checkpoint
    expect(knowledgeCalls(p)).toBe(1); // knowledge dispatched once on resume
    expect(await decisionProposals(done.id)).toHaveLength(1); // proposal created from the checkpointed text
    expect((await extractionUsage(done.id)).length).toBe(2); // decision (crash) + knowledge (resume), no dup
  });

  it('repeated finalization creates NO duplicate extraction usage or proposals', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const p = openaiRun();

    // Crash between the finalizing marker and the terminal apply — extraction has already run + applied.
    __setRunTestHookForTests(async (label) => {
      if (label === 'after-finalizing-marker') throw new Error('CRASH mid-finalize');
    });
    await expect(startRun(w.ctx, taskId)).rejects.toThrow(/CRASH/);
    const crashed = await runFor(taskId);
    const usageAtCrash = (await extractionUsage(crashed.id)).length;
    const propsAtCrash = (await decisionProposals(crashed.id)).length;
    const decisionCallsAtCrash = decisionCalls(p);
    expect(propsAtCrash).toBe(1);
    expect(usageAtCrash).toBe(2);

    __setRunTestHookForTests(null);
    const outcome = await resumeRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const done = await runFor(taskId);
    expect((await extractionUsage(done.id)).length).toBe(usageAtCrash); // no duplicate extraction billing
    expect(await decisionProposals(done.id)).toHaveLength(propsAtCrash); // no duplicate proposal
    expect(decisionCalls(p)).toBe(decisionCallsAtCrash); // extraction not re-dispatched (status guard)
    expect((await extractionCheckpoints(done.id)).map((c) => c.stepNumber)).toEqual([EXTRACTION_STEP_MIN + 1, EXTRACTION_STEP_MIN + 2]);
  });

  it('a reclaim draining an already-completed run does NOT recreate proposals or usage', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    openaiRun();
    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = await runFor(taskId);
    const usageBefore = (await extractionUsage(run.id)).length;
    const propsBefore = (await decisionProposals(run.id)).length;

    // A leftover 'running' job for the already-completed task is claimed → it must drain, not re-extract.
    const jr = (
      await db.insert(runJobs).values({ orgId, projectId: w.ctx.projectId, taskId, status: 'running', leasedUntil: new Date(Date.now() + 60_000) }).returning({ id: runJobs.id })
    )[0]!.id;
    const result = await runClaimedJob({ jobId: jr, taskId, orgId, projectId: w.ctx.projectId, createdBy: userId, projectRole: 'admin', attempt: 1 });
    expect(result).toBeNull();
    expect((await db.select().from(runJobs).where(eq(runJobs.id, jr)))[0]!.status).toBe('done');
    expect((await extractionUsage(run.id)).length).toBe(usageBefore);
    expect(await decisionProposals(run.id)).toHaveLength(propsBefore);
  });

  it('an extraction checkpoint is immutable — a conflicting overwrite fails closed', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    openaiRun();
    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = await runFor(taskId);
    const cps = await extractionCheckpoints(run.id);
    expect(cps.length).toBe(2);
    // The append-only trigger blocks any UPDATE — a second (conflicting) result can never rewrite the durable
    // one recorded for a (run, step). This is the structural "conflicting extraction result fails closed".
    await expect(
      db.update(runExecutionCheckpoints).set({ responseText: 'TAMPERED' }).where(eq(runExecutionCheckpoints.id, cps[0]!.id)),
    ).rejects.toThrow();
    // Unchanged after the rejected tamper.
    expect((await extractionCheckpoints(run.id))[0]!.responseText).toBe(cps[0]!.responseText);
  });

  it('primary + reviewer counters are unchanged by extraction (extraction never calls the reviewer provider)', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w, { review: true });
    const { openai, anthropic } = crossRun('VERDICT: approve\n\nGood.');
    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    // Reviewer (anthropic) is called exactly once — extraction uses the PRIMARY provider only.
    expect(anthropic.requests.length).toBe(1);
    expect(knowledgeCalls(anthropic)).toBe(0);
    expect(decisionCalls(anthropic)).toBe(0);
    // openai: primary (engine) once + decision once + knowledge once.
    expect(engineCalls(openai)).toBe(1);
    expect(decisionCalls(openai)).toBe(1);
    expect(knowledgeCalls(openai)).toBe(1);
  });

  it('extraction audit metadata carries NO prompt, provider response, key, or task brief', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    openaiRun('Primary answer with SENSITIVE payload.');
    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed');
    const run = await runFor(taskId);
    const rows = await auditRows(run.id);
    const extractionAudits = rows.filter((r) =>
      ['run.provider_dispatch_started', 'run.provider_result_checkpointed', 'decision.candidates_extracted'].includes(r.action),
    );
    expect(extractionAudits.length).toBeGreaterThan(0);
    const brief = (await taskRow(taskId)).input; // 'SECRET-BRIEF: ...'
    for (const a of extractionAudits) {
      const blob = JSON.stringify(a.detail ?? {});
      expect(blob).not.toContain('SECRET-BRIEF');
      expect(blob).not.toContain(brief);
      expect(blob).not.toContain('SENSITIVE payload'); // no provider response text
      expect(blob).not.toContain('Runtime fixed at 22:00'); // no extractor output text
      expect(blob).not.toContain('test-openai-key'); // no secret
      expect(blob.toLowerCase()).not.toContain('you extract at most'); // no system prompt
    }
  });
});
