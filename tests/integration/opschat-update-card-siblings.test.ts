import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { rlsAvailable } from '@tests/support/db';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { type ProjectAccessRecord } from '@/db/system';
import { agents, approvals, memberships, organizations, ownerQuestions, profiles, projectMembers, projects, runs, spendLimits, tasks } from '@/db/schema';

/**
 * P5c-2b — ONE job dispatched twice. The shape found in Hub prod (read-only check 2026-10-21): two tasks titled
 * "Server Cabinet Cooling — Dual FUSION-TEC Punch List & Vendor Quote Prep" (runs 11:41 and 12:34); the owner's four
 * answers are SPLIT across them (Lead-Lag on the first; installer, fire suppression, fence noise on the second). The
 * update card must carry ALL four, cover BOTH tasks (freshness + supersession), and never be blocked by "which one?"
 * for identical duplicates. Real DB, real tool, real confirm route (session guard stubbed).
 */

const h = vi.hoisted(() => ({ ctx: null as unknown as { userId: string; orgId: string; projectId: string; orgRole: string; projectRole: string } }));
vi.mock('@/domain/auth/guard', () => ({
  requireUser: async () => ({ id: h.ctx.userId, email: 'king@t.local', displayName: 'King' }),
  requireTenant: async () => h.ctx,
}));
vi.mock('@/lib/env.server', () => ({ serverEnv: () => ({ RATE_LIMIT_RUNS_PER_MINUTE: 10_000 }) }));

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

const { POST } = await import('@/app/api/ops-chat/confirm/route');
const { createOpsChatToolset } = await import('@/domain/opschat/tools');
const conv = await import('@/domain/opschat/conversations');
const { loadTaskStates } = await import('@/domain/opschat/task-state');
const { withTenant, withUser } = await import('@/db/tenant');

const available = await rlsAvailable('opschat-update-card-siblings.test');
const db = getSetupDb();
let owner: TenantContext;
let rec: ProjectAccessRecord;
let agentId = '';
const TITLE = 'Server Cabinet Cooling — Dual FUSION-TEC Punch List & Vendor Quote Prep';

