import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { rlsAvailable } from '@tests/support/db';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant, withUser } from '@/db/tenant';
import { type ProjectAccessRecord } from '@/db/system';
import { agents, approvals, memberships, organizations, ownerQuestions, profiles, projectMembers, projects, runs, spendLimits, tasks } from '@/db/schema';
import { addProposal, appendAssistantMessage, appendOwnerMessage, createConversation, transitionProposal } from '@/domain/opschat/conversations';
import { createOpsChatToolset } from '@/domain/opschat/tools';
import { loadTaskStates } from '@/domain/opschat/task-state';
import { createTask } from '@/domain/tasks/tasks';

/**
 * P5c-2 — the server-cooling shape against real rows: a run asked the owner four blocking questions; the owner
 * answered them (and rejected an unrelated approval) AFTER the run started. The Hub must call the old result stale,
 * offer exactly ONE update card that writes those answers into the new run, refuse duplicates (same turn, later
 * turns), and — once the update card is confirmed and its task exists — stop calling the old task stale.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

const available = await rlsAvailable('opschat-update-card.test');
const db = getSetupDb();
let owner: TenantContext;
let rec: ProjectAccessRecord;
let agentId = '';
let taskId = '';
let runId = '';
let conv = { id: '', assistantMsg: '' };
const RUN_START = new Date(Date.now() - 6 * 60 * 60_000);
const after = (min: number) => new Date(RUN_START.getTime() + min * 60_000);
const ANSWERS = ['Supply air 55°F at the cabinet inlet.', 'Cabinet is fully sealed with a rear door.', 'Two FUSION-TEC units, 3.5 kW each.', 'Max ambient in the room is 85°F.'];

const toolset = () =>
  createOpsChatToolset({ userId: owner.userId, projects: [rec], orgRoles: new Map([[owner.orgId, 'owner' as const]]), conversationId: conv.id });
const run = async (ts: ReturnType<typeof toolset>, name: string, input: Record<string, unknown>) => JSON.parse(await ts.runTool({ name, input }));

beforeAll(async () => {
  if (!available) return;
  const u = randomUUID();
  await db.insert(profiles).values({ id: u, email: `uc-${u.slice(0, 8)}@t.local`, displayName: 'King' });
  const orgId = (await db.insert(organizations).values({ name: 'Empera', slug: `uc-${u.slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId: u, role: 'owner' });
  const key = fixtureKey('uc');
  const pid = (await db.insert(projects).values({ orgId, key, name: 'Empera A/C' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: u, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  owner = { userId: u, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' } as TenantContext;
  rec = { orgId, projectId: pid, key, name: 'Empera A/C', description: '', projectRole: 'admin' } as unknown as ProjectAccessRecord;
  agentId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Mechanical Engineer', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 1000 })
      .returning({ id: agents.id })
  )[0]!.id;
  // A second primary agent — the update card must still pick the task's OWN agent, not ask or guess.
  await db.insert(agents).values({ orgId, projectId: pid, name: 'Research Analyst', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 1000 });
  taskId = (
    await db
      .insert(tasks)
      .values({ orgId, projectId: pid, title: 'Server Cabinet Cooling — duct sizing', input: 'Size the supply and return ducts for the server cabinet.', providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: u, assignedPrimaryAgentId: agentId })
      .returning({ id: tasks.id })
  )[0]!.id;
  runId = (
    await db
      .insert(runs)
      .values({ classification: 'live', orgId, projectId: pid, taskId, status: 'completed', primaryAgentId: agentId, consolidatedResult: 'Preliminary sizing — blocked on 4 questions.', reviewOutcome: 'required_unmet', startedAt: RUN_START, finishedAt: after(1) })
      .returning({ id: runs.id })
  )[0]!.id;
  // Answered BEFORE the run started → already known to it → not a stale reason.
  await db.insert(ownerQuestions).values({ orgId, projectId: pid, taskId, agentId, question: 'Which building?', status: 'answered', answer: 'OLD-ANSWER-KNOWN-TO-RUN', answeredBy: u, answeredAt: new Date(RUN_START.getTime() - 60_000) });
  // The run's four blockers, answered by the owner afterwards.
  await db.insert(ownerQuestions).values(
    ANSWERS.map((answer, i) => ({ orgId, projectId: pid, taskId, runId, agentId, question: `Blocker ${i + 1}: what is the value?`, status: 'answered', answer, answeredBy: u, answeredAt: after(60 + i) })),
  );
  // An unrelated approval the run proposed — REJECTED (counts); and one APPROVED (does not).
  const appr = (status: 'rejected' | 'approved', summary: string, note: string | null, min: number) => ({
    orgId, projectId: pid, taskId, runId, actionType: 'external_http' as const, status, payload: { kind: 'x' }, payloadSha256: randomUUID().replace(/-/g, '').padEnd(64, '0'),
    summary, requestedBy: 'openai' as const, decidedBy: u, decidedAt: after(min), decisionNote: note, expiresAt: new Date(Date.now() + 86_400_000),
  });
  await db.insert(approvals).values([appr('rejected', 'Reply to ONEAL regarding billing', 'Unrelated to this job.', 70), appr('approved', 'Post the drawing to the shared folder', null, 71)]);
  conv = await withUser({ userId: u }, async (tx) => {
    const c = await createConversation(tx, u);
    const o = await appendOwnerMessage(tx, u, { conversationId: c.id, content: 'any response on the server cooling?' });
    const a = await appendAssistantMessage(tx, u, { conversationId: c.id, replyToMessageId: o.id, content: '…' });
    return { id: c.id, assistantMsg: a.id };
  });
});

describe.skipIf(!available)('P5c-2 — stale work → ONE update card (server-cooling shape)', () => {
  it('the old result is STALE: 4 answered blockers + 1 rejection after the run started (the pre-run answer and the approval do not count)', async () => {
    const [s] = await withTenant(owner, (tx) => loadTaskStates(tx, owner, [taskId]));
    expect(s!.stale).toMatchObject({ runId });
    expect(s!.stale!.decisions.map((d) => d.kind)).toEqual(['question_answered', 'question_answered', 'question_answered', 'question_answered', 'approval_rejected']);
    expect(s!.ownerFacing).toContain('PREDATES 5 owner decisions made since (4 answered questions and 1 rejected approval)');
    const r = await run(toolset(), 'get_task_result', { project: rec.key, task: taskId });
    expect(r.stale?.runId).toBe(runId);
    expect(r.staleNote).toMatch(/propose_update_task/);
  });

  it('propose_update_task → exactly ONE dispatch card: original + every later decision written in, same agent; a re-run of the same task is folded in', async () => {
    const ts = toolset();
    expect((await run(ts, 'propose_rerun_task', { project: rec.key, task: taskId })).prepared).toBe(true);
    const out = await run(ts, 'propose_update_task', { project: rec.key, task: taskId });
    expect(out).toMatchObject({ prepared: true, decisions: 5, agent: 'Mechanical Engineer' });
    const cards = ts.getProposals();
    expect(cards).toHaveLength(1); // the earlier re-run was folded into the update card
    const c = cards[0] as Record<string, unknown> & { instructions: string };
    expect(c).toMatchObject({ kind: 'dispatch_task', title: 'Server Cabinet Cooling — duct sizing — updated with your answers', agentId, updateOf: { taskId, runId, decisions: 5 } });
    expect(c.instructions).toContain('Size the supply and return ducts for the server cabinet.');
    for (const a of ANSWERS) expect(c.instructions).toContain(a);
    expect(c.instructions).toContain("Owner's note: Unrelated to this job.");
    expect(c.instructions).not.toContain('OLD-ANSWER-KNOWN-TO-RUN');
    expect(c.instructions).not.toContain('Post the drawing');
    // Same turn: asking again adds nothing; a plain re-run is refused.
    await run(ts, 'propose_update_task', { project: rec.key, task: taskId });
    expect(ts.getProposals()).toHaveLength(1);
    expect((await run(ts, 'propose_rerun_task', { project: rec.key, task: taskId })).prepared).toBe(false);
  });

  it('a LATER turn while that card is still pending: refused with the waiting card id (never a second card)', async () => {
    const ts = toolset();
    await run(ts, 'propose_update_task', { project: rec.key, task: taskId });
    const card = ts.getProposals()[0]!;
    const stored = await withUser({ userId: owner.userId }, (tx) =>
      addProposal(tx, owner.userId, { conversationId: conv.id, messageId: conv.assistantMsg, kind: 'dispatch_task', proposal: card as unknown as Record<string, unknown> }),
    );
    const again = await run(toolset(), 'propose_update_task', { project: rec.key, task: taskId });
    expect(again).toMatchObject({ prepared: false, alreadyOffered: stored.id });

    // Owner confirms → the confirm path creates the new task with the card's fields and P4 provenance.
    await withUser({ userId: owner.userId }, async (tx) => {
      await transitionProposal(tx, owner.userId, { proposalId: stored.id, from: 'pending', to: 'confirming' });
    });
    const c = card as unknown as { title: string; instructions: string; agentId: string };
    const newTaskId = await withTenant(owner, (tx) =>
      createTask(tx, owner, {
        title: c.title,
        input: c.instructions,
        providerSelection: 'openai',
        reviewEnabled: false,
        modelTier: 'standard',
        flagshipCategory: null,
        objectiveId: null,
        scheduleId: null,
        primaryAgentId: c.agentId,
        reviewerAgentId: null,
        opsChatProposalId: stored.id,
      }),
    );
    await withUser({ userId: owner.userId }, (tx) => transitionProposal(tx, owner.userId, { proposalId: stored.id, from: 'confirming', to: 'done', result: { taskId: newTaskId } }));

    // The old task is now SUPERSEDED (not stale) and points at the update task; no further update is offered.
    const [old] = await withTenant(owner, (tx) => loadTaskStates(tx, owner, [taskId]));
    expect(old!.stale).toBeNull();
    expect(old!.supersededBy).toMatchObject({ taskId: newTaskId, title: c.title });
    expect(old!.ownerFacing).toContain(`SUPERSEDED by update task "${c.title}" (${newTaskId}`);
    const after = await run(toolset(), 'propose_update_task', { project: rec.key, task: taskId });
    expect(after.prepared).toBe(false);
    expect(after.note).toMatch(/already updated: task/);
    // And the new task carries every answer.
    const nt = (await withTenant(owner, (tx) => tx.select({ input: tasks.input }).from(tasks).where(eq(tasks.id, newTaskId))))[0]!;
    for (const a of ANSWERS) expect(nt.input).toContain(a);
  });

  it('nothing changed since the latest run → no card; a non-admin cannot propose one', async () => {
    const fresh = (
      await db
        .insert(tasks)
        .values({ orgId: owner.orgId, projectId: owner.projectId, title: 'Untouched estimate', input: 'x', providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: owner.userId, assignedPrimaryAgentId: agentId })
        .returning({ id: tasks.id })
    )[0]!.id;
    await db.insert(runs).values({ classification: 'live', orgId: owner.orgId, projectId: owner.projectId, taskId: fresh, status: 'completed', primaryAgentId: agentId, consolidatedResult: 'ok', startedAt: new Date(), finishedAt: new Date() });
    const ts = toolset();
    const out = await run(ts, 'propose_update_task', { project: rec.key, task: fresh });
    expect(out.prepared).toBe(false);
    expect(out.note).toMatch(/Nothing changed since the latest run/);
    expect(ts.getProposals()).toHaveLength(0);
    const member = createOpsChatToolset({ userId: owner.userId, projects: [{ ...rec, projectRole: 'member' } as ProjectAccessRecord], orgRoles: new Map([[owner.orgId, 'member' as const]]) });
    expect((await run(member, 'propose_update_task', { project: rec.key, task: taskId })).error).toMatch(/admin/);
  });

  describe('bounded: a card never stands for a decision it does not carry (review of #175)', () => {
    async function taskWithDecisions(n: number): Promise<string> {
      const start = new Date(Date.now() - 2 * 60 * 60_000);
      const id = (
        await db
          .insert(tasks)
          .values({ orgId: owner.orgId, projectId: owner.projectId, title: `Many decisions ${n}`, input: 'Original job.', providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: owner.userId, assignedPrimaryAgentId: agentId })
          .returning({ id: tasks.id })
      )[0]!.id;
      const r = (
        await db
          .insert(runs)
          .values({ classification: 'live', orgId: owner.orgId, projectId: owner.projectId, taskId: id, status: 'completed', primaryAgentId: agentId, consolidatedResult: 'x', startedAt: start, finishedAt: new Date(start.getTime() + 60_000) })
          .returning({ id: runs.id })
      )[0]!.id;
      await db.insert(ownerQuestions).values(
        Array.from({ length: n }, (_, i) => ({
          orgId: owner.orgId,
          projectId: owner.projectId,
          taskId: id,
          runId: r,
          agentId,
          question: `Decision question ${i}?`,
          status: 'answered',
          answer: `DECISION-${n}-${i}-CONTENT`,
          answeredBy: owner.userId,
          answeredAt: new Date(start.getTime() + (i + 2) * 60_000),
        })),
      );
      return id;
    }

    it('1. exactly 10 decisions → a card prepared, every one of the 10 contents present, decisionIds = those 10', async () => {
      const id = await taskWithDecisions(10);
      const ts = toolset();
      const out = await run(ts, 'propose_update_task', { project: rec.key, task: id });
      expect(out).toMatchObject({ prepared: true, decisions: 10 });
      expect(out.note).toContain('with ALL 10 owner decision(s) made since the last run written in full');
      const card = ts.getProposals()[0] as unknown as { instructions: string; updateOf: { decisionIds: string[]; decisions: number } };
      for (let i = 0; i < 10; i++) expect(card.instructions).toContain(`DECISION-10-${i}-CONTENT`);
      expect(card.updateOf.decisions).toBe(10);
      expect(card.updateOf.decisionIds).toHaveLength(10);
      expect(card.instructions).not.toMatch(/more decisions recorded|\[…\]|truncated/);
    });

    it('2+3+4. 11 decisions → NO card, no updateOf / decisionIds anywhere, and never an "all written" claim', async () => {
      const id = await taskWithDecisions(11);
      const ts = toolset();
      // A re-run proposed earlier this turn is NOT folded away by a refused update (nothing replaced it).
      await run(ts, 'propose_rerun_task', { project: rec.key, task: id });
      const raw = await ts.runTool({ name: 'propose_update_task', input: { project: rec.key, task: id } });
      const out = JSON.parse(raw);
      expect(out).toMatchObject({
        prepared: false,
        decisions: 11,
        reason: 'too_many_decisions',
        note: 'This job has too many post-run owner decisions to fit safely into one update card without dropping content. Nothing was prepared. Narrow the update scope or create a fresh consolidated task.',
      });
      expect(raw).not.toMatch(/updateOf|decisionIds|written in full|ALL 11/);
      const cards = ts.getProposals();
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ kind: 'rerun_task', taskId: id });
      expect(cards.some((c) => 'updateOf' in (c as object))).toBe(false);
      // …and the refused task was not marked "updated this turn": a re-run stays possible.
      expect((await run(ts, 'propose_rerun_task', { project: rec.key, task: id })).prepared).toBe(true);
    });
  });
});
