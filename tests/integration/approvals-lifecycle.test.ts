import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { and, eq as eqOp } from 'drizzle-orm';
import { approvals, auditLogs, memberships, organizations, profiles, projectMembers, projects, tasks } from '@/db/schema';
import { decideApproval, expireStaleApprovals, getApprovalDetail, listApprovalsForQueue, manuallyReconcileTask, pendingDuplicateExists, reconcileStrandedApprovalTasks, withdrawAuthorizedAction } from '@/domain/approvals/approvals';
import { cancelTask, supersedeTask } from '@/domain/tasks/tasks';
import { listExecution } from '@/domain/execution/execution';
import { assessTask } from '@/domain/execution/assess';
import { noEligibleExecutor } from '@/domain/execution/executors';

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
// A second workspace in the same org (same admin user) for cross-workspace rejection tests.
let ctx2: TenantContext;

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
  const p2 = await db.insert(projects).values({ orgId, key: fixtureKey('ap2'), name: 'B' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p2[0]!.id, userId, role: 'admin' });
  ctx2 = { userId, orgId, projectId: p2[0]!.id, orgRole: 'owner', projectRole: 'admin' };
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

/** A plain task not yet run (for cancel/supersede recovery). Optionally in a given project. */
async function pendingTask(projectId = ctx.projectId): Promise<string> {
  const t = await getSetupDb()
    .insert(tasks)
    .values({ orgId, projectId, title: 'Provision the staging box', input: 'x', providerSelection: 'openai', status: 'pending', createdBy: userId })
    .returning({ id: tasks.id });
  return t[0]!.id;
}

/**
 * A task that finished, whose single proposed action was AUTHORIZED but never executed — the exact
 * state HUB-002 recovery targets. Decided through decideApproval so the task reconciles to completed
 * and the approval sits at `approved`.
 */
async function authorizedUnexecutedTask(): Promise<{ taskId: string; approvalId: string }> {
  const { taskId, approvalIds } = await taskAwaitingApproval(1);
  await withTenant(ctx, (tx) => decideApproval(tx, ctx, approvalIds[0]!, 'approved'));
  return { taskId, approvalId: approvalIds[0]! };
}

