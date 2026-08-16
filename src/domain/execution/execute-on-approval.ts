import 'server-only';
import { and, eq } from 'drizzle-orm';
import { approvals } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { type TenantContext } from '@/types/domain';
import { executeApprovedAction, resolveDispatchPolicyFromEnv, type DispatchPolicy } from './dispatch';
import { hasEligibleExecutor } from './executors';

/** Confirmation freshness window: the Okay click authorizes execution for this long. */
const CONFIRMATION_WINDOW_MS = 5 * 60 * 1000;

export interface ApprovalExecutionOutcome {
  /** False when the action type has no executor (nothing was attempted — the honest default). */
  readonly attempted: boolean;
  readonly outcome: 'succeeded' | 'failed' | 'blocked' | 'ambiguous' | 'not_executed' | null;
  readonly message: string | null;
  /** Present when the execution produced a pull request. */
  readonly prUrl: string | null;
}

const NOT_ATTEMPTED: ApprovalExecutionOutcome = { attempted: false, outcome: null, message: null, prUrl: null };

/**
 * Action Executors v1: after an admin approves, the hub itself executes the action when a real
 * executor exists for its type. The approval decision has already committed in its own
 * transaction — this runs separately so a failed execution can never roll back the recorded
 * decision. One deterministic idempotency key per approval means an approval executes at most
 * once, ever; the dispatch choke point re-verifies authority, payload integrity, enablement, and
 * the payload-bound confirmation minted here from the admin's Okay.
 */
export async function executeApprovedIfEligible(
  ctx: TenantContext,
  approvalId: string,
  policy: DispatchPolicy = resolveDispatchPolicyFromEnv(),
): Promise<ApprovalExecutionOutcome> {
  return withTenant(ctx, async (tx) => {
    const rows = await tx
      .select({ actionType: approvals.actionType, payloadSha256: approvals.payloadSha256, status: approvals.status })
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.orgId, ctx.orgId), eq(approvals.projectId, ctx.projectId)))
      .limit(1);
    const row = rows[0];
    if (!row || row.status !== 'approved' || !hasEligibleExecutor(row.actionType)) return NOT_ATTEMPTED;

    const now = new Date();
    const result = await executeApprovedAction(
      tx,
      ctx,
      {
        approvalId,
        correlationId: `approval:${approvalId}`,
        idempotencyKey: `approval-execute:${approvalId}`,
        mode: 'live',
        confirmation: {
          confirmedBy: ctx.userId,
          confirmedAt: now,
          expiresAt: new Date(now.getTime() + CONFIRMATION_WINDOW_MS),
          payloadSha256: row.payloadSha256,
        },
      },
      policy,
    );

    const preview = result.preview as { prUrl?: unknown } | null;
    return {
      attempted: true,
      outcome: result.outcome,
      message: result.message,
      prUrl: preview && typeof preview.prUrl === 'string' ? preview.prUrl : null,
    };
  });
}
