import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { rlsAvailable } from '@tests/support/db';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { type ProjectAccessRecord } from '@/db/system';
import { agents, decisions, memberships, organizations, ownerQuestions, profiles, projectMembers, projects, runs, spendLimits, tasks } from '@/db/schema';

/**
 * Owner decisions that runs actually use. Evidence (Hub prod, server-cooling, read-only 2026-10-22): the owner said
 * "20 kW" twice in chat and it reached no run; the workspace's 72 run-extracted decisions were all still `proposed`, so
 * none was ever injected. Real DB, real tools, real confirm route (session guard stubbed).
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
const { withUser } = await import('@/db/tenant');

const available = await rlsAvailable('opschat-record-batch.test');
const db = getSetupDb();
let owner: TenantContext;
let rec: ProjectAccessRecord;
let agentId = '';

const confirm = async (proposalId: string) =>
  (await (await POST(new Request('http://localhost/api/ops-chat/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposalId, intent: 'confirm' }) }))).json()) as {
    state: string;
    error?: string;
    executed?: { outcome?: string; decisionIds?: string[]; taskId?: string };
  };

async function storeCard(card: unknown) {
  return withUser({ userId: owner.userId }, async (tx) => {
    const c = await conv.createConversation(tx, owner.userId);
    const o = await conv.appendOwnerMessage(tx, owner.userId, { conversationId: c.id, content: 'the cabinet is 20 kW' });
    const a = await conv.appendAssistantMessage(tx, owner.userId, { conversationId: c.id, replyToMessageId: o.id, content: 'Card below.' });
    const kind = (card as { kind: string }).kind;
    return (await conv.addProposal(tx, owner.userId, { conversationId: c.id, messageId: a.id, kind, proposal: card as Record<string, unknown> })).id;
  });
}

const toolset = () => createOpsChatToolset({ userId: owner.userId, projects: [rec], orgRoles: new Map([[owner.orgId, 'owner' as const]]) });
const run = async (ts: ReturnType<typeof toolset>, name: string, input: Record<string, unknown>) => JSON.parse(await ts.runTool({ name, input })) as Record<string, unknown>;

/** One completed task with one run that started `hoursAgo` hours ago. */
async function seedTask(title: string, hoursAgo = 48) {
  const start = new Date(Date.now() - hoursAgo * 3_600_000);
  const id = (
    await db
      .insert(tasks)
      .values({ orgId: owner.orgId, projectId: owner.projectId, title, input: 'Punch list + vendor quote prep for dual FUSION-TEC.', providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: owner.userId, assignedPrimaryAgentId: agentId, createdAt: start })
      .returning({ id: tasks.id })
  )[0]!.id;
  const runId = (
    await db
      .insert(runs)
      .values({ classification: 'live', orgId: owner.orgId, projectId: owner.projectId, taskId: id, status: 'completed', primaryAgentId: agentId, consolidatedResult: 'draft', startedAt: start, finishedAt: new Date(start.getTime() + 9_000) })
      .returning({ id: runs.id })
  )[0]!.id;
  return { id, runId, title };
}

