import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { rlsAvailable } from '@tests/support/db';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withUser } from '@/db/tenant';
import { type ProjectAccessRecord } from '@/db/system';
import { agents, memberships, opsChatProposals, organizations, ownerQuestions, profiles, projectMembers, projects, runs, spendLimits, tasks } from '@/db/schema';

/**
 * P5c-2 review fix — CONFIRM-TIME freshness of an "update this job" card, through the REAL confirm route against a real
 * DB (only the session guard is stubbed: requireUser/requireTenant return the seeded owner). The card froze the
 * original task's latest run + post-run decisions when prepared; if the job changed before the owner confirms, the
 * card must go STALE with a plain reason and NOTHING may be created.
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
const { addProposal, appendAssistantMessage, appendOwnerMessage, createConversation } = await import('@/domain/opschat/conversations');

const available = await rlsAvailable('opschat-update-card-confirm.test');
const db = getSetupDb();
let owner: TenantContext;
let rec: ProjectAccessRecord;
let agentId = '';

const confirm = async (proposalId: string) => {
  const res = await POST(new Request('http://localhost/api/ops-chat/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposalId, intent: 'confirm' }) }));
  return { status: res.status, json: (await res.json()) as { state?: string; error?: string; executed?: { taskId?: string } } };
};
const tasksFromCard = (cardId: string) => db.select({ id: tasks.id }).from(tasks).where(eq(tasks.opsChatProposalId, cardId));
const cardRow = async (cardId: string) => (await db.select({ state: opsChatProposals.state, error: opsChatProposals.error }).from(opsChatProposals).where(eq(opsChatProposals.id, cardId)))[0]!;

/** A stale task (2 blockers answered after its run) + ONE pending update card stored in a conversation. */
async function scenario(tag: string): Promise<{ taskId: string; runId: string; card: Record<string, unknown>; store: () => Promise<string> }> {
  const start = new Date(Date.now() - 3 * 60 * 60_000);
  const taskId = (
    await db
      .insert(tasks)
      .values({ orgId: owner.orgId, projectId: owner.projectId, title: `Cooling ${tag}`, input: 'Size the ducts.', providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: owner.userId, assignedPrimaryAgentId: agentId })
      .returning({ id: tasks.id })
  )[0]!.id;
  const runId = (
    await db
      .insert(runs)
      .values({ classification: 'live', orgId: owner.orgId, projectId: owner.projectId, taskId, status: 'completed', primaryAgentId: agentId, consolidatedResult: 'blocked', startedAt: start, finishedAt: new Date(start.getTime() + 60_000) })
      .returning({ id: runs.id })
  )[0]!.id;
  await db.insert(ownerQuestions).values(
    [1, 2].map((i) => ({ orgId: owner.orgId, projectId: owner.projectId, taskId, runId, agentId, question: `Blocker ${i}?`, status: 'answered', answer: `Answer ${i}`, answeredBy: owner.userId, answeredAt: new Date(start.getTime() + i * 10 * 60_000) })),
  );
  const ts = createOpsChatToolset({ userId: owner.userId, projects: [rec], orgRoles: new Map([[owner.orgId, 'owner' as const]]) });
  expect(JSON.parse(await ts.runTool({ name: 'propose_update_task', input: { project: rec.key, task: taskId } })).prepared).toBe(true);
  const card = ts.getProposals()[0] as unknown as Record<string, unknown>;
  const store = () =>
    withUser({ userId: owner.userId }, async (tx) => {
      const c = await createConversation(tx, owner.userId);
      const o = await appendOwnerMessage(tx, owner.userId, { conversationId: c.id, content: 'update it' });
      const a = await appendAssistantMessage(tx, owner.userId, { conversationId: c.id, replyToMessageId: o.id, content: 'card below' });
      return (await addProposal(tx, owner.userId, { conversationId: c.id, messageId: a.id, kind: 'dispatch_task', proposal: card })).id;
    });
  return { taskId, runId, card, store };
}

