'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import {
  acceptDecision,
  deferCandidate,
  editCandidate,
  rejectDecision,
} from '@/domain/decisions/decisions';

export interface CandidateState {
  error: string | null;
}

const id = z.string().uuid();

/**
 * One action endpoint for the review queue. `verb` ∈ accept | reject | defer |
 * edit_accept. The AI can never reach here — only an admin session can, and the
 * domain layer re-checks the role.
 */
export async function reviewCandidateAction(
  _prev: CandidateState,
  formData: FormData,
): Promise<CandidateState> {
  const projectKey = String(formData.get('projectKey') ?? '');
  const taskId = String(formData.get('taskId') ?? '');
  const decisionId = String(formData.get('decisionId') ?? '');
  const verb = String(formData.get('verb') ?? '');
  if (!id.safeParse(decisionId).success) return { error: 'Invalid request.' };

  try {
    const ctx = await requireTenant(projectKey);
    await withTenant(ctx, async (tx) => {
      if (verb === 'accept') {
        await acceptDecision(tx, ctx, decisionId);
      } else if (verb === 'reject') {
        await rejectDecision(tx, ctx, decisionId);
      } else if (verb === 'defer') {
        await deferCandidate(tx, ctx, decisionId);
      } else if (verb === 'edit_accept') {
        await editCandidate(tx, ctx, decisionId, {
          title: String(formData.get('title') ?? ''),
          summary: String(formData.get('summary') ?? ''),
          rationale: String(formData.get('rationale') ?? ''),
        });
        await acceptDecision(tx, ctx, decisionId);
      } else {
        throw new AppError('validation', 'Unknown action.');
      }
    });
  } catch (err) {
    if (!(err instanceof AppError)) log.error('reviewCandidate failed', { err });
    return { error: toPublicMessage(err) };
  }
  revalidatePath(`/p/${projectKey}/tasks/${taskId}`);
  revalidatePath(`/p/${projectKey}/decisions`);
  return { error: null };
}
