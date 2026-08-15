'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { decideApproval } from '@/domain/approvals/approvals';

export interface InboxDecisionState {
  error: string | null;
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
 * not a privilege.
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
  if (!parsed.success) return { error: 'Invalid request.' };
  try {
    const ctx = await requireTenant(parsed.data.projectKey);
    await withTenant(ctx, (tx) => decideApproval(tx, ctx, parsed.data.approvalId, parsed.data.decision));
  } catch (err) {
    if (!(err instanceof AppError)) log.error('decideFromInbox failed', { err });
    return { error: toPublicMessage(err) };
  }
  revalidatePath('/inbox');
  revalidatePath(`/p/${parsed.data.projectKey}/approvals`);
  return { error: null };
}