beforeAll(async () => {
  if (!available) return;
  const u = randomUUID();
  await db.insert(profiles).values({ id: u, email: `ucc-${u.slice(0, 8)}@t.local`, displayName: 'King' });
  const orgId = (await db.insert(organizations).values({ name: 'Empera', slug: `ucc-${u.slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId: u, role: 'owner' });
  const key = fixtureKey('ucc');
  const pid = (await db.insert(projects).values({ orgId, key, name: 'Empera A/C' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: u, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  owner = { userId: u, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' } as TenantContext;
  h.ctx = owner;
  rec = { orgId, projectId: pid, key, name: 'Empera A/C', description: '', projectRole: 'admin' } as unknown as ProjectAccessRecord;
  agentId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Mechanical Engineer', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 1000 })
      .returning({ id: agents.id })
  )[0]!.id;
});

describe.skipIf(!available)('update card — confirm-time freshness (real confirm route)', () => {
  it('4. unchanged basis → confirms normally: one new task, linked to the card, carrying the answers', async () => {
    const s = await scenario('ok');
    expect(s.card).toMatchObject({ updateOf: { taskId: s.taskId, runId: s.runId, decisions: 2, decisionIds: expect.any(Array) } });
    const cardId = await s.store();
    const r = await confirm(cardId);
    expect(r).toMatchObject({ status: 200, json: { state: 'done' } });
    const made = await tasksFromCard(cardId);
    expect(made).toHaveLength(1);
    const input = (await db.select({ input: tasks.input }).from(tasks).where(eq(tasks.id, made[0]!.id)))[0]!.input;
    expect(input).toContain('Answer 1');
    expect(input).toContain('Answer 2');
  });

  it('1. original task RE-RUN after the card was prepared → stale, plain reason, nothing created', async () => {
    const s = await scenario('rerun');
    const cardId = await s.store();
    await db.insert(runs).values({ classification: 'live', orgId: owner.orgId, projectId: owner.projectId, taskId: s.taskId, status: 'running', primaryAgentId: agentId, startedAt: new Date() });
    const r = await confirm(cardId);
    expect(r.json.state).toBe('stale');
    expect(r.json.error).toContain('This update card is no longer current because the job changed after the card was prepared. Ask Ops Chat for a fresh update card. Nothing was started.');
    expect(r.json.error).toMatch(/run again/);
    expect(await tasksFromCard(cardId)).toHaveLength(0);
    expect(await cardRow(cardId)).toMatchObject({ state: 'stale' });
  });

  it('2. ONE more owner answer after the card was prepared → stale, nothing created', async () => {
    const s = await scenario('answer');
    const cardId = await s.store();
    await db.insert(ownerQuestions).values({ orgId: owner.orgId, projectId: owner.projectId, taskId: s.taskId, runId: s.runId, agentId, question: 'Blocker 3?', status: 'answered', answer: 'Late answer', answeredBy: owner.userId, answeredAt: new Date() });
    const r = await confirm(cardId);
    expect(r.json.state).toBe('stale');
    expect(r.json.error).toMatch(/no longer current.*decisions after the card was prepared/);
    expect(await tasksFromCard(cardId)).toHaveLength(0);
  });

  it('3. another update card for the same task already CONFIRMED → this one goes stale, nothing created', async () => {
    const s = await scenario('twice');
    const first = await s.store();
    const second = await s.store(); // e.g. offered in another conversation before the first was confirmed
    expect((await confirm(first)).json.state).toBe('done');
    const r = await confirm(second);
    expect(r.json.state).toBe('stale');
    expect(r.json.error).toMatch(/no longer current.*already updated by task/);
    expect(await tasksFromCard(second)).toHaveLength(0);
    expect(await tasksFromCard(first)).toHaveLength(1);
  });

  it('a decision REMOVED from the basis (answer withdrawn → no longer answered) also invalidates the card', async () => {
    const s = await scenario('withdrawn');
    const cardId = await s.store();
    await db.update(ownerQuestions).set({ status: 'dismissed' }).where(eq(ownerQuestions.taskId, s.taskId));
    const r = await confirm(cardId);
    expect(r.json.state).toBe('stale');
    expect(await tasksFromCard(cardId)).toHaveLength(0);
  });
});
