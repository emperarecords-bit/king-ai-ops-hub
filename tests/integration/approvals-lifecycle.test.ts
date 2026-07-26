import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { approvals, memberships, organizations, profiles, projectMembers, projects, tasks } from '@/db/schema';
import { decideApproval, expireStaleApprovals, getApprovalDetail, listApprovalsForQueue, pendingDuplicateExists } from '@/domain/approvals/approvals';
import { cancelTask } from '@/domain/tasks/tasks';
import { listExecution } from '@/domain/execution/execution';
import { assessTask } from '@/domain/execution/assess';

/**
 * Authorization lifecycle vs. task-execution lifecycle (Approvals integrity pass). A task holds
 * `awaiting_approval` only while a proposal it raised is genuinely pending; once none remain the
 * task reconciles to `completed` (its production work already succeeded). A decided proposal must
 * never keep any surface asking for the same decision. These are separate facts, tested as such.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[approvals-lifecycle.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let ctx: TenantContext;

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `ap-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Admin' });
  const org = await db.insert(organizations).values({ name: 'Org', slug: `ap-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('ap'), name: 'A' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

/**
 * A task whose run finished and produced `count` pending proposals — i.e. it sits at the gate.
 * Payload hashes are unique per call so duplicate-detection assertions can't collide with the
 * pending approvals other tests leave behind in the shared project.
 */
async function taskAwaitingApproval(
  count: number,
  expiresAt = new Date(Date.now() + 60 * 60 * 1000),
): Promise<{ taskId: string; approvalIds: string[]; hashes: string[] }> {
  const db = getSetupDb();
  const nonce = randomUUID().slice(0, 8);
  const t = await db
    .insert(tasks)
    .values({ orgId, projectId: ctx.projectId, title: 'Draft the launch email', input: 'x', providerSelection: 'openai', status: 'awaiting_approval', createdBy: userId })
    .returning({ id: tasks.id });
  const taskId = t[0]!.id;
  const approvalIds: string[] = [];
  const hashes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const sha = `hash-${nonce}-${i}`;
    const a = await db
      .insert(approvals)
      .values({ orgId, projectId: ctx.projectId, taskId, actionType: 'email_send', payload: { to: 'x@y.z', n: i }, payloadSha256: sha, summary: `Send email ${i}`, status: 'pending', expiresAt })
      .returning({ id: approvals.id });
    approvalIds.push(a[0]!.id);
    hashes.push(sha);
  }
  return { taskId, approvalIds, hashes };
}

async function taskStatus(taskId: string): Promise<string> {
  const r = await getSetupDb().select({ s: tasks.status }).from(tasks).where(eq(tasks.id, taskId));
  return r[0]!.s;
}
async function approvalStatus(id: string): Promise<string> {
  const r = await getSetupDb().select({ s: approvals.status }).from(approvals).where(eq(approvals.id, id));
  return r[0]!.s;
}