async function auditCount(entityId: string, action: string): Promise<number> {
  const rows = await getSetupDb()
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(and(eqOp(auditLogs.entityId, entityId), eqOp(auditLogs.action, action)));
  return rows.length;
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
    const { rows } = await withTenant(ctx, (tx) => listExecution(tx, ctx));
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

  // HUB-001 repair: tasks stranded in awaiting_approval before the forward-path reconcile existed.
  it('the stranded-task sweep reconciles a task whose proposals were all decided out-of-band', async () => {
    const { taskId, approvalIds } = await taskAwaitingApproval(4);
    // Simulate pre-reconcile-era data: mark every proposal approved WITHOUT decideApproval (so no
    // reconcile fired) — the exact signature seen in the accuratebids-com "Pilot launch" task.
    for (const id of approvalIds) {
      await getSetupDb().update(approvals).set({ status: 'approved', decidedAt: new Date() }).where(eqOp(approvals.id, id));
    }
    expect(await taskStatus(taskId)).toBe('awaiting_approval'); // still stranded
    const moved = await withTenant(ctx, (tx) => reconcileStrandedApprovalTasks(tx, ctx));
    expect(moved).toBeGreaterThanOrEqual(1);
    expect(await taskStatus(taskId)).toBe('completed'); // freed
    // Truthful: every surface that reads assessTask now stops asking, without implying execution.
    const { rows } = await withTenant(ctx, (tx) => listExecution(tx, ctx));
    const row = rows.find((r) => r.kind === 'ai_task' && r.id === taskId)!;
    expect(assessTask({ status: row.status!, ownerAgentId: row.ownerAgentId, authorizedUnexecuted: row.authorizedUnexecuted }).intervention).toBe('none');
    expect(row.authorizedUnexecuted).toBe(true);
    // The repair is audited.
    const events = await getSetupDb().select({ id: auditLogs.id }).from(auditLogs).where(and(eqOp(auditLogs.entityId, taskId), eqOp(auditLogs.action, 'task.authorization_reconciled')));
    expect(events.length).toBe(1);
  });

  it('the sweep is idempotent and a no-op on a healthy workspace', async () => {
    const { taskId, approvalIds } = await taskAwaitingApproval(2);
    for (const id of approvalIds) {
      await getSetupDb().update(approvals).set({ status: 'approved', decidedAt: new Date() }).where(eqOp(approvals.id, id));
    }
    expect(await withTenant(ctx, (tx) => reconcileStrandedApprovalTasks(tx, ctx))).toBeGreaterThanOrEqual(1);
    // Second run finds nothing to do — the freed task is no longer awaiting.
    const again = await withTenant(ctx, (tx) => reconcileStrandedApprovalTasks(tx, ctx));
    expect(again).toBe(0);
    expect(await taskStatus(taskId)).toBe('completed');
    // A task that legitimately still has a pending proposal is left untouched by the sweep.
    const healthy = await taskAwaitingApproval(1);
    await withTenant(ctx, (tx) => reconcileStrandedApprovalTasks(tx, ctx));
    expect(await taskStatus(healthy.taskId)).toBe('awaiting_approval');
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

/**
 * HUB-002 — recovery controls for stale, obsolete, or unexecutable tasks and authorizations.
 * Each recovery verb has clear, distinct domain semantics; none is ever represented as execution;
 * every one preserves prior history and writes an append-only audit event.
 */
describe.skipIf(!available)('HUB-002 recovery controls', () => {
  it('cancels a pending task — stops it, preserves history, audits task.cancelled', async () => {
    const taskId = await pendingTask();
    await withTenant(ctx, (tx) => cancelTask(tx, ctx, taskId, 'no longer needed'));
    expect(await taskStatus(taskId)).toBe('cancelled');
    const row = await getSetupDb().select({ r: tasks.cancelReason }).from(tasks).where(eq(tasks.id, taskId));
    expect(row[0]!.r).toBe('no longer needed');
    expect(await auditCount(taskId, 'task.cancelled')).toBe(1);
    // Cancellation is never execution: no surface reads it as needing intervention.
    expect(assessTask({ status: 'cancelled', ownerAgentId: null }).intervention).toBe('none');
  });

  it('cancels a fully-authorized-but-unexecuted task WITHOUT rewriting the authorization history', async () => {
    const { taskId, approvalId } = await authorizedUnexecutedTask();
    expect(await approvalStatus(approvalId)).toBe('approved'); // authorized, unexecuted
    await withTenant(ctx, (tx) => cancelTask(tx, ctx, taskId, 'superseded plan'));
    expect(await taskStatus(taskId)).toBe('cancelled');
    // The original authorization record is preserved exactly — cancellation is not withdrawal and is
    // not execution. The approved approval stays approved (it was already decided, not pending).
    expect(await approvalStatus(approvalId)).toBe('approved');
  });

  it('withdraws an authorized-but-unexecuted action — approval → withdrawn, reason kept, audited', async () => {
    const { taskId, approvalId } = await authorizedUnexecutedTask();
    await withTenant(ctx, (tx) => withdrawAuthorizedAction(tx, ctx, approvalId, 'policy changed before send'));
    expect(await approvalStatus(approvalId)).toBe('withdrawn');
    const row = await getSetupDb().select({ n: approvals.decisionNote }).from(approvals).where(eq(approvals.id, approvalId));
    expect(row[0]!.n).toBe('policy changed before send');
    expect(await auditCount(approvalId, 'approval.withdrawn')).toBe(1);
    // Task itself is untouched (still completed); it simply no longer holds an authorized action.
    expect(await taskStatus(taskId)).toBe('completed');
    const { rows } = await withTenant(ctx, (tx) => listExecution(tx, ctx));
    const r = rows.find((x) => x.kind === 'ai_task' && x.id === taskId)!;
    expect(r.authorizedUnexecuted).toBe(false);
  });

  it('refuses to withdraw an action that is still pending — it must be refused instead', async () => {
    const { approvalIds } = await taskAwaitingApproval(1); // pending, not yet authorized
    await expect(
      withTenant(ctx, (tx) => withdrawAuthorizedAction(tx, ctx, approvalIds[0]!, 'stop it')),
    ).rejects.toThrow(/awaiting authorization|refuse/i);
    expect(await approvalStatus(approvalIds[0]!)).toBe('pending'); // unchanged
  });

  it('forbids double-withdrawal — an already-withdrawn authorization cannot be withdrawn again', async () => {
    const { approvalId } = await authorizedUnexecutedTask();
    await withTenant(ctx, (tx) => withdrawAuthorizedAction(tx, ctx, approvalId, 'first'));
    await expect(
      withTenant(ctx, (tx) => withdrawAuthorizedAction(tx, ctx, approvalId, 'second')),
    ).rejects.toThrow(/already withdrawn/i);
    // Exactly one withdrawal audit event — the repeat produced nothing.
    expect(await auditCount(approvalId, 'approval.withdrawn')).toBe(1);
  });

  it('withdrawal requires a non-empty reason and admin authority', async () => {
    const { approvalId } = await authorizedUnexecutedTask();
    await expect(withTenant(ctx, (tx) => withdrawAuthorizedAction(tx, ctx, approvalId, '   '))).rejects.toThrow(/reason is required/i);
    // A non-admin cannot withdraw (authority check).
    const member = { ...ctx, projectRole: 'member' as const };
    await expect(withTenant(member, (tx) => withdrawAuthorizedAction(tx, member, approvalId, 'nope'))).rejects.toThrow(/admin/i);
    expect(await approvalStatus(approvalId)).toBe('approved'); // still intact
  });

  it('supersedes a task with an existing replacement — links them, cancels the old, audits task.superseded', async () => {
    const oldId = await pendingTask();
    const newId = await pendingTask();
    await withTenant(ctx, (tx) => supersedeTask(tx, ctx, oldId, newId, 'rescoped the work'));
    const row = await getSetupDb().select({ s: tasks.status, by: tasks.supersededByTaskId, r: tasks.cancelReason }).from(tasks).where(eq(tasks.id, oldId));
    expect(row[0]!.s).toBe('cancelled');
    expect(row[0]!.by).toBe(newId); // relationship preserved
    expect(row[0]!.r).toContain('Superseded by');
    expect(await auditCount(oldId, 'task.superseded')).toBe(1);
    // The replacement is untouched.
    expect(await taskStatus(newId)).toBe('pending');
    // Never represented as execution.
    expect(assessTask({ status: 'cancelled', ownerAgentId: null }).intervention).toBe('none');
  });

  it('rejects self-supersession and an already-terminal task', async () => {
    const id = await pendingTask();
    await expect(withTenant(ctx, (tx) => supersedeTask(tx, ctx, id, id, 'x'))).rejects.toThrow(/itself/i);
    await withTenant(ctx, (tx) => cancelTask(tx, ctx, id, 'done'));
    const other = await pendingTask();
    await expect(withTenant(ctx, (tx) => supersedeTask(tx, ctx, id, other, 'x'))).rejects.toThrow(/already cancelled/i);
  });

  it('supersede requires a reason', async () => {
    const a = await pendingTask();
    const b = await pendingTask();
    await expect(withTenant(ctx, (tx) => supersedeTask(tx, ctx, a, b, '  '))).rejects.toThrow(/reason is required/i);
  });

  it('rejects a cross-workspace replacement task (no reaching into another project)', async () => {
    const oldId = await pendingTask(ctx.projectId);
    const foreignReplacement = await pendingTask(ctx2.projectId);
    await expect(
      withTenant(ctx, (tx) => supersedeTask(tx, ctx, oldId, foreignReplacement, 'x')),
    ).rejects.toThrow(); // getTask scopes by project → NotFound
    expect(await taskStatus(oldId)).toBe('pending'); // untouched
  });

  it('manual reconcile repairs a stranded task, records trigger:manual, and is idempotent', async () => {
    const { taskId, approvalIds } = await taskAwaitingApproval(2);
    // Strand it: approve out-of-band so no forward reconcile fired.
    for (const id of approvalIds) {
      await getSetupDb().update(approvals).set({ status: 'approved', decidedAt: new Date() }).where(eqOp(approvals.id, id));
    }
    expect(await taskStatus(taskId)).toBe('awaiting_approval');
    const changed = await withTenant(ctx, (tx) => manuallyReconcileTask(tx, ctx, taskId, 'operator forced the check'));
    expect(changed).toBe(true);
    expect(await taskStatus(taskId)).toBe('completed');
    // The manual trigger + reason are captured in the reconcile audit detail.
    const evs = await getSetupDb()
      .select({ d: auditLogs.detail })
      .from(auditLogs)
      .where(and(eqOp(auditLogs.entityId, taskId), eqOp(auditLogs.action, 'task.authorization_reconciled')));
    expect(evs.length).toBe(1);
    expect((evs[0]!.d as Record<string, unknown>).trigger).toBe('manual');
    expect((evs[0]!.d as Record<string, unknown>).reason).toBe('operator forced the check');
    // Idempotent: a second manual reconcile changes nothing (already completed).
    expect(await withTenant(ctx, (tx) => manuallyReconcileTask(tx, ctx, taskId, 'again'))).toBe(false);
  });

  it('manual reconcile enforces admin authority and a non-empty reason', async () => {
    const { taskId } = await taskAwaitingApproval(1);
    await expect(withTenant(ctx, (tx) => manuallyReconcileTask(tx, ctx, taskId, ''))).rejects.toThrow(/reason is required/i);
    const member = { ...ctx, projectRole: 'member' as const };
    await expect(withTenant(member, (tx) => manuallyReconcileTask(tx, member, taskId, 'x'))).rejects.toThrow(/admin/i);
  });

  it('"execution unavailable" is a positive determination, never a mere absence', () => {
    // No executor exists for any real action type yet (Phase 3 unbuilt) → true for a non-empty set.
    expect(noEligibleExecutor(['email_send'])).toBe(true);
    expect(noEligibleExecutor(['email_send', 'git_push'])).toBe(true);
    // An empty set is NOT "unavailable" — there is simply no authorized action to speak about.
    expect(noEligibleExecutor([])).toBe(false);
  });
});
