'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { decideApproval, withdrawAuthorizedAction } from '@/domain/approvals/approvals';
import { executeApprovedIfEligible, type ApprovalExecutionOutcome } from '@/domain/execution/execute-on-approval';

export interface DecisionState {
  error: string | null;
  /** Action Executors v1: what the hub did right after approval (null when nothing was attempted). */
  executed?: ApprovalExecutionOutcome | null;
}

const decisionSchema = z.object({
  projectKey: z.string().min(1),
  approvalId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(1000).optional(),
});

export async function decide(_prev: DecisionState, formData: FormData): Promise<DecisionState> {
  const parsed = decisionSchema.safeParse({
    projectKey: formData.get('projectKey'),
    approvalId: formData.get('approvalId'),
    decision: formData.get('decision'),
    note: formData.get('note') || undefined,
  });
  if (!parsed.success) return { error: 'Invalid request.' };

  let executed: ApprovalExecutionOutcome | null = null;
  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    await withTenant(ctx, (tx) =>
      decideApproval(tx, ctx, parsed.data.approvalId, parsed.data.decision, parsed.data.note),
    );
    if (parsed.data.decision === 'approved') {
      try {
        const outcome = await executeApprovedIfEligible(ctx, parsed.data.approvalId);
        executed = outcome.attempted ? outcome : null;
      } catch (err) {
        log.error('executeApprovedIfEligible failed', { err });
        executed = { attempted: true, outcome: 'failed', message: 'Execution failed unexpectedly; the approval itself is recorded.', prUrl: null };
      }
    }
  } catch (err) {
    if (!(err instanceof AppError)) log.error('decideApproval failed', { err });
    return { error: toPublicMessage(err) };
  }

  revalidatePath(`/p/${parsed.data.projectKey}/approvals`);
  revalidatePath(`/p/${parsed.data.projectKey}/approvals/${parsed.data.approvalId}`);
  return { error: null, executed };
}

const withdrawSchema = z.object({
  projectKey: z.string().min(1),
  approvalId: z.string().uuid(),
  reason: z.string().trim().min(1, 'A reason is required to withdraw an authorization.').max(1000),
});

/**
 * Withdraw an AUTHORIZED-but-unexecuted action (HUB-002 recovery) — revoke a permission already granted,
 * before it executes. Admin-only + reason enforced in the domain; the original decision history is
 * preserved (status flips to withdrawn). Distinct from refusing a still-pending action.
 */
export async function withdrawAuthorization(_prev: DecisionState, formData: FormData): Promise<DecisionState> {
  const parsed = withdrawSchema.safeParse({
    projectKey: formData.get('projectKey'),
    approvalId: formData.get('approvalId'),
    reason: formData.get('reason'),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Invalid request.' };

  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    await withTenant(ctx, (tx) => withdrawAuthorizedAction(tx, ctx, parsed.data.approvalId, parsed.data.reason));
  } catch (err) {
    if (!(err instanceof AppError)) log.error('withdrawAuthorizedAction failed', { err });
    return { error: toPublicMessage(err) };
  }

  revalidatePath(`/p/${parsed.data.projectKey}/approvals`);
  revalidatePath(`/p/${parsed.data.projectKey}/approvals/${parsed.data.approvalId}`);
  return { error: null };
}
