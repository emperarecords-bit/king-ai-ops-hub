import { and, desc, eq, inArray, lt } from 'drizzle-orm';
import { type ActionType, type ApprovalStatus, type TaskStatus, type TenantContext } from '@/types/domain';
import { AppError, NotFoundError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { agents, approvals, objectives, profiles, tasks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { executionRecordsForApprovals } from '@/domain/execution/execution-results';

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
  opts?: { trigger?: 'automatic' | 'manual'; reason?: string },
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
    detail: { from: 'awaiting_approval', to: 'completed', trigger: opts?.trigger ?? 'automatic', reason: opts?.reason ?? null },
  });
  return true;
}

/**
 * Manual admin reconcile (HUB-002 recovery). A deliberate, audited repair of a task's derived state from
 * its authoritative approval records — for an admin who wants to force the check rather than wait for a
 * surface to sweep it. Requires a non-empty reason; idempotent (a no-op when nothing is stale). Reuses the
 * one reconcile path so there is never parallel state-transition logic. Returns whether it changed anything.
 */
export async function manuallyReconcileTask(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  reason: string,
): Promise<boolean> {
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only project admins can reconcile a task.');
  const r = (reason ?? '').trim();
  if (!r) throw new AppError('validation', 'A reason is required to reconcile a task.');
  return reconcileTaskAuthorization(tx, ctx, taskId, { trigger: 'manual', reason: r });
}

/**
 * Withdraw a single AUTHORIZED-but-unexecuted action (HUB-002 recovery): revoke a permission already
 * granted, before it executes. Distinct from *refuse* (which denies a still-pending action) and from the
 * cancel-time `withdrawPendingApprovalsForTask` (which withdraws PENDING proposals). Allowed ONLY while the
 * approval is `approved` — a pending one must be refused, and rejected/expired/withdrawn are already
 * terminal. This also structurally forbids withdrawal after execution: once an executed state exists the
 * status is no longer `approved`, so the guard refuses it. Admin-only; a non-empty reason is required and
 * preserved; the original decision history is never rewritten (only the status flips to `withdrawn`).
 */
export async function withdrawAuthorizedAction(
  tx: DbTx,
  ctx: TenantContext,
  approvalId: string,
  reason: string,
): Promise<void> {
  if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only project admins can withdraw an authorization.');
  const r = (reason ?? '').trim();
  if (!r) throw new AppError('validation', 'A reason is required to withdraw an authorization — it becomes operational memory.');

  const rows = await tx
    .select({ id: approvals.id, taskId: approvals.taskId, status: approvals.status, actionType: approvals.actionType })
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, ctx.orgId), eq(approvals.projectId, ctx.projectId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('Approval');

  if (row.status !== 'approved') {
    throw new AppError(
      'conflict',
      row.status === 'pending'
        ? 'This action is still awaiting authorization — refuse it instead of withdrawing.'
        : `This authorization is already ${row.status} and cannot be withdrawn.`,
    );
  }

  await tx
    .update(approvals)
    .set({ status: 'withdrawn', decisionNote: r, updatedAt: new Date() })
    .where(eq(approvals.id, approvalId));

  await writeAudit(tx, ctx, {
    action: 'approval.withdrawn',
    entityType: 'approval',
    entityId: approvalId,
    detail: { actionType: row.actionType, from: 'approved', reason: r },
  });

  // Derived task state is unaffected (an authorized-holding task already reconciled to completed), but
  // reconcile defensively in the edge case it was still awaiting — idempotent.
  await reconcileTaskAuthorization(tx, ctx, row.taskId);
}

/**
 * Repair sweep (HUB-001): reconcile EVERY task left stranded in `awaiting_approval` with no proposal
 * still pending — the signature of a task whose authorizations were all decided before the forward-path
 * reconcile existed (or by any path that skipped it). Reuses the idempotent, audited per-task reconcile,
 * so a healthy workspace is a no-op and a stranded one self-heals the moment any surface that calls this
 * (approvals queue, morning briefing, Work) is loaded. Returns how many tasks it moved out of awaiting.
 */
export async function reconcileStrandedApprovalTasks(tx: DbTx, ctx: TenantContext): Promise<number> {
  const awaiting = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.orgId, ctx.orgId), eq(tasks.projectId, ctx.projectId), eq(tasks.status, 'awaiting_approval')));
  let reconciled = 0;
  for (const t of awaiting) {
    if (await reconcileTaskAuthorization(tx, ctx, t.id)) reconciled += 1;
  }
  return reconciled;
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

/**
 * Which of the given tasks hold at least one **authorized-but-unexecuted** action. Because no
 * executor exists yet, every `approved` authorization is unexecuted — so a task summarized as
 * "completed" must not be allowed to imply its proposed action (send/deploy/charge/mutate) actually
 * happened. Surfaces pass the result into the translator so the language stays truthful:
 * *the task finished producing the action; the action itself has not executed.* Returns a Set for
 * O(1) lookup; empty input → empty Set (no query).
 */
export async function tasksWithAuthorizedUnexecutedActions(
  tx: DbTx,
  ctx: TenantContext,
  taskIds: readonly string[],
): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set();
  const rows = await tx
    .select({ id: approvals.id, taskId: approvals.taskId })
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, ctx.orgId),
        eq(approvals.projectId, ctx.projectId),
        eq(approvals.status, 'approved'),
        inArray(approvals.taskId, [...taskIds]),
      ),
    );
  if (rows.length === 0) return new Set();
  // Action Executors v1: an approval whose latest execution.result SUCCEEDED is executed — the
  // honesty qualifier must drop for it. Anything short of succeeded stays "unexecuted".
  const records = await executionRecordsForApprovals(tx, ctx, rows.map((r) => r.id));
  return new Set(rows.filter((r) => records.get(r.id)?.outcome !== 'succeeded').map((r) => r.taskId));
}