const confirm = async (proposalId: string) =>
  (await (await POST(new Request('http://localhost/api/ops-chat/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposalId, intent: 'confirm' }) }))).json()) as {
    state: string;
    error?: string;
    executed?: { taskId: string };
  };

/** Seed the prod shape under a unique title suffix: task A (older run, 1 answer), task B (newer run, 3 answers). */
async function seedJob(tag: string) {
  const title = `${TITLE} ${tag}`;
  const t0 = new Date(Date.now() - 48 * 60 * 60_000);
  const mk = async (offsetMin: number, input: string) => {
    const id = (
      await db
        .insert(tasks)
        .values({ orgId: owner.orgId, projectId: owner.projectId, title, input, providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: owner.userId, assignedPrimaryAgentId: agentId, createdAt: new Date(t0.getTime() + offsetMin * 60_000) })
        .returning({ id: tasks.id })
    )[0]!.id;
    const start = new Date(t0.getTime() + offsetMin * 60_000);
    const run = (
      await db
        .insert(runs)
        .values({ classification: 'live', orgId: owner.orgId, projectId: owner.projectId, taskId: id, status: 'completed', primaryAgentId: agentId, consolidatedResult: 'draft', reviewOutcome: 'required_unmet', startedAt: start, finishedAt: new Date(start.getTime() + 9_000) })
        .returning({ id: runs.id })
    )[0]!.id;
    return { id, run };
  };
  const A = await mk(0, 'Punch list + vendor quote prep for dual FUSION-TEC.');
  const B = await mk(53, 'Punch list + vendor quote prep for dual FUSION-TEC (rerun).');
  const answered = (taskId: string, runId: string, q: string, a: string, hoursLater: number) => ({
    orgId: owner.orgId, projectId: owner.projectId, taskId, runId, agentId, question: q, status: 'answered', answer: a, answeredBy: owner.userId, answeredAt: new Date(t0.getTime() + hoursLater * 60 * 60_000),
  });
  await db.insert(ownerQuestions).values([
    answered(A.id, A.run, 'Should the control sequencing be Lead-Lag or Primary-Standby?', 'LEAD-LAG (alternating)', 25),
    answered(B.id, B.run, 'Preferred HVAC vendor/installer?', 'EMPERA AIR CONDITIONING AND HEATING', 25),
    answered(B.id, B.run, 'Fire suppression or alarm interface requirement?', 'NO FIRE SUPPRESSION INTERFACE NEEDED', 41),
    answered(B.id, B.run, 'Noise ordinance on the neighbor fence side?', 'VISUAL SCREENING ON THE FENCE SIDE', 41),
  ]);
  return { title, A, B };
}

async function storeCard(card: unknown) {
  return withUser({ userId: owner.userId }, async (tx) => {
    const c = await conv.createConversation(tx, owner.userId);
    const o = await conv.appendOwnerMessage(tx, owner.userId, { conversationId: c.id, content: 'whats the result with the server cooling job' });
    const a = await conv.appendAssistantMessage(tx, owner.userId, { conversationId: c.id, replyToMessageId: o.id, content: 'One update card below.' });
    return { conversationId: c.id, cardId: (await conv.addProposal(tx, owner.userId, { conversationId: c.id, messageId: a.id, kind: 'dispatch_task', proposal: card as Record<string, unknown> })).id };
  });
}

const toolset = (conversationId?: string) =>
  createOpsChatToolset({ userId: owner.userId, projects: [rec], orgRoles: new Map([[owner.orgId, 'owner' as const]]), ...(conversationId ? { conversationId } : {}) });

beforeAll(async () => {
  if (!available) return;
  const u = randomUUID();
  await db.insert(profiles).values({ id: u, email: `sib-${u.slice(0, 8)}@t.local`, displayName: 'King' });
  const orgId = (await db.insert(organizations).values({ name: 'Empera', slug: `sib-${u.slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId: u, role: 'owner' });
  const key = fixtureKey('sib');
  const pid = (await db.insert(projects).values({ orgId, key, name: 'Empera Air Conditioning and Heating' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: u, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  owner = { userId: u, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' } as TenantContext;
  h.ctx = owner;
  rec = { orgId, projectId: pid, key, name: 'Empera Air Conditioning and Heating', description: '', projectRole: 'admin' } as unknown as ProjectAccessRecord;
  agentId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Marketing Lead', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 1000 })
      .returning({ id: agents.id })
  )[0]!.id;
});

describe.skipIf(!available)('P5c-2b — one job dispatched twice (the production split)', () => {
  it('by TITLE: identical duplicates are one job (no "which one?"): ONE card with ALL FOUR answers, covering both tasks', async () => {
    const job = await seedJob('t1');
    // Not part of the job: a different title, and a CANCELLED duplicate.
    await db.insert(tasks).values({ orgId: owner.orgId, projectId: owner.projectId, title: 'Server Cabinet Cooling — something else', input: 'x', providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: owner.userId, assignedPrimaryAgentId: agentId });
    const cancelled = (
      await db.insert(tasks).values({ orgId: owner.orgId, projectId: owner.projectId, title: job.title, input: 'x', providerSelection: 'openai', reviewEnabled: false, status: 'cancelled', createdBy: owner.userId, assignedPrimaryAgentId: agentId }).returning({ id: tasks.id })
    )[0]!.id;

    // Each task alone is stale with ITS share of the answers.
    const [sa, sb] = await withTenant(owner, (tx) => loadTaskStates(tx, owner, [job.A.id, job.B.id]));
    expect([sa!.stale?.decisions.length, sb!.stale?.decisions.length].sort()).toEqual([1, 3]);

    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'propose_update_task', input: { project: rec.key, task: `${TITLE} t1` } }));
    expect(out).toMatchObject({ prepared: true, decisions: 4 });
    const card = ts.getProposals()[0] as unknown as { instructions: string; updateOf: { taskId: string; taskIds: string[]; siblingRuns: { taskId: string; runId: string }[]; decisionIds: string[] } };
    for (const a of ['LEAD-LAG (alternating)', 'EMPERA AIR CONDITIONING AND HEATING', 'NO FIRE SUPPRESSION INTERFACE NEEDED', 'VISUAL SCREENING ON THE FENCE SIDE']) expect(card.instructions).toContain(a);
    expect(card.instructions).toContain(`This job was dispatched 2 times under this title (tasks ${job.A.id}, ${job.B.id})`);
    expect(card.updateOf.taskId).toBe(job.B.id); // the newest duplicate is the base
    expect(new Set(card.updateOf.taskIds)).toEqual(new Set([job.A.id, job.B.id]));
    expect(card.updateOf.taskIds).not.toContain(cancelled);
    expect(card.updateOf.siblingRuns).toEqual(expect.arrayContaining([{ taskId: job.A.id, runId: job.A.run }, { taskId: job.B.id, runId: job.B.run }]));
    expect(card.updateOf.decisionIds).toHaveLength(4);

    // Asking from the OTHER duplicate while the card is pending → the same job → refused (never a second card).
    const stored = await storeCard(card);
    const again = JSON.parse(await toolset(stored.conversationId).runTool({ name: 'propose_update_task', input: { project: rec.key, task: job.A.id } }));
    expect(again).toMatchObject({ prepared: false, alreadyOffered: stored.cardId });

    // Confirm → BOTH duplicates read SUPERSEDED; no further update offered from either.
    const r = await confirm(stored.cardId);
    expect(r.state).toBe('done');
    const [a2, b2] = await withTenant(owner, (tx) => loadTaskStates(tx, owner, [job.A.id, job.B.id]));
    expect(a2!.supersededBy?.taskId).toBe(r.executed!.taskId);
    expect(b2!.supersededBy?.taskId).toBe(r.executed!.taskId);
    expect(a2!.stale).toBeNull();
    expect(b2!.stale).toBeNull();
    for (const t of [job.A.id, job.B.id]) {
      expect(JSON.parse(await toolset().runTool({ name: 'propose_update_task', input: { project: rec.key, task: t } })).note).toMatch(/already updated: task/);
    }
  });

  it('freshness covers the WHOLE job: re-running the OTHER duplicate after the card was prepared → stale, nothing started', async () => {
    const job = await seedJob('t2');
    const ts = toolset();
    JSON.parse(await ts.runTool({ name: 'propose_update_task', input: { project: rec.key, task: job.B.id } }));
    const stored = await storeCard(ts.getProposals()[0]);
    await db.insert(runs).values({ classification: 'live', orgId: owner.orgId, projectId: owner.projectId, taskId: job.A.id, status: 'running', primaryAgentId: agentId, startedAt: new Date() });
    const r = await confirm(stored.cardId);
    expect(r.state).toBe('stale');
    expect(r.error).toMatch(/no longer current.*another task of this job was run again/);
    expect(await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.opsChatProposalId, stored.cardId))).toHaveLength(0);
  });

  it('…and a new answer on the OTHER duplicate after the card was prepared → stale, nothing started', async () => {
    const job = await seedJob('t3');
    const ts = toolset();
    JSON.parse(await ts.runTool({ name: 'propose_update_task', input: { project: rec.key, task: job.B.id } }));
    const stored = await storeCard(ts.getProposals()[0]);
    await db.insert(ownerQuestions).values({ orgId: owner.orgId, projectId: owner.projectId, taskId: job.A.id, runId: job.A.run, agentId, question: 'Late question?', status: 'answered', answer: 'late', answeredBy: owner.userId, answeredAt: new Date() });
    const r = await confirm(stored.cardId);
    expect(r.state).toBe('stale');
    expect(r.error).toMatch(/decisions after the card was prepared/);
  });

  // Regression (Hub prod, 2026-10-22): the update card carried the REJECTED 1,400 lb draft but not the APPROVED
  // shared-plenum draft eaeb0dd7, and the update run's punch list then said "1,400 lb combined load".
  const draft = (taskId: string, runId: string, status: 'approved' | 'rejected', content: string, note: string | null, minutesAgo: number) => ({
    orgId: owner.orgId,
    projectId: owner.projectId,
    taskId,
    runId,
    actionType: 'file_write' as const,
    payload: { path: 'punch_list.md', content },
    payloadSha256: 'x'.repeat(64),
    summary: 'Save punch list to workspace',
    status,
    decidedBy: owner.userId,
    decidedAt: new Date(Date.now() - minutesAgo * 60_000),
    decisionNote: note,
    expiresAt: new Date(Date.now() + 86_400_000),
  });

  it('the APPROVED draft is carried verbatim as the chosen version; the rejected one is marked NOT chosen; both re-checked at confirm', async () => {
    const job = await seedJob('t4');
    await db.insert(approvals).values([
      draft(job.B.id, job.B.run, 'approved', 'SHARED 36x18 PLENUM MANIFOLD. STRUCTURAL RATING 2,500 LB.', null, 30),
      draft(job.A.id, job.A.run, 'rejected', 'Independent per-unit ducting, 1,400 lb.', 'Owner chose the shared-duct version instead.', 29),
    ]);
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'propose_update_task', input: { project: rec.key, task: job.B.id } }));
    expect(out).toMatchObject({ prepared: true, decisions: 5, approvedResults: 1 }); // the approval is context, not a 6th decision
    const card = ts.getProposals()[0] as unknown as { instructions: string; updateOf: { approvedIds: string[] } };
    expect(card.instructions).toContain("=== RESULTS THE OWNER APPROVED (the owner's chosen version — build on these) ===");
    expect(card.instructions).toContain('Approved content:\n    File punch_list.md:\n    SHARED 36x18 PLENUM MANIFOLD. STRUCTURAL RATING 2,500 LB.');
    expect(card.instructions).toContain('— NOT chosen; do not use it or any figure or specification it describes: Save punch list to workspace');
    expect(card.updateOf.approvedIds).toHaveLength(1);

    // Another result approved after the card was prepared → the card is stale, nothing starts.
    const stored = await storeCard(card);
    await db.insert(approvals).values(draft(job.A.id, job.A.run, 'approved', 'Late approval.', null, 0));
    const r = await confirm(stored.cardId);
    expect(r.state).toBe('stale');
    expect(r.error).toMatch(/approved a result of this job after the card was prepared/);
    expect(await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.opsChatProposalId, stored.cardId))).toHaveLength(0);
  });
});
