import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { approvals, auditLogs, memberships, organizations, profiles, projectMembers, projects, tasks } from '@/db/schema';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { executeApprovedAction } from '@/domain/execution/dispatch';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { type TenantContext } from '@/types/domain';
import { fixtureKey } from '@tests/support/fixture-key';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[executor-dispatch.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }
let ctx: TenantContext;

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `exec-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Executor Admin' });
  const [org] = await db.insert(organizations).values({ name: 'Executor Org', slug: fixtureKey('exec-org') }).returning({ id: organizations.id });
  await db.insert(memberships).values({ orgId: org!.id, userId, role: 'owner' });
  const [project] = await db.insert(projects).values({ orgId: org!.id, key: fixtureKey('exec'), name: 'Executor Workspace' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId: org!.id, projectId: project!.id, userId, role: 'admin' });
  ctx = { userId, orgId: org!.id, projectId: project!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.id, ctx.projectId));
});

async function approved(actionType: 'file_write' | 'git_pr' = 'file_write') {
  const db = getSetupDb();
  const payload = { path: 'drafts/preview.md', content: 'never written' };
  const [task] = await db.insert(tasks).values({ orgId: ctx.orgId, projectId: ctx.projectId, title: 'Executor preview', input: 'dry run', providerSelection: 'openai', createdBy: ctx.userId, status: 'completed' }).returning({ id: tasks.id });
  const [approval] = await db.insert(approvals).values({ orgId: ctx.orgId, projectId: ctx.projectId, taskId: task!.id, actionType, payload, payloadSha256: sha256Hex(canonicalJson(payload)), summary: 'Preview', status: 'approved', decidedBy: ctx.userId, decidedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }).returning({ id: approvals.id, hash: approvals.payloadSha256 });
  return { approvalId: approval!.id, hash: approval!.hash };
}

function request(approvalId: string, hash: string, overrides: Record<string, unknown> = {}) {
  return { approvalId, correlationId: 'corr-1', idempotencyKey: `dry-run:${approvalId}`, mode: 'dry_run', confirmation: { confirmedBy: ctx.userId, confirmedAt: new Date(Date.now() - 1000), expiresAt: new Date(Date.now() + 30_000), payloadSha256: hash }, ...overrides };
}

describe.skipIf(!available)('trusted executor dispatch', { timeout: 15_000 }, () => {
  it('fails closed while disabled and audits the attempt', async () => {
    const a = await approved();
    const result = await withTenant(ctx, (tx) => executeApprovedAction(tx, ctx, request(a.approvalId, a.hash)));
    expect(result.outcome).toBe('blocked');
    const events = await getSetupDb().select({ action: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.entityId, a.approvalId), eq(auditLogs.action, 'execution.blocked')));
    expect(events).toHaveLength(1);
  });

  it('performs a dry-run only, persists intent/result, and rejects duplicate idempotency', async () => {
    const a = await approved();
    const input = request(a.approvalId, a.hash);
    const first = await withTenant(ctx, (tx) => executeApprovedAction(tx, ctx, input, { enabledExecutorIds: ['noop_dry_run'] }));
    expect(first).toMatchObject({ outcome: 'not_executed', reconciliation: 'not_required' });
    const again = await withTenant(ctx, (tx) => executeApprovedAction(tx, ctx, input, { enabledExecutorIds: ['noop_dry_run'] }));
    expect(again).toMatchObject({ outcome: 'blocked', message: 'Duplicate idempotency key.' });
    const events = await getSetupDb().select({ action: auditLogs.action, detail: auditLogs.detail }).from(auditLogs).where(eq(auditLogs.entityId, a.approvalId));
    expect(events.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['execution.intent', 'execution.result', 'execution.blocked']));
    expect(JSON.stringify(events)).not.toContain('never written');
  });

  it('rejects unauthorized, live, stale confirmation, prohibited action, and tenant mismatch', async () => {
    const a = await approved();
    const member = { ...ctx, projectRole: 'member' as const };
    expect((await withTenant(member, (tx) => executeApprovedAction(tx, member, request(a.approvalId, a.hash), { enabledExecutorIds: ['noop_dry_run'] }))).outcome).toBe('blocked');
    expect((await withTenant(ctx, (tx) => executeApprovedAction(tx, ctx, request(a.approvalId, a.hash, { mode: 'live' }), { enabledExecutorIds: ['noop_dry_run'] }))).outcome).toBe('blocked');
    expect((await withTenant(ctx, (tx) => executeApprovedAction(tx, ctx, request(a.approvalId, a.hash, { confirmation: { confirmedBy: ctx.userId, confirmedAt: new Date(Date.now() - 60_000), expiresAt: new Date(Date.now() - 1), payloadSha256: a.hash } }), { enabledExecutorIds: ['noop_dry_run'] }))).outcome).toBe('blocked');
    const prohibited = await approved('git_pr');
    expect((await withTenant(ctx, (tx) => executeApprovedAction(tx, ctx, request(prohibited.approvalId, prohibited.hash), { enabledExecutorIds: ['noop_dry_run'] }))).outcome).toBe('blocked');
    const foreign = { ...ctx, projectId: '00000000-0000-4000-8000-000000000099' };
    await expect(withTenant(foreign, (tx) => executeApprovedAction(tx, foreign, request(a.approvalId, a.hash), { enabledExecutorIds: ['noop_dry_run'] }))).rejects.toThrow();
  });

  it('audits malformed input without dispatching', async () => {
    const result = await withTenant(ctx, (tx) => executeApprovedAction(tx, ctx, { approvalId: 'forged', mode: 'live' }, { enabledExecutorIds: ['noop_dry_run'] }));
    expect(result).toMatchObject({ outcome: 'blocked', message: 'Malformed execution request.' });
  });
});
