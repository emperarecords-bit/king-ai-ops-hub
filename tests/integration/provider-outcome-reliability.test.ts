import { randomUUID } from 'node:crypto';
import { and, eq, gte, isNull, isNotNull, lt } from 'drizzle-orm';
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
  runs,
  spendLimits,
  tasks,
  usageEvents,
} from '@/db/schema';
import { setProviderOverrideForTests } from '@/providers/registry';
import { __setRunTestHookForTests, resumeRun, startRun } from '@/domain/tasks/runner';
import { anchorReviewClaims } from '@/orchestration/prompts';

/**
 * Hub P1d correction — AMBIGUOUS provider-outcome handling across the whole run pipeline.
 *
 * A provider fault whose remote outcome cannot be proven un-executed (timeout/transport after transmission,
 * a generic 5xx, a partial stream) must NEVER be silently retried or reported as a clean zero-charge failure:
 * the durable dispatch intent stays intact and the run fails CLOSED to `reconciliation_required` with the
 * provider call count frozen at exactly one, no usage/token/cost fabricated, and no automatic recovery retry.
 * A KNOWN pre-processing rejection (provably not executed) still follows the fail-safe/known path.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');
process.env.RATE_LIMIT_RUNS_PER_MINUTE = '100000';

assertDisposableDbForVerification('provider-outcome-reliability.test');

let available = false;
try {
  const db = getSetupDb();
  await db.select({ one: profiles.id }).from(profiles).limit(1);
  await db.execute(`select 1 from run_execution_checkpoints limit 1`);
  available = true;
} catch (err) {
  console.warn(`[provider-outcome-reliability.test] SKIPPING — P1d schema not present: ${err instanceof Error ? err.message : err}`);
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
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('pout'), name: 'POut' }).returning({ id: projects.id }))[0]!.id;
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
      title: 'Outcome task',
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

const EMPTY_JSON = '{"candidates":[]}';

const decisionCalls = (p: FakeProvider) => p.requests.filter((r) => r.system.includes('DECISION CANDIDATES')).length;
const knowledgeCalls = (p: FakeProvider) => p.requests.filter((r) => r.system.includes('KNOWLEDGE CANDIDATES')).length;
const engineCalls = (p: FakeProvider) => p.requests.filter((r) => !r.system.includes('CANDIDATES')).length;

const EXTRACTION_STEP_MIN = 100;
const runFor = async (taskId: string) => (await db.select().from(runs).where(eq(runs.taskId, taskId)))[0]!;
const taskRow = async (taskId: string) => (await db.select().from(tasks).where(eq(tasks.id, taskId)))[0]!;
const engineCheckpoints = async (runId: string) =>
  db.select().from(runExecutionCheckpoints).where(and(eq(runExecutionCheckpoints.runId, runId), lt(runExecutionCheckpoints.stepNumber, EXTRACTION_STEP_MIN))).orderBy(runExecutionCheckpoints.stepNumber);
const extractionCheckpoints = async (runId: string) =>
  db.select().from(runExecutionCheckpoints).where(and(eq(runExecutionCheckpoints.runId, runId), gte(runExecutionCheckpoints.stepNumber, EXTRACTION_STEP_MIN))).orderBy(runExecutionCheckpoints.stepNumber);
const allUsage = async (runId: string) => db.select().from(usageEvents).where(eq(usageEvents.runId, runId));
const stepUsage = async (runId: string) => db.select().from(usageEvents).where(and(eq(usageEvents.runId, runId), isNotNull(usageEvents.runStepId)));
const extractionUsage = async (runId: string) => db.select().from(usageEvents).where(and(eq(usageEvents.runId, runId), isNull(usageEvents.runStepId)));
const decisionProposals = async (runId: string) => db.select().from(decisions).where(eq(decisions.suggestedByRunId, runId));
async function reconAudit(runId: string) {
  return (await db.select({ action: auditLogs.action, detail: auditLogs.detail }).from(auditLogs).where(and(eq(auditLogs.entityId, runId), eq(auditLogs.orgId, orgId)))).filter(
    (r) => r.action === 'run.uncertain_outcome_detected',
  );
}

function openai(...behaviors: Array<{ reply: string } | { fail: 'timeout' | 'overloaded' | 'invalid_request' | 'auth' | 'rate_limited' }>): FakeProvider {
  const p = new FakeProvider('openai');
  for (const b of behaviors) {
    if ('reply' in b) p.reply(b.reply);
    else p.fail(b.fail);
  }
  p.defaultReply = EMPTY_JSON;
  return p;
}
function anthropicP(...behaviors: Array<{ reply: string } | { fail: 'timeout' | 'overloaded' | 'invalid_request' }>): FakeProvider {
  const p = new FakeProvider('anthropic');
  for (const b of behaviors) {
    if ('reply' in b) p.reply(b.reply);
    else p.fail(b.fail);
  }
  p.defaultReply = EMPTY_JSON;
  return p;
}
function override(o: FakeProvider, a?: FakeProvider) {
  setProviderOverrideForTests((id) => (id === 'openai' ? o : id === 'anthropic' ? a : undefined));
}

const REVISE = `\`\`\`review-result\n${JSON.stringify({ verdict: 'revise', findings: [{ claimAnchor: anchorReviewClaims('Primary answer.')[0]!.anchor, severity: 'major', rationale: 'Fix it.', requestedRevision: 'Fix the answer.' }] })}\n\`\`\``;

beforeAll(async () => {
  if (!available) return;
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `pout-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `pout-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
});
afterAll(async () => {
  if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});
afterEach(() => {
  __setRunTestHookForTests(null);
  setProviderOverrideForTests(null);
});

describe.skipIf(!available)('Hub P1d — ambiguous provider outcomes fail closed to reconciliation', () => {
  it('PRIMARY ambiguous timeout → reconciliation_required, one call, no usage, no auto-retry on recovery', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const o = openai({ fail: 'timeout' }, { reply: 'never' });
    override(o);

    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const run = await runFor(taskId);
    expect(run.reliabilityState).toBe('reconciliation_required');
    expect(run.status).toBe('failed');
    expect((await taskRow(taskId)).status).toBe('failed');
    expect(engineCalls(o)).toBe(1); // the request crossed the boundary exactly once
    expect((await engineCheckpoints(run.id)).length).toBe(0);
    expect((await allUsage(run.id)).length).toBe(0); // no fabricated token/cost
    const ra = await reconAudit(run.id);
    expect(ra.length).toBe(1);
    expect(JSON.stringify(ra[0]!.detail)).toContain('"externalChargeKnown":false'); // charge explicitly unknown

    // Recovery issues NO second request (the run is terminal reconciliation).
    const again = await resumeRun(w.ctx, taskId);
    expect(again.status).not.toBe('completed');
    expect(engineCalls(o)).toBe(1);
  });

  it('REVIEWER ambiguous timeout → reconciliation_required (does not degrade), primary preserved, one reviewer call', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w, { review: true });
    const o = openai({ reply: 'Primary answer.' });
    const a = anthropicP({ fail: 'timeout' });
    override(o, a);

    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const run = await runFor(taskId);
    expect(run.reliabilityState).toBe('reconciliation_required');
    expect(a.requests.length).toBe(1); // reviewer called once, not retried
    expect(engineCalls(o)).toBe(1); // primary only; NO extraction (reconciliation short-circuits completion)
    expect((await engineCheckpoints(run.id)).map((c) => c.stepNumber)).toEqual([1]); // primary intact
    expect((await stepUsage(run.id)).length).toBe(1); // primary billed once; reviewer never billed
    expect((await extractionCheckpoints(run.id)).length).toBe(0);
  });

  it('REVISION ambiguous timeout → reconciliation_required, primary+review preserved, one revision call', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w, { review: true });
    const o = openai({ reply: 'Primary answer.' }, { fail: 'timeout' }, { reply: 'never' });
    const a = anthropicP({ reply: REVISE });
    override(o, a);

    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const run = await runFor(taskId);
    expect(engineCalls(o)).toBe(2); // primary + the revision attempt (one call), no retry
    expect(a.requests.length).toBe(1);
    expect((await engineCheckpoints(run.id)).map((c) => c.stepNumber)).toEqual([1, 2]); // primary + review intact
    expect((await stepUsage(run.id)).length).toBe(2); // revision never billed
  });

  it('DECISION-extraction ambiguous timeout → reconciliation_required, intent preserved, one call, no usage/proposal', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const o = openai({ reply: 'Primary answer.' }, { fail: 'timeout' }, { reply: 'never' });
    override(o);

    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const run = await runFor(taskId);
    expect(run.reliabilityState).toBe('reconciliation_required'); // dispatch intent preserved → reconciliation
    expect(decisionCalls(o)).toBe(1); // extraction request crossed the boundary once
    expect((await extractionCheckpoints(run.id)).length).toBe(0); // no checkpoint for the uncertain call
    expect((await extractionUsage(run.id)).length).toBe(0); // no fabricated extraction cost
    expect(await decisionProposals(run.id)).toHaveLength(0);

    const again = await resumeRun(w.ctx, taskId);
    expect(again.status).not.toBe('completed');
    expect(decisionCalls(o)).toBe(1); // no second extraction call on recovery
  });

  it('KNOWLEDGE-extraction ambiguous timeout → reconciliation_required, one call, no knowledge checkpoint', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const o = openai({ reply: 'Primary answer.' }, { reply: EMPTY_JSON }, { fail: 'timeout' }, { reply: 'never' });
    override(o);

    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const run = await runFor(taskId);
    expect(knowledgeCalls(o)).toBe(1);
    // Decision extraction completed + checkpointed (101); knowledge was uncertain (no 102).
    expect((await extractionCheckpoints(run.id)).map((c) => c.stepNumber)).toEqual([EXTRACTION_STEP_MIN + 1]);

    const again = await resumeRun(w.ctx, taskId);
    expect(again.status).not.toBe('completed');
    expect(knowledgeCalls(o)).toBe(1);
  });

  it('KNOWN extraction rejection (invalid_request, provably not executed) is FAIL-SAFE — the run still completes', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    // Primary ok; decision extraction is cleanly REJECTED before processing (400) → known failure, fail-safe.
    const o = openai({ reply: 'Primary answer.' }, { fail: 'invalid_request' }, { reply: EMPTY_JSON });
    override(o);

    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('completed'); // known failure does NOT block the run
    const run = await runFor(taskId);
    expect(run.reliabilityState).toBe('completed');
    expect(run.candidateExtractionStatus).toBe('failed'); // recorded as failed, not a fabricated success
    expect(await decisionProposals(run.id)).toHaveLength(0);
    expect((await reconAudit(run.id)).length).toBe(0); // NOT a reconciliation case
  });

  it('REVIEWER Anthropic 529/overloaded is AMBIGUOUS → reconciliation_required (no longer treated as not-executed)', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w, { review: true });
    const o = openai({ reply: 'Primary answer.' });
    const a = anthropicP({ fail: 'overloaded' }); // models an Anthropic HTTP 529 overloaded response
    override(o, a);

    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required'); // 529 fails closed, not a graceful degrade
    const run = await runFor(taskId);
    expect(run.reliabilityState).toBe('reconciliation_required');
    expect(a.requests.length).toBe(1); // the 529 crossed the boundary once and was NEVER retried
    expect((await engineCheckpoints(run.id)).map((c) => c.stepNumber)).toEqual([1]); // primary intact
    expect((await stepUsage(run.id)).length).toBe(1); // reviewer never billed — no fabricated cost
    const ra = await reconAudit(run.id);
    expect(JSON.stringify(ra[0]!.detail)).toContain('"externalChargeKnown":false');

    const again = await resumeRun(w.ctx, taskId);
    expect(again.status).not.toBe('completed');
    expect(a.requests.length).toBe(1); // no reissue on recovery
  });

  it('EXTRACTION overloaded (generic 5xx / 529-class) is AMBIGUOUS → reconciliation_required, one call, no usage/proposal', async () => {
    const w = await makeWorkspace();
    const taskId = await mkTask(w);
    const o = openai({ reply: 'Primary answer.' }, { fail: 'overloaded' }, { reply: 'never' });
    override(o);

    const outcome = await startRun(w.ctx, taskId);
    expect(outcome.status).toBe('reconciliation_required');
    const run = await runFor(taskId);
    expect(run.reliabilityState).toBe('reconciliation_required'); // dispatch intent preserved
    expect(decisionCalls(o)).toBe(1);
    expect((await extractionCheckpoints(run.id)).length).toBe(0);
    expect((await extractionUsage(run.id)).length).toBe(0);
    expect(await decisionProposals(run.id)).toHaveLength(0);

    const again = await resumeRun(w.ctx, taskId);
    expect(again.status).not.toBe('completed');
    expect(decisionCalls(o)).toBe(1); // no second extraction call on recovery
  });
});
