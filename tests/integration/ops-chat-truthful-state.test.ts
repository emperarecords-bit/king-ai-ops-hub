import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant, withUser } from '@/db/tenant';
import { agents, approvals, memberships, organizations, profiles, projectMembers, projects, runs, tasks } from '@/db/schema';
import { addProposal, appendAssistantMessage, appendOwnerMessage, createConversation, loadPromptTurns, transitionProposal } from '@/domain/opschat/conversations';
import { loadTaskStates } from '@/domain/opschat/task-state';

/**
 * Regressions from the server-cooling conversation (Hub prod 2026-10-19), against REAL rows:
 *
 *  16:10 — Ops Chat said the duct task "is sitting in 'awaiting approval' — it hasn't been confirmed/run yet, so
 *          no calculations exist". Stored truth: its run completed 14:50:11 with a result; the task awaited an
 *          (unrelated) approval its run had proposed. loadTaskStates must say it ALREADY RAN.
 *  22:36 — Ops Chat asked the owner to "confirm those two cards" — both had been CONFIRMED at 17:19. The next
 *          turn's prompt history must carry each earlier card's CURRENT stored state.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[ops-chat-truthful-state.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let ctx: TenantContext;

beforeAll(async () => {
  if (!available) return;
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `ts-${randomUUID().slice(0, 8)}@t.local`, displayName: 'Owner' });
  const orgId = (await db.insert(organizations).values({ name: 'O', slug: `ts-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('ts'), name: 'Empera A/C' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' } as TenantContext;
});

afterAll(async () => {
  /* fixture rows are namespaced by fresh org/user ids */
});

describe.skipIf(!available)('Ops Chat reports stored state, never stale chat text', () => {
  it('16:10 — a task awaiting an approval its run proposed is reported as ALREADY RUN with a ready result', async () => {
    const agentId = (
      await db
        .insert(agents)
        .values({ orgId: ctx.orgId, projectId: ctx.projectId, name: 'Marketing Lead', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 1000 })
        .returning({ id: agents.id })
    )[0]!.id;
    const taskId = (
      await db
        .insert(tasks)
        .values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 'Duct CFM calc + duct size options', input: 'Size ducts.', providerSelection: 'openai', reviewEnabled: false, status: 'awaiting_approval', createdBy: ctx.userId, assignedPrimaryAgentId: agentId })
        .returning({ id: tasks.id })
    )[0]!.id;
    const finished = new Date('2026-10-19T14:50:11Z');
    const runId = (
      await db
        .insert(runs)
        .values({ classification: 'live', orgId: ctx.orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: agentId, consolidatedResult: 'CFM ≈ 3,160 at ΔT 20°F; duct 36×18 …', startedAt: new Date('2026-10-19T14:50:03Z'), finishedAt: finished, reviewOutcome: 'required_unmet' })
        .returning({ id: runs.id })
    )[0]!.id;
    const apprId = (
      await db
        .insert(approvals)
        .values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId, runId, actionType: 'external_http', status: 'pending', payload: { kind: 'accuratebids_reply', request_id: 'e4c08c7c' }, payloadSha256: 'c'.repeat(64), summary: 'Reply to ONEAL regarding billing/subscription access', requestedBy: 'openai', expiresAt: new Date(Date.now() + 86_400_000) })
        .returning({ id: approvals.id })
    )[0]!.id;

    const [state] = await withTenant(ctx, (tx) => loadTaskStates(tx, ctx, [taskId]));
    expect(state!.status).toBe('awaiting_approval');
    expect(state!.ownerFacing).toMatch(/already RAN \(finished 2026-10-19 14:50 UTC\) and its result is ready to read/i);
    expect(state!.ownerFacing).toContain(apprId);
    expect(state!.ownerFacing).toMatch(/NOT an unconfirmed card/);
    expect(state!.ownerFacing).not.toMatch(/hasn't (been )?(confirmed|run)/i);
    expect(state!.latestRun).toMatchObject({ id: runId, hasResult: true });
  });

  it('22:36 — the next prompt carries each earlier card’s CURRENT state (both CONFIRMED), so the model never asks to confirm them again', async () => {
    const uid = ctx.userId;
    const ids = await withUser({ userId: uid }, async (tx) => {
      const conv = await createConversation(tx, uid);
      const o1 = await appendOwnerMessage(tx, uid, { conversationId: conv.id, content: 'Yes, reject and rerun' });
      const a1 = await appendAssistantMessage(tx, uid, {
        conversationId: conv.id,
        replyToMessageId: o1.id,
        content: 'Here are the two cards — confirm them below and nothing runs until you do.',
      });
      const reject = await addProposal(tx, uid, { conversationId: conv.id, messageId: a1.id, kind: 'decide_approval', proposal: { kind: 'decide_approval', approvalId: 'edb61199-1141-4f32-8aff-8b6237053597', decision: 'rejected' } });
      const rerun = await addProposal(tx, uid, { conversationId: conv.id, messageId: a1.id, kind: 'rerun_task', proposal: { kind: 'rerun_task', taskId: '0a72c3bc-50cb-46f6-b0d6-5ce077f3e48e', taskTitle: 'Duct CFM calc' } });
      for (const p of [reject, rerun]) {
        await transitionProposal(tx, uid, { proposalId: p.id, from: 'pending', to: 'confirming' });
        await transitionProposal(tx, uid, { proposalId: p.id, from: 'confirming', to: 'done', result: p === rerun ? { outcome: 'started', taskId: '0a72c3bc-50cb-46f6-b0d6-5ce077f3e48e', jobId: 'job-2' } : null });
      }
      const o2 = await appendOwnerMessage(tx, uid, { conversationId: conv.id, content: 'where will i get answers' });
      return { conv: conv.id, o2: o2.id };
    });

    const turns = await withUser({ userId: uid }, (tx) => loadPromptTurns(tx, uid, ids.conv, ids.o2));
    const earlierReply = turns.find((t) => t.role === 'assistant')!.content;
    expect(earlierReply).toContain('SERVER RECORD — current state of the cards in this reply');
    expect(earlierReply).toMatch(/\[card decide_approval\] rejected approval edb61199-1141-4f32-8aff-8b6237053597 — CONFIRMED by the owner and executed/);
    expect(earlierReply).toMatch(/\[card rerun_task\] re-run "Duct CFM calc" — CONFIRMED by the owner and executed .* \(taskId 0a72c3bc-50cb-46f6-b0d6-5ce077f3e48e, jobId job-2, outcome started\)/);
    // The current owner turn stays last and unannotated.
    expect(turns.at(-1)).toMatchObject({ role: 'user', content: 'where will i get answers' });
  });
});
