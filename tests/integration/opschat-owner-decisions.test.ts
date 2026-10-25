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
const { loadTaskStates } = await import('@/domain/opschat/task-state');
const { selectRelevantDecisions } = await import('@/domain/decisions/decisions');
const { withTenant, withUser } = await import('@/db/tenant');

const available = await rlsAvailable('opschat-owner-decisions.test');
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
  await db.insert(profiles).values({ id: u, email: `od-${u.slice(0, 8)}@t.local`, displayName: 'King' });
  const orgId = (await db.insert(organizations).values({ name: 'Empera', slug: `od-${u.slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId: u, role: 'owner' });
  const key = fixtureKey('od');
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

describe.skipIf(!available)('owner decisions that runs use', () => {
  it('record a chat-stated fact → accepted task guidance; the task reads stale; the update card carries it; the run gets it', async () => {
    const t = await seedTask('Server Cabinet Cooling — punch list r1');
    const ts = toolset();
    const prep = await run(ts, 'propose_record_decision', { project: rec.key, task: t.id, title: 'Server cabinet heat load', statement: 'The single server cabinet produces 20 kW; size everything for that load.' });
    expect(prep).toMatchObject({ prepared: true });
    expect((await db.select().from(decisions).where(eq(decisions.projectId, owner.projectId))).length).toBe(0); // nothing written by the tool

    const r = await confirm(await storeCard(ts.getProposals()[0]));
    expect(r.state).toBe('done');
    expect(r.executed).toMatchObject({ outcome: 'recorded' });
    const [d] = await db.select().from(decisions).where(eq(decisions.id, r.executed!.decisionIds![0]!));
    expect(d).toMatchObject({ status: 'accepted', applicability: 'guidance', scope: 'task', scopeTaskId: t.id, originatingTaskId: t.id, authorLabel: 'Owner (Ops Chat)' });

    // A later run of this task gets it: a re-run puts the task back to `pending` (requestRerun), and task-scoped
    // guidance is active while its task is open (it goes inactive once the task is completed/cancelled again).
    const select = () => withTenant(owner, (tx) => selectRelevantDecisions(tx, owner, { currentTaskId: t.id, currentObjectiveId: null, objectiveTaskIds: [], docPaths: new Set() }));
    expect((await select()).map((x) => x.id)).not.toContain(d!.id); // completed task → not active
    await db.update(tasks).set({ status: 'pending' }).where(eq(tasks.id, t.id));
    expect((await select()).map((x) => x.id)).toContain(d!.id);
    await db.update(tasks).set({ status: 'completed' }).where(eq(tasks.id, t.id));

    // Recorded after the run started → the task is stale and says why.
    const [st] = await withTenant(owner, (tx) => loadTaskStates(tx, owner, [t.id]));
    expect(st!.stale?.decisions.map((x) => x.kind)).toEqual(['decision_recorded']);
    expect(st!.ownerFacing).toContain('(1 recorded decision)');

    // …and the update card carries the statement verbatim (the update task is a NEW task — injection alone would miss it).
    const ts2 = toolset();
    expect(await run(ts2, 'propose_update_task', { project: rec.key, task: t.id })).toMatchObject({ prepared: true, decisions: 1 });
    const card = ts2.getProposals()[0] as unknown as { instructions: string };
    expect(card.instructions).toContain('- DECISION recorded by the owner (');
    expect(card.instructions).toContain('The single server cabinet produces 20 kW; size everything for that load.');
  });

  it('a decision recorded BEFORE the latest run is carried as a standing constraint, not counted as new', async () => {
    const t = await seedTask('Server Cabinet Cooling — punch list r2', 48);
    await db.insert(decisions).values({
      orgId: owner.orgId, projectId: owner.projectId, title: 'Duct choice', summary: 'Use the shared 36x18 plenum.', authorLabel: 'Owner (Ops Chat)',
      status: 'accepted', applicability: 'guidance', scope: 'task', scopeTaskId: t.id, originatingTaskId: t.id, reviewedBy: owner.userId, reviewedAt: new Date(Date.now() - 72 * 3_600_000),
    });
    // A post-run answer is what makes the job stale here.
    await db.insert(ownerQuestions).values({ orgId: owner.orgId, projectId: owner.projectId, taskId: t.id, runId: t.runId, agentId, question: 'Lead-Lag or Parallel?', status: 'answered', answer: 'Lead-Lag', answeredBy: owner.userId, answeredAt: new Date() });
    const [st] = await withTenant(owner, (tx) => loadTaskStates(tx, owner, [t.id]));
    expect(st!.stale?.decisions.map((x) => x.kind)).toEqual(['question_answered']);
    const ts = toolset();
    expect(await run(ts, 'propose_update_task', { project: rec.key, task: t.id })).toMatchObject({ prepared: true, decisions: 1 });
    const card = ts.getProposals()[0] as unknown as { instructions: string; updateOf: { constraintIds: string[] } };
    expect(card.instructions).toContain('=== OWNER DECISIONS ALREADY RECORDED FOR THIS JOB (still apply) ===\n- Duct choice (recorded ');
    expect(card.instructions).toContain('Use the shared 36x18 plenum.');
    expect(card.updateOf.constraintIds).toHaveLength(1);
  });

  it('extracted candidates: listed, accepted on one card as guidance for their task; an already-decided candidate → stale card, nothing accepted', async () => {
    const t = await seedTask('Server Cabinet Cooling — punch list r3');
    const other = await seedTask('Unrelated job r3');
    const cand = (taskId: string, title: string) => ({
      orgId: owner.orgId, projectId: owner.projectId, title, summary: `${title} — as extracted`, authorLabel: 'Research Analyst',
      status: 'proposed' as const, applicability: 'record' as const, scope: 'workspace' as const, originatingTaskId: taskId, suggestionReason: 'run extraction',
    });
    const [a, b, c] = await db
      .insert(decisions)
      .values([cand(t.id, 'Lead-Lag Sequencing'), cand(t.id, 'Visual Screening Requirement'), cand(other.id, 'Something else')])
      .returning({ id: decisions.id });

    const listed = await run(toolset(), 'list_decision_candidates', { project: rec.key, task: t.id });
    expect((listed.candidates as { id: string }[]).map((x) => x.id).sort()).toEqual([a!.id, b!.id].sort()); // only this job's

    const ts = toolset();
    expect(await run(ts, 'propose_accept_decisions', { project: rec.key, decision_ids: [a!.id, b!.id] })).toMatchObject({ prepared: true, count: 2 });
    const cardA = ts.getProposals()[0];
    // A second card for one of the same candidates, prepared before the first is confirmed.
    const ts2 = toolset();
    await run(ts2, 'propose_accept_decisions', { project: rec.key, decision_ids: [b!.id] });

    const r = await confirm(await storeCard(cardA));
    expect(r).toMatchObject({ state: 'done', executed: { outcome: 'accepted' } });
    const rows = await db.select().from(decisions).where(eq(decisions.originatingTaskId, t.id));
    for (const row of rows) expect(row).toMatchObject({ status: 'accepted', applicability: 'guidance', scope: 'task', scopeTaskId: t.id });
    expect((await db.select().from(decisions).where(eq(decisions.id, c!.id)))[0]!.status).toBe('proposed');

    const r2 = await confirm(await storeCard(ts2.getProposals()[0]));
    expect(r2.state).toBe('stale');
    expect(r2.error).toMatch(/no longer waiting for the owner/);
  });

  it('refusals: unknown or already-decided candidate ids; a viewer cannot record', async () => {
    const t = await seedTask('Server Cabinet Cooling — punch list r4');
    expect((await run(toolset(), 'propose_accept_decisions', { project: rec.key, decision_ids: [randomUUID()] })).error).toMatch(/Not waiting for the owner/);
    const viewer = createOpsChatToolset({ userId: owner.userId, projects: [{ ...rec, projectRole: 'viewer' } as ProjectAccessRecord], orgRoles: new Map([[owner.orgId, 'member' as const]]) });
    expect((await run(viewer, 'propose_record_decision', { project: rec.key, task: t.id, title: 'x', statement: 'y' })).error).toMatch(/admin/);
    expect(viewer.getProposals()).toHaveLength(0);
  });
});
