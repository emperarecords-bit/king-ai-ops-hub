import { and, desc, eq, lt } from 'drizzle-orm';
import { type ActionType, type ApprovalStatus, type TenantContext } from '@/types/domain';
import { AppError, NotFoundError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { approvals } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * The human approval gate (invariant I4). This module DECIDES; it never
 * executes. Executors arrive in Phase 3 behind `executeApprovedAction()`,
 * which will re-read the row and re-verify the payload hash.
 */

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
    .returning({ id: approvals.id });

  for (const row of expired) {
    await writeAudit(tx, ctx, {
      action: 'approval.expired',
      entityType: 'approval',
      entityId: row.id,
    });
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
}
