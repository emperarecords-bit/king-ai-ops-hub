import { and, desc, eq, lt } from 'drizzle-orm';
import { type ActionType, type ApprovalStatus, type TenantContext } from '@/types/domain';
import { AppError, NotFoundError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { approvals, tasks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * The human approval gate (invariant I4). This module DECIDES authorization; it never
 * executes. Executors arrive in Phase 3 behind `executeApprovedAction()`, which will re-read the
 * row and re-verify the payload hash.
 *
 * Authorization is a separate lifecycle from task execution. A task's production work can finish
 * successfully and still hold a *pending authorization* for an action it proposed. This module owns
 * the authorization lifecycle (pending → approved | rejected | expired | withdrawn) and reconciles
 * the *task's* execution status once no authorization remains pending — so a decided proposal never
 * strands its task in `awaiting_approval`. It does not, and must not, imply the action executed.
 */

/**
 * Reconcile a task's execution status against its authorizations. A task sits in
 * `awaiting_approval` only while at least one proposal it raised is still pending. Once none are
 * pending — every proposal approved, rejected, expired, or withdrawn — the task's own work (which
 * already completed to produce those proposals) is reflected as `completed`. Authorization records
 * keep their independent outcomes. Idempotent and audited; a no-op unless the task is awaiting.
 */
export async function reconcileTaskAuthorization(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
): Promise<boolean> {
  const taskRows = await tx
    .select({ status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.orgId, ctx.orgId), eq(tasks.projectId, ctx.projectId)))
    .limit(1);
  const task = taskRows[0];
  if (!task || task.status !== 'awaiting_approval') return false;

  const stillPending = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.taskId, taskId),
        eq(approvals.orgId, ctx.orgId),
        eq(approvals.projectId, ctx.projectId),
        eq(approvals.status, 'pending'),
      ),
    )
    .limit(1);
  if (stillPending.length > 0) return false;

  await tx
    .update(tasks)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.orgId, ctx.orgId), eq(tasks.projectId, ctx.projectId)));
  await writeAudit(tx, ctx, {
    action: 'task.authorization_reconciled',
    entityType: 'task',
    entityId: taskId,
    detail: { from: 'awaiting_approval', to: 'completed' },
  });
  return true;
}

/**
 * Withdraw a task's still-pending authorizations because the task itself was cancelled (or the
 * proposals were otherwise superseded). `withdrawn` is distinct from a reviewer's `rejected` and
 * from `expired`: no one refused it and it did not lapse — the thing it would authorize no longer
 * exists. Each withdrawal is audited. Returns the count withdrawn.
 */
export async function withdrawPendingApprovalsForTask(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  reason: string,
): Promise<number> {
  const withdrawn = await tx
    .update(approvals)
    .set({ status: 'withdrawn', decisionNote: reason, updatedAt: new Date() })
    .where(
      and(
        eq(approvals.taskId, taskId),
        eq(approvals.orgId, ctx.orgId),
        eq(approvals.projectId, ctx.projectId),
        eq(approvals.status, 'pending'),
      ),
    )
    .returning({ id: approvals.id, actionType: approvals.actionType });

  for (const row of withdrawn) {
    await writeAudit(tx, ctx, {
      action: 'approval.withdrawn',
      entityType: 'approval',
      entityId: row.id,
      detail: { actionType: row.actionType, reason },
    });
  }
  return withdrawn.length;
}

export interface ApprovalRow {
  id: string;
  taskId: string;
  actionType: ActionType;
  payload: unknown;
  payloadSha256: string;
  summary: string;
  status: ApprovalStatus;
  requestedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/**
 * A5 sweep: mark past-due pending approvals expired so queue counts and the
 * briefing tell the truth. Explicit call (not a side effect of reading) —
 * invoked by the approvals page and the morning briefing. Each expiry is
 * audited; a stale proposal silently becoming decidable again is exactly what
 * the expiry exists to prevent.
 */
export async function expireStaleApprovals(tx: DbTx, ctx: TenantContext): Promise<number> {
  const expired = await tx
    .update(approvals)
    .set({ status: 'expired', updatedAt: new Date() })
    .where(
      and(
        eq(approvals.projectId, ctx.projectId),
        eq(approvals.orgId, ctx.orgId),
        eq(approvals.status, 'pending'),
        lt(approvals.expiresAt, new Date()),
      ),
    )
    .returning({ id: approvals.id, taskId: approvals.taskId });

  for (const row of expired) {
    await writeAudit(tx, ctx, {
      action: 'approval.expired',
      entityType: 'approval',
      entityId: row.id,
    });
  }
  // A lapsed final proposal must still free its task from the waiting condition (truthful
  // lifecycle: awaiting_approval only while a proposal is genuinely pending).
  for (const taskId of new Set(expired.map((r) => r.taskId))) {
    await reconcileTaskAuthorization(tx, ctx, taskId);
  }
  return expired.length;
}

export async function listApprovals(
  tx: DbTx,
  ctx: TenantContext,
  status?: ApprovalStatus,
): Promise<ApprovalRow[]> {
  const scope = and(eq(approvals.projectId, ctx.projectId), eq(approvals.orgId, ctx.orgId));
  return tx
    .select({
      id: approvals.id,
      taskId: approvals.taskId,
      actionType: approvals.actionType,
      payload: approvals.payload,
      payloadSha256: approvals.payloadSha256,
      summary: approvals.summary,
      status: approvals.status,
      requestedBy: approvals.requestedBy,
      decidedAt: approvals.decidedAt,
      decisionNote: approvals.decisionNote,
      expiresAt: approvals.expiresAt,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(status ? and(scope, eq(approvals.status, status)) : scope)
    .orderBy(desc(approvals.createdAt));
}

/**
 * Approve or reject. Only project admins decide; a pending row that has passed
 * its expiry is marked expired and refuses the decision.
 */
export async function decideApproval(
  tx: DbTx,
  ctx: TenantContext,
  approvalId: string,
  decision: 'approved' | 'rejected',
  note?: string,
): Promise<void> {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only project admins can decide approvals.');
  }

  const rows = await tx
    .select({
      id: approvals.id,
      taskId: approvals.taskId,
      status: approvals.status,
      expiresAt: approvals.expiresAt,
      actionType: approvals.actionType,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.id, approvalId),
        eq(approvals.projectId, ctx.projectId),
        eq(approvals.orgId, ctx.orgId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('Approval');

  if (row.status !== 'pending') {
    throw new AppError('conflict', `This approval was already ${row.status}.`);
  }

  if (row.expiresAt.getTime() < Date.now()) {
    await tx
      .update(approvals)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(approvals.id, approvalId));
    await writeAudit(tx, ctx, {
      action: 'approval.expired',
      entityType: 'approval',
      entityId: approvalId,
    });
    throw new AppError('conflict', 'This approval has expired and can no longer be decided.');
  }

  await tx
    .update(approvals)
    .set({
      status: decision,
      decidedBy: ctx.userId,
      decidedAt: new Date(),
      decisionNote: note ?? null,
      updatedAt: new Date(),
    })
    .where(eq(approvals.id, approvalId));

  await writeAudit(tx, ctx, {
    action: 'approval.decided',
    entityType: 'approval',
    entityId: approvalId,
    detail: { decision, actionType: row.actionType, note: note ?? null },
  });

  // Deciding this authorization may have cleared the task's last pending proposal — reconcile so
  // the task leaves `awaiting_approval` and no surface keeps asking for a decision already made.
  await reconcileTaskAuthorization(tx, ctx, row.taskId);
}
