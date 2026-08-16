'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { decideApproval } from '@/domain/approvals/approvals';
import { executeApprovedIfEligible, type ApprovalExecutionOutcome } from '@/domain/execution/execute-on-approval';

export interface InboxDecisionState {
  error: string | null;
  /** Action Executors v1: what the hub did right after the Okay (null when nothing was attempted). */
  executed: ApprovalExecutionOutcome | null;
}

const schema = z.object({
  projectKey: z.string().min(1),
  approvalId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
});

/**
 * Decide one approval FROM the cross-workspace inbox. Same authority path as
 * the per-workspace queue: requireTenant re-derives membership for the target
 * workspace and decideApproval enforces the rest — the inbox is a viewport,
 * not a privilege. On approval, execution is attempted in a SEPARATE
 * transaction (execute-on-approval), so the recorded decision survives any
 * execution failure.
 */
export async function decideFromInbox(
  _prev: InboxDecisionState,
  formData: FormData,
): Promise<InboxDecisionState> {
  const parsed = schema.safeParse({
    projectKey: formData.get('projectKey'),
    approvalId: formData.get('approvalId'),
    decision: formData.get('decision'),
  });
  if (!parsed.success) return { error: 'Invalid request.', executed: null };
  let executed: ApprovalExecutionOutcome | null = null;
  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    await withTenant(ctx, (tx) => decideApproval(tx, ctx, parsed.data.approvalId, parsed.data.decision));
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
    if (!(err instanceof AppError)) log.error('decideFromInbox failed', { err });
    return { error: toPublicMessage(err), executed: null };
  }
  revalidatePath('/inbox');
  revalidatePath(`/p/${parsed.data.projectKey}/approvals`);
  return { error: null, executed };
}
