import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { rlsAvailable } from '@tests/support/db';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { type ProjectAccessRecord } from '@/db/system';
import { agents, memberships, organizations, ownerQuestions, profiles, projectMembers, projects, runs, spendLimits, tasks } from '@/db/schema';

/**
 * P5c-3 — the server-cooling CONVERSATION end to end, against a real DB through the real routes, worker and tools
 * (only the session guard is stubbed to the seeded owner; the model is a FakeProvider):
 *
 *   old run exists (blocked on 4 questions) → owner answers the 4 blockers → Hub identifies the old result as STALE →
 *   Hub offers ONE update-run card → owner confirms (real confirm route) → the run finishes (real worker) →
 *   the completion appears in the ORIGINATING conversation without the owner asking (live-refresh endpoint + page
 *   timeline) → "what did it come back with?" returns the ACTUAL run content (get_task_result), and the active job a
 *   short follow-up resolves to is the update job (the old one reads SUPERSEDED).
 */

const h = vi.hoisted(() => ({ ctx: null as unknown as { userId: string; orgId: string; projectId: string; orgRole: string; projectRole: string }, key: '' }));
vi.mock('@/domain/auth/guard', () => ({
  requireUser: async () => ({ id: h.ctx.userId, email: 'king@t.local', displayName: 'King' }),
  requireTenant: async () => h.ctx,
  tenantForUser: async (userId: string, key: string) => (userId === h.ctx.userId && key === h.key ? h.ctx : null),
}));

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');
process.env.RATE_LIMIT_RUNS_PER_MINUTE = '1000';

const { POST: confirmPOST } = await import('@/app/api/ops-chat/confirm/route');
const { GET: linkedRunsGET } = await import('@/app/api/ops-chat/linked-runs/route');
const { createOpsChatToolset } = await import('@/domain/opschat/tools');
const conv = await import('@/domain/opschat/conversations');
const { loadContinuityCards } = await import('@/domain/opschat/continuity');
const { anchorEntries, completionEntries, conversationContextSection } = await import('@/domain/opschat/conversation-continuity');
const { loadLinkedRunViews } = await import('@/domain/opschat/linked-runs');
const { cardLabelOf } = await import('@/domain/opschat/card-state');
const { withUser } = await import('@/db/tenant');
const { claimJobForTask, runClaimedJob } = await import('@/domain/jobs/jobs');
const { setProviderOverrideForTests } = await import('@/providers/registry');

const available = await rlsAvailable('opschat-continuity-e2e.test');
const db = getSetupDb();
let owner: TenantContext;
let rec: ProjectAccessRecord;
let agentId = '';
const resolve = async (key: string) => (key === h.key ? owner : null);
const UPDATED = 'UPDATED SIZING: CFM ≈ 3,410 at 55°F supply; trunk 36×20; two 14×8 branches to the FUSION-TEC units.';
const BLOCKERS = ['Supply air 55°F at the cabinet inlet.', 'Cabinet is fully sealed with a rear door.', 'Two FUSION-TEC units, 3.5 kW each.', 'Max room ambient is 85°F.'];

const toolset = (conversationId: string) =>
  createOpsChatToolset({ userId: owner.userId, projects: [rec], orgRoles: new Map([[owner.orgId, 'owner' as const]]), conversationId });
const runTool = async (conversationId: string, name: string, input: Record<string, unknown>) => JSON.parse(await toolset(conversationId).runTool({ name, input }));

/** What the chat route appends to the system prompt for this turn (same functions, same order). */
async function sectionFor(conversationId: string, ownerMessageId: string): Promise<string> {
  const cards = await withUser({ userId: owner.userId }, (tx) => conv.listRunStartingCards(tx, owner.userId, conversationId));
  const views = await loadLinkedRunViews(cards, resolve);
  const continuity = await loadContinuityCards(cards, resolve, views);
  const prev = await withUser({ userId: owner.userId }, (tx) => conv.previousOwnerMessageAt(tx, owner.userId, conversationId, ownerMessageId));
  return conversationContextSection(continuity, prev);
}

