import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { agents, approvals, auditLogs, memberships, organizations, profiles, projectMembers, projects, runs, spendLimits, tasks } from '@/db/schema';
import { setProviderOverrideForTests } from '@/providers/registry';
import { startRun } from '@/domain/tasks/runner';

/**
 * Regression — the server-cooling evidence (Hub prod, 2026-10-19). The owner's ad-hoc "Duct CFM calc" task
 * (0a72c3bc) ran with the workspace's unrelated pending ONEAL support draft in its context ("pending_review:
 * Draft response to ONEAL (id e4c08c7c)…"), and its run re-proposed that reply (approval edb61199), parking the
 * duct task behind an approval that had nothing to do with it. The ONEAL subject (support request e4c08c7c) had
 * been REJECTED by the owner the day before (effcc035) and was re-proposed three times after that.
 *
 * Through the REAL startRun path with a fake provider (no external call, no spend), this proves:
 *  1. the ONEAL pending item never reaches the HVAC run's prompt or context manifest;
 *  2. even if a run proposes the ONEAL reply anyway, no approval is created (subject pending / rejected) and
 *     the task completes instead of parking behind it;
 *  3. an explicit owner request naming the subject still gets through (re-proposal on owner request).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');
process.env.RATE_LIMIT_RUNS_PER_MINUTE = '1000';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[run-context-isolation.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let baseCtx: TenantContext;

const REQ = 'e4c08c7c-1111-4222-8333-444455556666';
const ONEAL_SUMMARY = 'Draft response to ONEAL (id e4c08c7c) regarding billing/subscription access';
const onealAction = (summary = 'Reply to ONEAL regarding billing/subscription access') =>
  '```proposed-actions\n' +
  JSON.stringify([{ type: 'external_http', summary, payload: { kind: 'accuratebids_reply', request_id: REQ, reply_text: 'Hello ONEAL, …' } }]) +
  '\n```';

async function makeWorkspace() {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('iso'), name: 'Empera A/C' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: baseCtx.userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  const ctx: TenantContext = { ...baseCtx, projectId: pid };
  const primaryId = (
    await db
      .insert(agents)
      .values({ orgId, projectId: pid, name: 'Marketing Lead', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'You are primary.', temperatureMilli: 700, maxOutputTokens: 2048 })
      .returning({ id: agents.id })
  )[0]!.id;
  return { ctx, pid, primaryId };
}

async function makeTask(ws: { ctx: TenantContext; primaryId: string }, title: string, input: string, status: 'pending' | 'completed' = 'pending') {
  return (
    await db
      .insert(tasks)
      .values({
        orgId,
        projectId: ws.ctx.projectId,
        title,
        input,
        providerSelection: 'openai',
        reviewEnabled: false,
        quickExempt: true,
        status,
        createdBy: ws.ctx.userId,
        assignedPrimaryAgentId: ws.primaryId,
      })
      .returning({ id: tasks.id })
  )[0]!.id;
}

/** The ONEAL history: a support-desk task whose reply was REJECTED yesterday, plus one still pending. */
async function seedOnealHistory(ws: { ctx: TenantContext; primaryId: string }, opts: { pending: boolean }) {
  const deskTask = await makeTask(ws, 'Production cycle (09:00 UTC)', 'Work the Email Desk.', 'completed');
  const yesterday = new Date(Date.now() - 24 * 3600_000);
  await db.insert(approvals).values({
    orgId, projectId: ws.ctx.projectId, taskId: deskTask, actionType: 'email_send', status: 'rejected',
    payload: { request_id: REQ, reply_text: 'v1' }, payloadSha256: 'a'.repeat(64), summary: 'Reply to ONEAL regarding billing/subscription access',
    requestedBy: 'openai', decidedAt: yesterday, createdAt: yesterday, expiresAt: new Date(Date.now() + 86_400_000),
  });
  if (opts.pending) {
    await db.insert(approvals).values({
      orgId, projectId: ws.ctx.projectId, taskId: deskTask, actionType: 'email_send', status: 'pending',
      payload: { request_id: REQ, reply_text: 'v2' }, payloadSha256: 'b'.repeat(64), summary: ONEAL_SUMMARY,
      requestedBy: 'openai', expiresAt: new Date(Date.now() + 86_400_000),
    });
  }
}

function inject(reply: string) {
  const openai = new FakeProvider('openai');
  openai.reply(reply);
  setProviderOverrideForTests((id) => (id === 'openai' ? openai : undefined));
  return openai;
}

