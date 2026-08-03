import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { assertDisposableDbForVerification } from '@tests/support/require-disposable-db';
import { type DbTx } from '@/db/client';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { agents, auditLogs, decisions, knowledgeProposals, memberships, organizations, profiles, projectMembers, projects, runJobs, runs, spendLimits, tasks } from '@/db/schema';
import { renewRunJobLeaseTx } from '@/domain/jobs/jobs';
import { LeaseLostSignal } from '@/orchestration/engine';
import { applyDecisionCandidatesFromText } from '@/domain/decisions/extraction';
import { applyKnowledgeCandidatesFromText } from '@/domain/knowledge/extraction';

/**
 * Hub P1d correction — TRANSACTION-LEVEL proposal fencing.
 *
 * The proposal-application transaction is fenced INSIDE itself: it acquires the run_jobs row lock and confirms
 * the current fencing token still owns the job (via `renewRunJobLeaseTx`) BEFORE any read/insert/audit. So a
 * stale/reclaimed token writes nothing, two concurrent applications produce exactly one proposal set, a
 * mid-transaction failure rolls back fully (retry then succeeds exactly once), and repeated application is
 * idempotently recognized. Decision and knowledge have independent application identities.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');

assertDisposableDbForVerification('extraction-fencing.test');

let available = false;
try {
  const db0 = getSetupDb();
  await db0.select({ one: profiles.id }).from(profiles).limit(1);
  await db0.execute(`select 1 from run_execution_checkpoints limit 1`);
  available = true;
} catch (err) {
  console.warn(`[extraction-fencing.test] SKIPPING — P1d schema not present: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let userId = '';
let ctx: TenantContext;
let primaryId = '';

const DECISION_JSON =
  '{"candidates":[{"title":"A settled thing","summary":"Recorded.","decisionType":"operational","supportingRefs":[],"confidence":"high","evidence":"stated"}]}';
const KNOWLEDGE_JSON =
  '{"candidates":[{"title":"K","claim":"a durable fact","transformation":"extracted","supportingRefs":[{"path":"doc.md","quote":null}],"suggestedScope":"task","confidence":"high","reason":"r"}]}';

/** Create a fresh run + a `running` run_jobs row owned by fencing token `attempts`. */
async function makeRunAndJob(attempts: number): Promise<{ runId: string; jobId: string }> {
  const taskId = (
    await db
      .insert(tasks)
      .values({ orgId, projectId: ctx.projectId, title: 'Fence task', input: 'Do it.', providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: userId, assignedPrimaryAgentId: primaryId })
      .returning({ id: tasks.id })
  )[0]!.id;
  const runId = (
    await db
      .insert(runs)
      .values({ orgId, projectId: ctx.projectId, taskId, primaryAgentId: primaryId, status: 'completed', classification: 'demo', reliabilityState: 'result_checkpointed' })
      .returning({ id: runs.id })
  )[0]!.id;
  const jobId = (
    await db
      .insert(runJobs)
      .values({ orgId, projectId: ctx.projectId, taskId, status: 'running', attempts, leasedUntil: new Date(Date.now() + 60_000) })
      .returning({ id: runJobs.id })
  )[0]!.id;
  return { runId, jobId };
}

/** A fence that throws (like the runner's) when `token` no longer owns `jobId`. */
function fence(jobId: string, token: number) {
  return async (tx: DbTx) => {
    if (!(await renewRunJobLeaseTx(tx, jobId, token))) throw new LeaseLostSignal('lease_lost');
  };
}

const decisionProposals = async (runId: string) => db.select().from(decisions).where(eq(decisions.suggestedByRunId, runId));
const knowledgeProps = async (runId: string) => db.select().from(knowledgeProposals).where(eq(knowledgeProposals.suggestedByRunId, runId));
const runById = async (runId: string) => (await db.select().from(runs).where(eq(runs.id, runId)))[0]!;
const extractionAudits = async (runId: string) =>
  (await db.select({ a: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.entityId, runId), eq(auditLogs.orgId, orgId)))).map((r) => r.a).filter((a) => a.includes('extracted'));