beforeAll(async () => {
  if (!available) return;
  const u = randomUUID();
  await db.insert(profiles).values({ id: u, email: `e2e-${u.slice(0, 8)}@t.local`, displayName: 'King' });
  const orgId = (await db.insert(organizations).values({ name: 'Empera', slug: `e2e-${u.slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId: u, role: 'owner' });
  h.key = fixtureKey('e2e');
  const pid = (await db.insert(projects).values({ orgId, key: h.key, name: 'Empera A/C' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: u, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  owner = { userId: u, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' } as TenantContext;
  h.ctx = owner;
  rec = { orgId, projectId: pid, key: h.key, name: 'Empera A/C', description: '', projectRole: 'admin' } as unknown as ProjectAccessRecord;
  agentId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Mechanical Engineer', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 1000 })
      .returning({ id: agents.id })
  )[0]!.id;
});
afterAll(() => setProviderOverrideForTests(null));

describe.skipIf(!available)('server-cooling conversation — end to end', () => {
  it('stale → one update card → confirm → run finishes → completion in the originating chat → actual content on request', async () => {
    // ── The conversation and its ORIGINAL dispatch (yesterday): a run that came back blocked on 4 questions. ──
    const c = await withUser({ userId: owner.userId }, async (tx) => {
      const k = await conv.createConversation(tx, owner.userId);
      const o1 = await conv.appendOwnerMessage(tx, owner.userId, { conversationId: k.id, content: 'Size the ducts for the server cabinet cooling.' });
      const a1 = await conv.appendAssistantMessage(tx, owner.userId, { conversationId: k.id, replyToMessageId: o1.id, content: 'Card below.' });
      const d = await conv.addProposal(tx, owner.userId, {
        conversationId: k.id,
        messageId: a1.id,
        kind: 'dispatch_task',
        proposal: { kind: 'dispatch_task', projectKey: h.key, workspaceName: 'Empera A/C', title: 'Server Cabinet Cooling — duct sizing', instructions: 'Size the supply and return ducts.', agentId, agentName: 'Mechanical Engineer' },
      });
      await conv.transitionProposal(tx, owner.userId, { proposalId: d.id, from: 'pending', to: 'confirming' });
      return { id: k.id, dispatch: d.id };
    });
    const runStart = new Date(Date.now() - 20 * 60 * 60_000);
    const oldTask = (
      await db
        .insert(tasks)
        .values({ orgId: owner.orgId, projectId: owner.projectId, title: 'Server Cabinet Cooling — duct sizing', input: 'Size the supply and return ducts.', providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: owner.userId, assignedPrimaryAgentId: agentId, opsChatProposalId: c.dispatch })
        .returning({ id: tasks.id })
    )[0]!.id;
    await withUser({ userId: owner.userId }, (tx) => conv.transitionProposal(tx, owner.userId, { proposalId: c.dispatch, from: 'confirming', to: 'done', result: { taskId: oldTask } }));
    const oldRun = (
      await db
        .insert(runs)
        .values({ classification: 'live', orgId: owner.orgId, projectId: owner.projectId, taskId: oldTask, status: 'completed', primaryAgentId: agentId, consolidatedResult: 'Preliminary sizing — BLOCKED on 4 questions.', reviewOutcome: 'required_unmet', startedAt: runStart, finishedAt: new Date(runStart.getTime() + 60_000), opsChatProposalId: c.dispatch })
        .returning({ id: runs.id })
    )[0]!.id;
    const qIds = (
      await db
        .insert(ownerQuestions)
        .values(BLOCKERS.map((_, i) => ({ orgId: owner.orgId, projectId: owner.projectId, taskId: oldTask, runId: oldRun, agentId, question: `Blocker ${i + 1}?`, status: 'open' })))
        .returning({ id: ownerQuestions.id })
    ).map((r) => r.id);

    // ── 1. The owner answers the four blockers. ──
    for (const [i, id] of qIds.entries()) {
      await db.update(ownerQuestions).set({ status: 'answered', answer: BLOCKERS[i]!, answeredBy: owner.userId, answeredAt: new Date(Date.now() - (60 - i) * 60_000) }).where(eq(ownerQuestions.id, id));
    }

    // ── 2. "server cooling?" — the Hub resolves it to the ACTIVE JOB and says its result is STALE. ──
    const o2 = await withUser({ userId: owner.userId }, (tx) => conv.appendOwnerMessage(tx, owner.userId, { conversationId: c.id, content: 'server cooling?' }));
    const s2 = await sectionFor(c.id, o2.id);
    expect(s2).toMatch(/ACTIVE JOB: dispatch "Server Cabinet Cooling — duct sizing".*STALE: its result PREDATES 4 owner decision\(s\) — offer ONE update card/);
    expect(s2).toMatch(/RULE: a short follow-up that names no task/);

    // ── 3. The Hub offers ONE update-run card (persisted on its reply). ──
    const ts = toolset(c.id);
    const prepared = JSON.parse(await ts.runTool({ name: 'propose_update_task', input: { project: h.key, task: oldTask } }));
    expect(prepared).toMatchObject({ prepared: true, decisions: 4 });
    expect(ts.getProposals()).toHaveLength(1);
    const a2 = await withUser({ userId: owner.userId }, (tx) =>
      conv.appendAssistantMessage(tx, owner.userId, { conversationId: c.id, replyToMessageId: o2.id, content: 'Your answers came after the last run — here is ONE update card.' }),
    );
    const updateCard = (
      await withUser({ userId: owner.userId }, (tx) =>
        conv.addProposal(tx, owner.userId, { conversationId: c.id, messageId: a2.id, kind: 'dispatch_task', proposal: ts.getProposals()[0] as unknown as Record<string, unknown> }),
      )
    ).id;
    expect((await runTool(c.id, 'propose_update_task', { project: h.key, task: oldTask })).alreadyOffered).toBe(updateCard); // never a second card

    // ── 4. The owner confirms (REAL confirm route). ──
    const res = await confirmPOST(new Request('http://localhost/api/ops-chat/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ proposalId: updateCard, intent: 'confirm' }) }));
    const confirmed = (await res.json()) as { state: string; executed: { taskId: string } };
    expect(confirmed.state).toBe('done');
    const newTask = confirmed.executed.taskId;
    for (const a of BLOCKERS) expect((await db.select({ input: tasks.input }).from(tasks).where(eq(tasks.id, newTask)))[0]!.input).toContain(a);

    // While it runs, the live refresh says so (and the browser keeps polling).
    const live1 = (await (await linkedRunsGET(new Request(`http://localhost/api/ops-chat/linked-runs?conversationId=${c.id}`))).json()) as { views: Record<string, { state: string }>; entries: { proposalId: string }[] };
    expect(live1.views[updateCard]!.state).toBe('queued');
    expect(live1.entries.map((e) => e.proposalId)).toEqual([c.dispatch]); // only the OLD run has finished so far

    // ── 5. The run finishes (REAL worker, fake model). ──
    const fake = new FakeProvider('openai');
    fake.reply(UPDATED);
    setProviderOverrideForTests((id) => (id === 'openai' ? fake : undefined));
    await runClaimedJob((await claimJobForTask(owner, newTask))!);
    const newRun = (await db.select({ id: runs.id, status: runs.status }).from(runs).where(eq(runs.taskId, newTask)).orderBy(desc(runs.startedAt)).limit(1))[0]!;
    expect(newRun.status).toBe('completed');

    // ── 6. The completion appears in the ORIGINATING conversation without the owner asking. ──
    //   (a) live refresh while the chat is open:
    const live2 = (await (await linkedRunsGET(new Request(`http://localhost/api/ops-chat/linked-runs?conversationId=${c.id}`))).json()) as {
      views: Record<string, { state: string; runId: string }>;
      entries: { proposalId: string; runId: string; resultLabel: string; label: string }[];
    };
    const done = live2.entries.find((e) => e.proposalId === updateCard)!;
    expect(done).toMatchObject({ runId: newRun.id, label: 'dispatch "Server Cabinet Cooling — duct sizing — updated with your answers" to Mechanical Engineer' });
    expect(['FINAL', 'UNREVIEWED DRAFT']).toContain(done.resultLabel);
    expect(live2.entries.filter((e) => e.proposalId === updateCard)).toHaveLength(1); // exactly one per run
    //   (b) on (re)load, the page's timeline places it after the update card's reply:
    const loaded = (await withUser({ userId: owner.userId }, (tx) => conv.loadConversation(tx, owner.userId, c.id)))!;
    const allCards = loaded.messages.flatMap((m) => m.proposals);
    const views = await loadLinkedRunViews(allCards, resolve);
    const entries = completionEntries(
      allCards.map((p) => {
        const pr = p.proposal as Record<string, unknown>;
        return { proposalId: p.id, kind: p.kind, label: cardLabelOf(p.kind, pr), projectKey: pr.projectKey as string, view: views.get(p.id) ?? null };
      }),
    );
    const anchored = anchorEntries(loaded.messages, entries);
    expect(anchored.get(a2.id)!.map((e) => e.proposalId)).toEqual([updateCard]);

    // ── 7. "what did it come back with?" — the active job is the update job, and its ACTUAL content comes back. ──
    const o3 = await withUser({ userId: owner.userId }, (tx) => conv.appendOwnerMessage(tx, owner.userId, { conversationId: c.id, content: 'what did it come back with?' }));
    const s3 = await sectionFor(c.id, o3.id);
    expect(s3).toMatch(/ACTIVE JOB: dispatch "Server Cabinet Cooling — duct sizing — updated with your answers" to Mechanical Engineer — task /);
    expect(s3).toContain("Finished since the owner's previous message");
    const r = await runTool(c.id, 'get_task_result', { project: h.key, task: newTask });
    expect(r.result).toContain(UPDATED);
    expect(['FINAL', 'UNREVIEWED DRAFT']).toContain(r.label);
    // The OLD task now reads SUPERSEDED — no further update is offered for it.
    expect((await runTool(c.id, 'propose_update_task', { project: h.key, task: oldTask })).note).toMatch(/already updated: task/);
  });
});
