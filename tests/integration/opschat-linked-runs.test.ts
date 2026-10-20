import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { appSql, rlsAvailable } from '@tests/support/db';
import { type TenantContext } from '@/types/domain';
import { type DbTx, getSetupDb } from '@/db/client';
import { withUser } from '@/db/tenant';
import { agents, approvals, memberships, organizations, profiles, projectMembers, projects, runJobs, runs, tasks } from '@/db/schema';
import {
  addProposal,
  appendAssistantMessage,
  appendOwnerMessage,
  createConversation,
  listRunStartingCards,
  loadPromptTurns,
  transitionProposal,
} from '@/domain/opschat/conversations';
import { loadLinkedRunFacts, loadLinkedRunViews } from '@/domain/opschat/linked-runs';
import { tenantForUser } from '@/domain/auth/guard';

/**
 * P5a — a confirmed dispatch / re-run card shows what the run it started actually did, read from the P4 links
 * (run_jobs / runs .ops_chat_proposal_id) under the card's own project tenant. Real rows; no chat text involved.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

const available = await rlsAvailable('opschat-linked-runs.test');
const db = getSetupDb();
let app: postgres.Sql;
let owner: TenantContext;
let projectKey = '';
let foreign: TenantContext; // another org entirely
let agentId = '';

const ids = { conv: '', ownerMsg2: '', dispatch: '', rerun: '', queued: '', drained: '', legacy: '', pendingCard: '', task: '', run1: '', run2: '' };

async function confirmedCard(conversationId: string, messageId: string, kind: 'dispatch_task' | 'rerun_task', extra: Record<string, unknown>, confirm = true) {
  return withUser({ userId: owner.userId }, async (tx) => {
    const p = await addProposal(tx, owner.userId, { conversationId, messageId, kind, proposal: { kind, projectKey, ...extra } });
    if (confirm) {
      await transitionProposal(tx, owner.userId, { proposalId: p.id, from: 'pending', to: 'confirming' });
      await transitionProposal(tx, owner.userId, { proposalId: p.id, from: 'confirming', to: 'done', result: { taskId: ids.task } });
    }
    return p.id;
  });
}

beforeAll(async () => {
  if (!available) return;
  app = appSql();
  const u = randomUUID();
  const f = randomUUID();
  await db.insert(profiles).values([
    { id: u, email: `lr-${u.slice(0, 8)}@t.local`, displayName: 'Owner' },
    { id: f, email: `lrf-${f.slice(0, 8)}@t.local`, displayName: 'Foreign' },
  ]);
  const orgId = (await db.insert(organizations).values({ name: 'O', slug: `lr-${u.slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  const forg = (await db.insert(organizations).values({ name: 'F', slug: `lrf-${f.slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values([{ orgId, userId: u, role: 'owner' }, { orgId: forg, userId: f, role: 'owner' }]);
  projectKey = fixtureKey('lr');
  const pid = (await db.insert(projects).values({ orgId, key: projectKey, name: 'Empera A/C' }).returning({ id: projects.id }))[0]!.id;
  const fpid = (await db.insert(projects).values({ orgId: forg, key: fixtureKey('lrf'), name: 'Other' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values([{ orgId, projectId: pid, userId: u, role: 'admin' }, { orgId: forg, projectId: fpid, userId: f, role: 'admin' }]);
  owner = { userId: u, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' } as TenantContext;
  foreign = { userId: f, orgId: forg, projectId: fpid, orgRole: 'owner', projectRole: 'admin' } as TenantContext;
  agentId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Research Analyst', role: 'primary', provider: 'openai', model: 'm', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 1000 })
      .returning({ id: agents.id })
  )[0]!.id;

  // One conversation: owner asks → reply with cards → owner asks again (the "since" boundary is message time).
  const msgs = await withUser({ userId: u }, async (tx) => {
    const conv = await createConversation(tx, u);
    const o1 = await appendOwnerMessage(tx, u, { conversationId: conv.id, content: 'size the ducts' });
    const a1 = await appendAssistantMessage(tx, u, { conversationId: conv.id, replyToMessageId: o1.id, content: 'cards below' });
    return { conv: conv.id, a1: a1.id };
  });
  ids.conv = msgs.conv;
  ids.task = (
    await db
      .insert(tasks)
      .values({ orgId, projectId: pid, title: 'Duct CFM calc', input: 'Size ducts.', providerSelection: 'openai', reviewEnabled: false, status: 'completed', createdBy: u, assignedPrimaryAgentId: agentId })
      .returning({ id: tasks.id })
  )[0]!.id;
  ids.dispatch = await confirmedCard(msgs.conv, msgs.a1, 'dispatch_task', { title: 'Duct CFM calc', instructions: 'x', agentId });
  ids.rerun = await confirmedCard(msgs.conv, msgs.a1, 'rerun_task', { taskId: ids.task, taskTitle: 'Duct CFM calc' });
  ids.queued = await confirmedCard(msgs.conv, msgs.a1, 'rerun_task', { taskId: ids.task, taskTitle: 'Queued one' });
  ids.drained = await confirmedCard(msgs.conv, msgs.a1, 'rerun_task', { taskId: ids.task, taskTitle: 'Drained one' });
  ids.legacy = await confirmedCard(msgs.conv, msgs.a1, 'rerun_task', { taskId: ids.task, taskTitle: 'Pre-0087 card' });
  ids.pendingCard = await confirmedCard(msgs.conv, msgs.a1, 'dispatch_task', { title: 'Never confirmed', instructions: 'x', agentId }, false);

  const t0 = new Date(Date.now() - 60 * 60_000);
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);
  await db.insert(runJobs).values([
    { orgId, projectId: pid, taskId: ids.task, status: 'done', opsChatProposalId: ids.dispatch, createdAt: at(0), updatedAt: at(2) },
    { orgId, projectId: pid, taskId: ids.task, status: 'done', opsChatProposalId: ids.rerun, createdAt: at(10), updatedAt: at(12) },
    { orgId, projectId: pid, taskId: ids.task, status: 'queued', opsChatProposalId: ids.queued, createdAt: at(20), updatedAt: at(20) },
    { orgId, projectId: pid, taskId: ids.task, status: 'done', opsChatProposalId: ids.drained, createdAt: at(21), updatedAt: at(21) },
  ]);
  ids.run1 = (
    await db
      .insert(runs)
      .values({ classification: 'live', orgId, projectId: pid, taskId: ids.task, status: 'completed', primaryAgentId: agentId, consolidatedResult: 'CFM ≈ 3,160', reviewOutcome: 'required_unmet', startedAt: at(1), finishedAt: at(2), opsChatProposalId: ids.dispatch })
      .returning({ id: runs.id })
  )[0]!.id;
  ids.run2 = (
    await db
      .insert(runs)
      .values({ classification: 'live', orgId, projectId: pid, taskId: ids.task, status: 'failed', primaryAgentId: agentId, errorMessage: 'provider timeout', startedAt: at(11), finishedAt: new Date(Date.now() + 60_000), opsChatProposalId: ids.rerun })
      .returning({ id: runs.id })
  )[0]!.id;
  await db.insert(approvals).values({
    orgId,
    projectId: pid,
    taskId: ids.task,
    runId: ids.run1,
    actionType: 'external_http',
    status: 'pending',
    payload: { kind: 'x' },
    payloadSha256: 'c'.repeat(64),
    summary: 'Send the duct sizing to the customer',
    requestedBy: 'openai',
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  // The owner's NEXT message lands between run1 (finished) and run2 (finishes "now + 1 min").
  ids.ownerMsg2 = await withUser({ userId: u }, async (tx) => (await appendOwnerMessage(tx, u, { conversationId: msgs.conv, content: 'where will i get answers' })).id);
});

afterAll(async () => {
  await app?.end();
});

const resolver = (userId: string) => (key: string) => tenantForUser(userId, key);

describe.skipIf(!available)('P5a — linked run outcomes from the P4 links', () => {
  it('listRunStartingCards returns only CONFIRMED dispatch / re-run cards of this owner and conversation', async () => {
    const cards = await withUser({ userId: owner.userId }, (tx) => listRunStartingCards(tx, owner.userId, ids.conv));
    expect(new Set(cards.map((c) => c.id))).toEqual(new Set([ids.dispatch, ids.rerun, ids.queued, ids.drained, ids.legacy]));
    const strangers = await withUser({ userId: foreign.userId }, (tx) => listRunStartingCards(tx, foreign.userId, ids.conv));
    expect(strangers).toEqual([]);
  });

  it('each card gets ITS OWN attempt: dispatch → draft run needing approval; re-run → failed; queued; drained; legacy → none', async () => {
    const cards = await withUser({ userId: owner.userId }, (tx) => listRunStartingCards(tx, owner.userId, ids.conv));
    const views = await loadLinkedRunViews(cards, resolver(owner.userId));

    expect(views.get(ids.dispatch)).toMatchObject({ runId: ids.run1, taskId: ids.task, state: 'needs_approval' });
    expect(views.get(ids.dispatch)!.text).toMatch(/UNREVIEWED DRAFT.*It proposed an approval that is waiting on the owner\./);
    expect(views.get(ids.rerun)).toMatchObject({ runId: ids.run2, state: 'failed', text: expect.stringMatching(/^The run failed .*: provider timeout\. No result was produced\.$/) });
    expect(views.get(ids.queued)).toMatchObject({ runId: null, state: 'queued' });
    expect(views.get(ids.drained)).toMatchObject({ runId: null, state: 'no_run', text: expect.stringMatching(/without a run on record/) });
    expect(views.has(ids.legacy)).toBe(false); // pre-0087: no link → no line (existing wording stays)
    expect(views.has(ids.pendingCard)).toBe(false); // never confirmed
  });

  it('a project the viewer cannot access yields nothing (auth gate before any tenant read)', async () => {
    const cards = await withUser({ userId: owner.userId }, (tx) => listRunStartingCards(tx, owner.userId, ids.conv));
    expect((await loadLinkedRunViews(cards, resolver(foreign.userId))).size).toBe(0);
    expect(await tenantForUser(foreign.userId, projectKey)).toBeNull();
    expect(await tenantForUser(owner.userId, projectKey)).toMatchObject({ userId: owner.userId, orgId: owner.orgId, projectId: owner.projectId });
  });

  it('RLS: under app_server, another org`s tenant sees none of the linked rows; the owning tenant sees them', async () => {
    const d = drizzle(app);
    const read = (ctx: TenantContext) =>
      d.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${ctx.userId}, true), set_config('app.org_id', ${ctx.orgId}, true), set_config('app.project_id', ${ctx.projectId}, true)`);
        return loadLinkedRunFacts(tx as unknown as DbTx, [ids.dispatch, ids.rerun]);
      });
    expect((await read(foreign)).size).toBe(0);
    const mine = await read(owner);
    expect(mine.get(ids.dispatch)?.run?.id).toBe(ids.run1);
    expect(mine.get(ids.rerun)?.run?.id).toBe(ids.run2);
  });

  it('prompt history: the earlier reply`s card lines carry each card`s linked run, read from the run rows', async () => {
    const cards = await withUser({ userId: owner.userId }, (tx) => listRunStartingCards(tx, owner.userId, ids.conv));
    const linkedRuns = await loadLinkedRunViews(cards, resolver(owner.userId));
    const turns = await withUser({ userId: owner.userId }, (tx) => loadPromptTurns(tx, owner.userId, ids.conv, ids.ownerMsg2, { linkedRuns }));
    const reply = turns.find((t) => t.role === 'assistant')!.content;
    expect(reply).toContain(`[card dispatch_task ${ids.dispatch.slice(0, 8)}] dispatch "Duct CFM calc" — CONFIRMED by the owner and executed`);
    expect(reply).toContain(`linked run ${ids.run1.slice(0, 8)} (task ${ids.task.slice(0, 8)}): Finished`);
    expect(reply).toMatch(new RegExp(`\\[card rerun_task ${ids.rerun.slice(0, 8)}\\][^\\n]*linked run ${ids.run2.slice(0, 8)}[^\\n]*The run failed`));
    expect(reply).toMatch(new RegExp(`\\[card rerun_task ${ids.legacy.slice(0, 8)}\\][^\\n]*no execution record`)); // no link → unchanged wording
    expect(turns.at(-1)).toMatchObject({ role: 'user', content: 'where will i get answers' });

    // Without the lookup, the prompt is exactly as before P5a (no run lines).
    const plain = await withUser({ userId: owner.userId }, (tx) => loadPromptTurns(tx, owner.userId, ids.conv, ids.ownerMsg2));
    expect(plain.find((t) => t.role === 'assistant')!.content).not.toMatch(/linked run/);
  });
});