describe.skipIf(!available)('authorization reconciles the task lifecycle', () => {
  it('a task with one pending proposal is Waiting and requires authorization', async () => {
    const { taskId } = await taskAwaitingApproval(1);
    const a = assessTask({ status: (await taskStatus(taskId)) as never, ownerAgentId: null });
    expect(a.condition).toBe('waiting');
    expect(a.intervention).toBe('required');
  });

  it('approving the final pending proposal removes the task from Waiting', async () => {
    const { taskId, approvalIds } = await taskAwaitingApproval(1);
    await withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[0]!, 'approved'));
    expect(await taskStatus(taskId)).toBe('completed');
    expect(await approvalStatus(approvalIds[0]!)).toBe('approved');
    // The whole point: no surface keeps asking, because every surface reads this via assessTask.
    expect(assessTask({ status: 'completed', ownerAgentId: null }).intervention).toBe('none');
  });

  it('rejecting the final pending proposal also removes the task from Waiting', async () => {
    const { taskId, approvalIds } = await taskAwaitingApproval(1);
    await withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[0]!, 'rejected', 'not appropriate'));
    expect(await taskStatus(taskId)).toBe('completed');
    expect(await approvalStatus(approvalIds[0]!)).toBe('rejected');
  });

  it('one decided proposal does NOT resolve the task while another remains pending', async () => {
    const { taskId, approvalIds } = await taskAwaitingApproval(2);
    await withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[0]!, 'approved'));
    // Second proposal is still pending → the task is not yet reconciled.
    expect(await taskStatus(taskId)).toBe('awaiting_approval');
    await withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[1]!, 'rejected', 'no'));
    // Now none pending → reconciled.
    expect(await taskStatus(taskId)).toBe('completed');
  });

  it('an expired final proposal resolves the task waiting condition', async () => {
    const { taskId, approvalIds } = await taskAwaitingApproval(1, new Date(Date.now() - 1000));
    await withTenant(ctx, (tx) => expireStaleApprovals(tx, ctx));
    expect(await approvalStatus(approvalIds[0]!)).toBe('expired');
    expect(await taskStatus(taskId)).toBe('completed');
  });

  it('a cancelled task withdraws its still-pending proposals', async () => {
    const { taskId, approvalIds } = await taskAwaitingApproval(2);
    await withTenant(ctx, (tx) => cancelTask(tx, ctx, taskId, 'changed our mind'));
    expect(await taskStatus(taskId)).toBe('cancelled');
    // Withdrawn — not rejected (no reviewer refused it) and not expired (it did not lapse).
    expect(await approvalStatus(approvalIds[0]!)).toBe('withdrawn');
    expect(await approvalStatus(approvalIds[1]!)).toBe('withdrawn');
  });

  it('a decided approval is never re-requested and cannot be decided twice', async () => {
    const { taskId, approvalIds } = await taskAwaitingApproval(1);
    await withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[0]!, 'approved'));
    // Reconciled away from the gate, so Execution/Dashboard (both via assessTask) stop asking.
    expect(assessTask({ status: (await taskStatus(taskId)) as never, ownerAgentId: null }).intervention).toBe('none');
    // And the same decision cannot be applied again.
    await expect(withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[0]!, 'rejected', 'x'))).rejects.toThrow(/already/i);
  });

  it('refusing requires a rationale (it becomes operational memory)', async () => {
    const { approvalIds } = await taskAwaitingApproval(1);
    await expect(withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[0]!, 'rejected'))).rejects.toThrow(/rationale is required/i);
    await expect(withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[0]!, 'rejected', '  '))).rejects.toThrow(/rationale is required/i);
    // With a rationale it goes through.
    await withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[0]!, 'rejected', 'not appropriate'));
    expect(await approvalStatus(approvalIds[0]!)).toBe('rejected');
  });

  it('a completed task holding an authorized action never reads as the action complete', async () => {
    const { taskId, approvalIds } = await taskAwaitingApproval(1);
    await withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[0]!, 'approved'));
    // Task reconciled to completed, but the approval is authorized-and-unexecuted.
    const rows = await withTenant(ctx, (tx) => listExecution(tx, ctx));
    const row = rows.find((r) => r.kind === 'ai_task' && r.id === taskId)!;
    expect(row.authorizedUnexecuted).toBe(true);
    const a = assessTask({ status: row.status!, ownerAgentId: row.ownerAgentId, authorizedUnexecuted: row.authorizedUnexecuted });
    expect(a.reason).toMatch(/not yet executed/i);
    expect(a.reason).not.toBe('Completed.');
  });

  it('getApprovalDetail carries originating context and flags a cancelled task', async () => {
    const { taskId, approvalIds } = await taskAwaitingApproval(1);
    const before = await withTenant(ctx, (tx) => getApprovalDetail(tx, ctx, approvalIds[0]!));
    expect(before.taskTitle).toBe('Draft the launch email');
    expect(before.taskStatus).toBe('awaiting_approval');
    expect(before.originatingTaskCancelled).toBe(false);
    // Cancel the task → the pending proposal is withdrawn, and detail reports the task cancelled.
    await withTenant(ctx, (tx) => cancelTask(tx, ctx, taskId, 'no longer needed'));
    const after = await withTenant(ctx, (tx) => getApprovalDetail(tx, ctx, approvalIds[0]!));
    expect(after.originatingTaskCancelled).toBe(true);
    expect(after.status).toBe('withdrawn');
  });

  it('listApprovalsForQueue returns pending references with originating context', async () => {
    const { approvalIds } = await taskAwaitingApproval(1);
    const rows = await withTenant(ctx, (tx) => listApprovalsForQueue(tx, ctx));
    const row = rows.find((r) => r.id === approvalIds[0]!)!;
    expect(row.taskTitle).toBe('Draft the launch email');
    expect(row.status).toBe('pending');
  });

  it('detects an exact pending duplicate by action type and canonical payload hash', async () => {
    const { approvalIds, hashes } = await taskAwaitingApproval(1); // one pending email_send with a unique sha
    const sha = hashes[0]!;
    expect(await withTenant(ctx, (tx) => pendingDuplicateExists(tx, ctx, 'email_send', sha))).toBe(true);
    // Different hash → not a duplicate. Different type → not a duplicate.
    expect(await withTenant(ctx, (tx) => pendingDuplicateExists(tx, ctx, 'email_send', `${sha}-x`))).toBe(false);
    expect(await withTenant(ctx, (tx) => pendingDuplicateExists(tx, ctx, 'git_push', sha))).toBe(false);
    // Once decided, it is no longer a *pending* duplicate.
    await withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[0]!, 'approved'));
    expect(await withTenant(ctx, (tx) => pendingDuplicateExists(tx, ctx, 'email_send', sha))).toBe(false);
  });
});