const approvalsFor = (taskId: string) => db.select().from(approvals).where(eq(approvals.taskId, taskId));
const auditsFor = (taskId: string, action: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.entityId, taskId), eq(auditLogs.action, action)));

beforeAll(async () => {
  if (!available) return;
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `iso-${randomUUID().slice(0, 8)}@t.local`, displayName: 'Owner' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `iso-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  baseCtx = { userId, orgId, projectId: '', orgRole: 'owner', projectRole: 'admin' } as TenantContext;
});
afterEach(() => setProviderOverrideForTests(null));
afterAll(() => setProviderOverrideForTests(null));

describe.skipIf(!available)('run context isolation + persistent rejection (HVAC task vs ONEAL support draft)', () => {
  it('the ONEAL pending draft never reaches the HVAC run prompt or its context manifest', async () => {
    const ws = await makeWorkspace();
    await seedOnealHistory(ws, { pending: true });
    const hvac = await makeTask(ws, 'Duct CFM calc + duct size options + HVAC unit sourcing', 'Customer job: two Bard HR58AP units, 20kW server cabinet. Size the ducts.');
    const openai = inject('Duct CFM: ~3,160 CFM at ΔT 20°F.');
    await startRun(ws.ctx, hvac);

    const prompt = JSON.stringify(openai.requests);
    expect(prompt).not.toContain('ONEAL');
    expect(prompt).not.toContain(REQ);
    const run = (await db.select().from(runs).where(eq(runs.taskId, hvac)))[0]!;
    const manifest = JSON.stringify(run.contextManifest);
    expect(manifest).not.toContain('ONEAL');
    expect(manifest).not.toContain('pending_review');
  });

  it('a run that proposes the ONEAL reply anyway creates NO approval while one is pending, and the task completes', async () => {
    const ws = await makeWorkspace();
    await seedOnealHistory(ws, { pending: true });
    const hvac = await makeTask(ws, 'Duct CFM calc', 'Size the ducts for the server cabinet.');
    inject(`Duct CFM: ~3,160 CFM.\n\n${onealAction()}`);
    const outcome = await startRun(ws.ctx, hvac);

    expect(await approvalsFor(hvac)).toHaveLength(0);
    expect(outcome.status).toBe('completed');
    expect(await auditsFor(hvac, 'approval.duplicate_subject_suppressed')).toHaveLength(1);
  });

  it('after the owner REJECTED the ONEAL reply, a later run cannot re-propose it (rewording does not help)', async () => {
    const ws = await makeWorkspace();
    await seedOnealHistory(ws, { pending: false });
    const hvac = await makeTask(ws, 'Duct CFM calc', 'Size the ducts for the server cabinet.');
    inject(`Done.\n\n${onealAction('Submit draft response to ONEAL for owner approval')}`);
    const outcome = await startRun(ws.ctx, hvac);

    expect(await approvalsFor(hvac)).toHaveLength(0);
    expect(outcome.status).toBe('completed');
    const audit = await auditsFor(hvac, 'approval.rejected_subject_suppressed');
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.detail)).toContain(`support_request:${REQ}`);
  });

  it('an explicit owner request naming the inquiry after the rejection may propose it again', async () => {
    const ws = await makeWorkspace();
    await seedOnealHistory(ws, { pending: false });
    const ask = await makeTask(ws, 'Reconsider ONEAL reply', `Owner: reconsider support request ${REQ} and draft a better reply.`);
    inject(`Here is a better draft.\n\n${onealAction()}`);
    await startRun(ws.ctx, ask);

    const created = await approvalsFor(ask);
    expect(created).toHaveLength(1);
    expect(created[0]!.status).toBe('pending');
  });

  it('a NEW support inquiry (new request id = changed evidence) is not blocked by the old rejection', async () => {
    const ws = await makeWorkspace();
    await seedOnealHistory(ws, { pending: false });
    const desk = await makeTask(ws, 'Email Desk', 'Work the Email Desk.');
    const other = 'f0000000-1111-4222-8333-444455556666';
    inject(
      '```proposed-actions\n' +
        JSON.stringify([{ type: 'external_http', summary: 'Reply to new inquiry', payload: { kind: 'accuratebids_reply', request_id: other, reply_text: 'Hi' } }]) +
        '\n```',
    );
    await startRun(ws.ctx, desk);
    expect(await approvalsFor(desk)).toHaveLength(1);
  });
});