beforeAll(async () => {
  if (!available) return;
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `fence-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `fence-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('fence'), name: 'Fence' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  primaryId = (await db.insert(agents).values({ orgId, projectId: pid, name: `P-${randomUUID().slice(0, 6)}`, role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'p' }).returning({ id: agents.id }))[0]!.id;
  ctx = { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' };
});
afterAll(async () => {
  if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('Hub P1d — transaction-level proposal fencing', () => {
  it('a STALE token creates ZERO decision proposals and ZERO extraction audit (fails before any write)', async () => {
    const { runId, jobId } = await makeRunAndJob(5);
    await expect(
      db.transaction((tx) => applyDecisionCandidatesFromText(tx, ctx, runId, DECISION_JSON, { fenceTx: fence(jobId, 4) })),
    ).rejects.toBeInstanceOf(LeaseLostSignal);
    expect(await decisionProposals(runId)).toHaveLength(0);
    expect(await extractionAudits(runId)).toHaveLength(0);
    expect((await runById(runId)).candidateExtractionStatus).toBeNull(); // not claimed → retryable by the winner
  });

  it('a STALE token creates ZERO knowledge proposals (fails before beginAiOperation / any write)', async () => {
    const { runId, jobId } = await makeRunAndJob(5);
    await expect(
      db.transaction((tx) => applyKnowledgeCandidatesFromText(tx, ctx, runId, KNOWLEDGE_JSON, { provider: 'openai', model: 'gpt-x' }, { fenceTx: fence(jobId, 4) })),
    ).rejects.toBeInstanceOf(LeaseLostSignal);
    expect(await knowledgeProps(runId)).toHaveLength(0);
    expect((await runById(runId)).knowledgeExtractionStatus).toBeNull();
  });

  it('the CURRENT token applies once; a repeated application is idempotently recognized (no duplicate)', async () => {
    const { runId, jobId } = await makeRunAndJob(7);
    const first = await db.transaction((tx) => applyDecisionCandidatesFromText(tx, ctx, runId, DECISION_JSON, { fenceTx: fence(jobId, 7) }));
    expect(first).toBe(1);
    expect(await decisionProposals(runId)).toHaveLength(1);
    expect((await runById(runId)).candidateExtractionStatus).toBe('succeeded');
    // Repeat with the SAME valid token → recognized as complete, creates nothing.
    const second = await db.transaction((tx) => applyDecisionCandidatesFromText(tx, ctx, runId, DECISION_JSON, { fenceTx: fence(jobId, 7) }));
    expect(second).toBe(0);
    expect(await decisionProposals(runId)).toHaveLength(1);
  });

  it('TWO CONCURRENT applications with the same valid token create exactly ONE proposal set', async () => {
    const { runId, jobId } = await makeRunAndJob(3);
    // Two real concurrent transactions (separate pool connections). The run_jobs row lock serializes them; the
    // loser observes the completed status under the lock and writes nothing.
    const results = await Promise.all([
      db.transaction((tx) => applyDecisionCandidatesFromText(tx, ctx, runId, DECISION_JSON, { fenceTx: fence(jobId, 3) })),
      db.transaction((tx) => applyDecisionCandidatesFromText(tx, ctx, runId, DECISION_JSON, { fenceTx: fence(jobId, 3) })),
    ]);
    expect(results.slice().sort()).toEqual([0, 1]); // exactly one application did the work
    expect(await decisionProposals(runId)).toHaveLength(1); // one proposal set, never two
  });

  it('a transaction failure AFTER claiming but before commit rolls back fully; retry then succeeds exactly once', async () => {
    const { runId, jobId } = await makeRunAndJob(9);
    await expect(
      db.transaction(async (tx) => {
        await applyDecisionCandidatesFromText(tx, ctx, runId, DECISION_JSON, { fenceTx: fence(jobId, 9) });
        throw new Error('boom — mid-transaction failure after claiming');
      }),
    ).rejects.toThrow(/boom/);
    // Full rollback: no proposal, status restored to null (unclaimed) → retry is possible.
    expect(await decisionProposals(runId)).toHaveLength(0);
    expect((await runById(runId)).candidateExtractionStatus).toBeNull();
    // Retry succeeds exactly once.
    const n = await db.transaction((tx) => applyDecisionCandidatesFromText(tx, ctx, runId, DECISION_JSON, { fenceTx: fence(jobId, 9) }));
    expect(n).toBe(1);
    expect(await decisionProposals(runId)).toHaveLength(1);
  });

  it('decision and knowledge have INDEPENDENT application identities (applying one leaves the other unclaimed)', async () => {
    const { runId, jobId } = await makeRunAndJob(11);
    await db.transaction((tx) => applyDecisionCandidatesFromText(tx, ctx, runId, DECISION_JSON, { fenceTx: fence(jobId, 11) }));
    const run = await runById(runId);
    expect(run.candidateExtractionStatus).toBe('succeeded'); // decision claimed
    expect(run.knowledgeExtractionStatus).toBeNull(); // knowledge still independently unclaimed
  });
});