beforeAll(async () => {
  if (!available) return;
  const u = randomUUID();
  await db.insert(profiles).values({ id: u, email: `rb-${u.slice(0, 8)}@t.local`, displayName: 'King' });
  const orgId = (await db.insert(organizations).values({ name: 'Empera', slug: `rb-${u.slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId: u, role: 'owner' });
  const key = fixtureKey('rb');
  const pid = (await db.insert(projects).values({ orgId, key, name: 'Empera Air Conditioning and Heating' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: u, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  owner = { userId: u, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' } as TenantContext;
  h.ctx = owner;
  rec = { orgId, projectId: pid, key, name: 'Empera Air Conditioning and Heating', description: '', projectRole: 'admin' } as unknown as ProjectAccessRecord;
  agentId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Research Analyst', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 1000 })
      .returning({ id: agents.id })
  )[0]!.id;
});

/**
 * D of 5 (owner feedback 2026-10-23: seven separate cards for one message). propose_record_batch puts several answers
 * and decisions for one workspace on ONE card; one Confirm records all of them in one transaction, or none.
 */
async function seedQuestion(taskId: string, runId: string, question: string) {
  return (
    await db
      .insert(ownerQuestions)
      .values({ orgId: owner.orgId, projectId: owner.projectId, taskId, runId, agentId, question, status: 'open' })
      .returning({ id: ownerQuestions.id })
  )[0]!.id;
}

describe.skipIf(!available)('one-tap batch: answers + decisions', () => {
  it('3 answers + 2 decisions on ONE card → one Confirm records all five', async () => {
    const t = await seedTask('Server Cabinet Cooling — batch');
    const q1 = await seedQuestion(t.id, t.runId, 'What is the IT heat load per cabinet?');
    const q2 = await seedQuestion(t.id, t.runId, 'How tall is the neighbor fence?');
    const q3 = await seedQuestion(t.id, t.runId, 'Which screening material?');
    const ts = toolset();
    const prepared = await run(ts, 'propose_record_batch', {
      project: rec.key,
      task: t.id,
      answers: [
        { questionId: q1, answer: '20 kW per cabinet' },
        { questionId: q2, answer: '6 feet' },
        { questionId: q3, answer: 'Lattice' },
      ],
      decisions: [
        { title: 'Duct path', statement: 'Basement install; ducts go through an 18-inch-high window opening.' },
        { title: 'Unit line', statement: 'Bard FUSION-TEC wall-mount, rear supply/return.' },
      ],
    });
    expect(prepared).toMatchObject({ prepared: true });
    expect(ts.getProposals()).toHaveLength(1); // ONE card, not five
    const card = ts.getProposals()[0] as unknown as { kind: string; answers: unknown[]; decisions: unknown[] };
    expect(card.kind).toBe('record_batch');
    expect(card.answers).toHaveLength(3);
    expect(card.decisions).toHaveLength(2);

    const res = await confirm(await storeCard(card));
    expect(res.state).toBe('done');
    expect(res.executed).toMatchObject({ outcome: 'recorded' });
    const qs = await db.select({ id: ownerQuestions.id, status: ownerQuestions.status, answer: ownerQuestions.answer }).from(ownerQuestions).where(eq(ownerQuestions.taskId, t.id));
    expect(qs.every((q) => q.status === 'answered')).toBe(true);
    expect(qs.find((q) => q.id === q2)!.answer).toBe('6 feet');
    const ds = await db.select({ title: decisions.title, status: decisions.status, scopeTaskId: decisions.scopeTaskId }).from(decisions).where(eq(decisions.scopeTaskId, t.id));
    expect(ds.map((d) => d.title).sort()).toEqual(['Duct path', 'Unit line']);
    expect(ds.every((d) => d.status === 'accepted')).toBe(true);
  });

  it('all-or-nothing: one item no longer valid at Confirm → the card goes stale and NOTHING is recorded', async () => {
    const t = await seedTask('Server Cabinet Cooling — batch rollback');
    const q1 = await seedQuestion(t.id, t.runId, 'Heat load?');
    const q2 = await seedQuestion(t.id, t.runId, 'Fence height?');
    const ts = toolset();
    await run(ts, 'propose_record_batch', {
      project: rec.key,
      task: t.id,
      answers: [{ questionId: q1, answer: '20 kW' }, { questionId: q2, answer: '6 ft' }],
      decisions: [{ title: 'Fence screening', statement: 'Lattice, 6 ft.' }],
    });
    const id = await storeCard(ts.getProposals()[0]);
    // q2 is answered elsewhere between preparing and confirming
    await db.update(ownerQuestions).set({ status: 'answered', answer: 'answered elsewhere', answeredBy: owner.userId, answeredAt: new Date() }).where(eq(ownerQuestions.id, q2));
    const res = await confirm(id);
    expect(res.state).toBe('stale');
    const first = (await db.select({ status: ownerQuestions.status }).from(ownerQuestions).where(eq(ownerQuestions.id, q1)))[0]!;
    expect(first.status).toBe('open'); // rolled back
    const ds = await db.select({ id: decisions.id }).from(decisions).where(eq(decisions.scopeTaskId, t.id));
    expect(ds).toHaveLength(0); // rolled back
  });

  it('refusals at preparation: a question from another workspace or already answered, decisions without a task, too many items', async () => {
    const t = await seedTask('Server Cabinet Cooling — batch refusals');
    const answered = await seedQuestion(t.id, t.runId, 'Already answered?');
    await db.update(ownerQuestions).set({ status: 'answered', answer: 'x', answeredBy: owner.userId, answeredAt: new Date() }).where(eq(ownerQuestions.id, answered));
    const ts = toolset();
    expect(await run(ts, 'propose_record_batch', { project: rec.key, answers: [{ questionId: answered, answer: 'y' }] })).toHaveProperty('error');
    expect(await run(ts, 'propose_record_batch', { project: rec.key, answers: [{ questionId: randomUUID(), answer: 'y' }] })).toHaveProperty('error');
    expect(await run(ts, 'propose_record_batch', { project: rec.key, decisions: [{ title: 'a', statement: 'b' }] })).toMatchObject({ error: expect.stringContaining('task is required') });
    const many = Array.from({ length: 13 }, (_, i) => ({ title: `d${i}`, statement: 's' }));
    expect(await run(ts, 'propose_record_batch', { project: rec.key, task: t.id, decisions: many })).toMatchObject({ error: expect.stringContaining('At most 12') });
    expect(await run(ts, 'propose_record_batch', { project: rec.key })).toMatchObject({ error: expect.stringContaining('at least one') });
    expect(ts.getProposals()).toHaveLength(0);
  });
});
