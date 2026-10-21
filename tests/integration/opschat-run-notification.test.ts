import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { rlsAvailable } from '@tests/support/db';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant, withUser } from '@/db/tenant';
import {
  agents,
  memberships,
  notificationEvents,
  notificationMessageEvents,
  notificationMessages,
  organizations,
  profiles,
  projectMembers,
  projects,
  runs,
  spendLimits,
} from '@/db/schema';
import { setProviderOverrideForTests } from '@/providers/registry';
import { createTask } from '@/domain/tasks/tasks';
import { claimJobForTask, enqueueRun, runClaimedJob } from '@/domain/jobs/jobs';
import { addProposal, appendAssistantMessage, appendOwnerMessage, createConversation } from '@/domain/opschat/conversations';
import { routeDueNotifications } from '@/domain/notifications/router';
import { getOrDefaultPreferences, updatePreferences } from '@/domain/notifications/preferences';

/**
 * P5b-1 — a run started from an Ops Chat card emails its outcome (status sentence + link, never the result) through
 * the existing, fail-closed notification pipeline. Real queue + worker + router; the email channel's network call
 * is a fake fetcher, so nothing leaves the machine.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');
process.env.RATE_LIMIT_RUNS_PER_MINUTE = '1000';
const PRIOR_APP_URL = process.env.APP_URL;
process.env.APP_URL = 'https://hub.test.local';

const available = await rlsAvailable('opschat-run-notification.test');
const db = getSetupDb();
let owner: TenantContext; // org owner = the notification recipient
let member: TenantContext; // another member of the SAME workspace
let projectKey = '';
let primaryId = '';
const SECRET = 'SECRET-RESULT-TEXT CFM 3160';
const LIVE_ENV = { NOTIFICATIONS_ENABLED: 'email', EMAIL_API_KEY: 'k', EMAIL_FROM: 'bot@test.local' };

function okFetcher() {
  const calls: Array<{ body: string }> = [];
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push({ body: String(init?.body ?? '') });
    return new Response(JSON.stringify({ id: 'msg_' + calls.length }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

async function card(ctx: TenantContext, kind: 'dispatch_task' | 'rerun_task') {
  return withUser({ userId: ctx.userId }, async (tx) => {
    const conv = await createConversation(tx, ctx.userId);
    const o = await appendOwnerMessage(tx, ctx.userId, { conversationId: conv.id, content: 'go' });
    const a = await appendAssistantMessage(tx, ctx.userId, { conversationId: conv.id, replyToMessageId: o.id, content: 'card below' });
    const p = await addProposal(tx, ctx.userId, { conversationId: conv.id, messageId: a.id, kind, proposal: { kind, projectKey, title: 'Duct CFM calc' } });
    return { proposalId: p.id, conversationId: conv.id };
  });
}

/** Dispatch → run through the real worker. `cardId` null = a run NOT started from Ops Chat. */
async function runTask(ctx: TenantContext, cardId: string | null, behave: (p: FakeProvider) => void): Promise<{ taskId: string; runId: string }> {
  const taskId = await withTenant(ctx, (tx) =>
    createTask(tx, ctx, {
      title: 'Duct CFM calc',
      input: 'Size the ducts.',
      providerSelection: 'openai',
      reviewEnabled: false,
      modelTier: 'standard',
      flagshipCategory: null,
      objectiveId: null,
      scheduleId: null,
      primaryAgentId: primaryId,
      reviewerAgentId: null,
      opsChatProposalId: cardId,
    }),
  );
  await withTenant(ctx, (tx) => enqueueRun(tx, ctx, taskId, 'interactive', { opsChatProposalId: cardId }));
  const openai = new FakeProvider('openai');
  behave(openai);
  setProviderOverrideForTests((id) => (id === 'openai' ? openai : undefined));
  await runClaimedJob((await claimJobForTask(ctx, taskId))!);
  const run = (await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, taskId)).orderBy(desc(runs.startedAt)).limit(1))[0]!;
  return { taskId, runId: run.id };
}

const eventFor = async (eventType: string, runId: string) =>
  (await db.select().from(notificationEvents).where(eq(notificationEvents.dedupeKey, `${eventType}:run:${runId}`)).limit(1))[0];