/**
 * Is an identical action already pending authorization? Exact-duplicate = same action type AND same
 * canonical payload hash, still `pending`, in this workspace. Used to stop the operator from
 * unknowingly authorizing the same external action twice (broader semantic/superseded relationships
 * are future work). Optionally excludes one approval id (itself).
 */
export async function pendingDuplicateExists(
  tx: DbTx,
  ctx: TenantContext,
  actionType: ActionType,
  payloadSha256: string,
  excludeId?: string,
): Promise<boolean> {
  const dupes = await tx
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, ctx.orgId),
        eq(approvals.projectId, ctx.projectId),
        eq(approvals.status, 'pending'),
        eq(approvals.actionType, actionType),
        eq(approvals.payloadSha256, payloadSha256),
      ),
    );
  return dupes.some((d) => d.id !== excludeId);
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

/** A queue reference — enough originating context to triage without opening the full record. */
export interface QueueApprovalRow {
  id: string;
  taskId: string;
  taskTitle: string;
  objectiveTitle: string | null;
  ownerName: string | null;
  actionType: ActionType;
  payload: unknown;
  summary: string;
  status: ApprovalStatus;
  decisionNote: string | null;
  decidedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

export async function listApprovalsForQueue(tx: DbTx, ctx: TenantContext): Promise<QueueApprovalRow[]> {
  return tx
    .select({
      id: approvals.id,
      taskId: approvals.taskId,
      taskTitle: tasks.title,
      objectiveTitle: objectives.title,
      ownerName: agents.name,
      actionType: approvals.actionType,
      payload: approvals.payload,
      summary: approvals.summary,
      status: approvals.status,
      decisionNote: approvals.decisionNote,
      decidedAt: approvals.decidedAt,
      expiresAt: approvals.expiresAt,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .innerJoin(tasks, eq(approvals.taskId, tasks.id))
    .leftJoin(objectives, eq(tasks.objectiveId, objectives.id))
    .leftJoin(agents, eq(tasks.ownerAgentId, agents.id))
    .where(and(eq(approvals.projectId, ctx.projectId), eq(approvals.orgId, ctx.orgId)))
    .orderBy(desc(approvals.createdAt));
}

/** The full authorization record for the detail surface — the proposal plus its originating context. */
export interface ApprovalDetail {
  id: string;
  taskId: string;
  taskTitle: string;
  taskStatus: TaskStatus;
  runId: string | null;
  actionType: ActionType;
  payload: unknown;
  payloadSha256: string;
  summary: string;
  status: ApprovalStatus;
  requestedBy: string | null;
  objectiveId: string | null;
  objectiveTitle: string | null;
  ownerAgentId: string | null;
  ownerName: string | null;
  decidedByName: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
  expiresAt: Date;
  createdAt: Date;
  /** True if an *exact* identical action (type + payload hash) is still pending elsewhere. */
  hasPendingDuplicate: boolean;
  /** The originating task was cancelled — a pending authorization here is no longer valid to grant. */
  originatingTaskCancelled: boolean;
}

export async function getApprovalDetail(
  tx: DbTx,
  ctx: TenantContext,
  approvalId: string,
): Promise<ApprovalDetail> {
  const rows = await tx
    .select({
      id: approvals.id,
      taskId: approvals.taskId,
      taskTitle: tasks.title,
      taskStatus: tasks.status,
      runId: approvals.runId,
      actionType: approvals.actionType,
      payload: approvals.payload,
      payloadSha256: approvals.payloadSha256,
      summary: approvals.summary,
      status: approvals.status,
      requestedBy: approvals.requestedBy,
      objectiveId: tasks.objectiveId,
      objectiveTitle: objectives.title,
      ownerAgentId: tasks.ownerAgentId,
      ownerName: agents.name,
      decidedByName: profiles.displayName,
      decidedAt: approvals.decidedAt,
      decisionNote: approvals.decisionNote,
      expiresAt: approvals.expiresAt,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .innerJoin(tasks, eq(approvals.taskId, tasks.id))
    .leftJoin(objectives, eq(tasks.objectiveId, objectives.id))
    .leftJoin(agents, eq(tasks.ownerAgentId, agents.id))
    .leftJoin(profiles, eq(approvals.decidedBy, profiles.id))
    .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, ctx.orgId), eq(approvals.projectId, ctx.projectId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('Approval');

  const hasPendingDuplicate =
    row.status === 'pending' && (await pendingDuplicateExists(tx, ctx, row.actionType, row.payloadSha256, row.id));

  return {
    ...row,
    hasPendingDuplicate,
    originatingTaskCancelled: row.taskStatus === 'cancelled',
  };
}

/**
 * Authorize or refuse (schema words: approved/rejected). Only project admins decide; a pending row
 * that has passed its expiry is marked expired and refuses the decision.
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

  // Refusing withholds authority; the reason becomes operational memory that can shape future
  // proposals, so it is required. (Authorization rationale scales with consequence — future work.)
  if (decision === 'rejected' && !(note ?? '').trim()) {
    throw new AppError('validation', 'A rationale is required to refuse — it becomes operational memory.');
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