const messagesFor = (eventId: string) =>
  db
    .select({ status: notificationMessages.status, resultCode: notificationMessages.resultCode })
    .from(notificationMessageEvents)
    .innerJoin(notificationMessages, eq(notificationMessages.id, notificationMessageEvents.messageId))
    .where(eq(notificationMessageEvents.eventId, eventId));
const hhmm = (d: Date) => d.toISOString().slice(11, 16);

beforeAll(async () => {
  if (!available) return;
  const u1 = randomUUID();
  const u2 = randomUUID();
  await db.insert(profiles).values([
    { id: u1, email: `rn1-${u1.slice(0, 8)}@t.local`, displayName: 'Owner' },
    { id: u2, email: `rn2-${u2.slice(0, 8)}@t.local`, displayName: 'Member' },
  ]);
  const orgId = (await db.insert(organizations).values({ name: 'O', slug: `rn-${u1.slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values([{ orgId, userId: u1, role: 'owner' }, { orgId, userId: u2, role: 'member' }]);
  projectKey = fixtureKey('rn');
  const pid = (await db.insert(projects).values({ orgId, key: projectKey, name: 'Empera A/C' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values([{ orgId, projectId: pid, userId: u1, role: 'admin' }, { orgId, projectId: pid, userId: u2, role: 'member' }]);
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  primaryId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Research Analyst', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'p', temperatureMilli: 700, maxOutputTokens: 1000 })
      .returning({ id: agents.id })
  )[0]!.id;
  owner = { userId: u1, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' } as TenantContext;
  member = { userId: u2, orgId, projectId: pid, orgRole: 'member', projectRole: 'member' } as TenantContext;
});
afterEach(() => setProviderOverrideForTests(null));
afterAll(() => {
  setProviderOverrideForTests(null);
  if (PRIOR_APP_URL === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = PRIOR_APP_URL;
});

describe.skipIf(!available)('P5b-1 — Ops Chat run completion email', () => {
  it('a linked completion is captured as IMMEDIATE with the card sentence + deep link to the card, and NO result text', async () => {
    const c = await card(owner, 'dispatch_task');
    const { runId } = await runTask(owner, c.proposalId, (p) => p.reply(SECRET));
    const ev = (await eventFor('run_completed', runId))!;
    // No reviewer in this workspace → the review policy marks it required_unmet → said plainly, never "final".
    expect(ev).toMatchObject({ severity: 'success', routing: 'immediate', recipientUserId: owner.userId, title: 'Ops Chat request finished (unreviewed draft): "Duct CFM calc"' });
    expect(ev.body).toMatch(/^"Duct CFM calc" — Finished .* UTC; its result is ready to read\. It is an UNREVIEWED DRAFT/);
    expect(ev.body).toContain(`Open it in Ops Chat: https://hub.test.local/ops?c=${c.conversationId}#card-${c.proposalId}`);
    expect(ev.body).not.toContain('SECRET-RESULT-TEXT');
  });

  it('the router emails it exactly once (fake channel), with the link in the text', async () => {
    const c = await card(owner, 'dispatch_task');
    const { runId } = await runTask(owner, c.proposalId, (p) => p.reply(SECRET));
    const ev = (await eventFor('run_completed', runId))!;
    const first = okFetcher();
    await routeDueNotifications({ env: LIVE_ENV, fetcher: first.fetcher, now: () => new Date() });
    const mine = first.calls.filter((x) => x.body.includes(c.proposalId));
    expect(mine).toHaveLength(1);
    expect(JSON.parse(mine[0]!.body)).toMatchObject({ subject: 'Ops Chat request finished (unreviewed draft): "Duct CFM calc"' });
    expect(mine[0]!.body).not.toContain('SECRET-RESULT-TEXT');
    expect(await messagesFor(ev.id)).toEqual([{ status: 'sent', resultCode: 'ok' }]);
    const second = okFetcher();
    await routeDueNotifications({ env: LIVE_ENV, fetcher: second.fetcher, now: () => new Date() });
    expect(second.calls.filter((x) => x.body.includes(c.proposalId))).toHaveLength(0);
  });

  it('quiet hours DEFER it (non-critical), and it sends once the window ends', async () => {
    const now = new Date();
    await withUser({ userId: owner.userId }, (tx) =>
      updatePreferences(tx, owner.userId, { timezone: 'UTC', quietHoursStartLocal: hhmm(new Date(now.getTime() - 60 * 60_000)), quietHoursEndLocal: hhmm(new Date(now.getTime() + 60 * 60_000)) }),
    );
    try {
      const c = await card(owner, 'dispatch_task');
      const { runId } = await runTask(owner, c.proposalId, (p) => p.reply('ok'));
      const ev = (await eventFor('run_completed', runId))!;
      const quiet = okFetcher();
      await routeDueNotifications({ env: LIVE_ENV, fetcher: quiet.fetcher, now: () => now });
      expect(quiet.calls.filter((x) => x.body.includes(c.proposalId))).toHaveLength(0);
      expect(await messagesFor(ev.id)).toEqual([]); // still pending
      const later = okFetcher();
      await routeDueNotifications({ env: LIVE_ENV, fetcher: later.fetcher, now: () => new Date(now.getTime() + 2 * 60 * 60_000) });
      expect(later.calls.filter((x) => x.body.includes(c.proposalId))).toHaveLength(1);
    } finally {
      await withUser({ userId: owner.userId }, (tx) => updatePreferences(tx, owner.userId, { quietHoursStartLocal: null, quietHoursEndLocal: null }));
    }
  });

  it('the owner opt-out (Settings) records it suppressed `owner_opted_out` and sends nothing; turning it back on clears the override', async () => {
    await withUser({ userId: owner.userId }, (tx) => updatePreferences(tx, owner.userId, { opsChatRunEmails: false }));
    try {
      expect((await withUser({ userId: owner.userId }, (tx) => getOrDefaultPreferences(tx, owner.userId))).opsChatRunEmails).toBe(false);
      const c = await card(owner, 'dispatch_task');
      const { runId } = await runTask(owner, c.proposalId, (p) => p.reply('ok'));
      const ev = (await eventFor('run_completed', runId))!;
      const f = okFetcher();
      await routeDueNotifications({ env: LIVE_ENV, fetcher: f.fetcher, now: () => new Date() });
      expect(f.calls.filter((x) => x.body.includes(c.proposalId))).toHaveLength(0);
      expect(await messagesFor(ev.id)).toEqual([{ status: 'suppressed', resultCode: 'owner_opted_out' }]);
      // A critical failure is never subject to this opt-out (only the completion email is).
    } finally {
      await withUser({ userId: owner.userId }, (tx) => updatePreferences(tx, owner.userId, { opsChatRunEmails: true }));
    }
    const prefs = await withUser({ userId: owner.userId }, (tx) => getOrDefaultPreferences(tx, owner.userId));
    expect(prefs.opsChatRunEmails).toBe(true);
  });

  it('a card confirmed by ANOTHER member: the recipient (org owner) gets the task link — never the owner-private conversation', async () => {
    const c = await card(member, 'dispatch_task');
    const { runId, taskId } = await runTask(member, c.proposalId, (p) => p.reply('ok'));
    const ev = (await eventFor('run_completed', runId))!;
    expect(ev).toMatchObject({ routing: 'immediate', recipientUserId: owner.userId });
    expect(ev.body).toContain(`Open the task: https://hub.test.local/p/${encodeURIComponent(projectKey)}/tasks/${taskId}`);
    expect(ev.body).not.toContain(c.conversationId);
    expect(ev.body).not.toContain('/ops?c=');
  });

  it('a run NOT started from Ops Chat is unchanged: in-app only, default text', async () => {
    const { runId } = await runTask(owner, null, (p) => p.reply(SECRET));
    expect(await eventFor('run_completed', runId)).toMatchObject({ severity: 'success', routing: 'in_app_only', title: 'A run completed' });
  });

  it('a linked FAILURE stays critical + immediate and gains the task name and the card link', async () => {
    const c = await card(owner, 'dispatch_task');
    const { runId } = await runTask(owner, c.proposalId, (p) => p.fail('invalid_request'));
    expect((await db.select({ status: runs.status }).from(runs).where(eq(runs.id, runId)))[0]!.status).toBe('failed');
    const ev = (await eventFor('run_failed', runId))!;
    expect(ev).toMatchObject({ severity: 'critical', routing: 'immediate', title: 'Ops Chat request failed: "Duct CFM calc"' });
    expect(ev.body).toMatch(/^"Duct CFM calc" — The run failed .*No result was produced\./);
    expect(ev.body).toContain(`#card-${c.proposalId}`);
  });
});
