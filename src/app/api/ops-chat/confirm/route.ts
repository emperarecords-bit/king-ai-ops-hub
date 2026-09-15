import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { answerOwnerQuestion } from '@/domain/questions/questions';
import { decideApproval } from '@/domain/approvals/approvals';
import { executeApprovedIfEligible } from '@/domain/execution/execute-on-approval';

/**
 * POST — execute a confirmed Ops Chat action. The ONLY place Ops Chat writes.
 * Two actions, each running the SAME governed path the Inbox uses, so the
 * client-supplied fields are never trusted blindly:
 *   answer_question  → requireTenant → withTenant → answerOwnerQuestion
 *   decide_approval  → requireTenant → withTenant → decideApproval, then (on
 *                      approve) best-effort executeApprovedIfEligible in its own
 *                      transaction — the recorded decision survives an execution
 *                      failure, exactly as in the Inbox.
 * Every domain fn re-validates admin role, tenant scope, and current status.
 */

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('answer_question'),
    projectKey: z.string().min(1),
    questionId: z.string().uuid(),
    answer: z.string().trim().min(1).max(8000),
  }),
  z.object({
    action: z.literal('decide_approval'),
    projectKey: z.string().min(1),
    approvalId: z.string().uuid(),
    decision: z.enum(['approved', 'rejected']),
    note: z.string().max(2000).optional(),
  }),
]);

function statusFor(err: unknown): number {
  if (err instanceof AppError && err.code === 'forbidden') return 403;
  if (err instanceof AppError && (err.code === 'not_found' || err.code === 'conflict')) return 409;
  return 400;
}

export async function POST(req: Request): Promise<Response> {
  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  let ctx;
  try {
    ctx = await requireTenant(body.projectKey);
  } catch (err) {
    return Response.json(
      { error: toPublicMessage(err) },
      { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 },
    );
  }

  try {
    if (body.action === 'answer_question') {
      await withTenant(ctx, (tx) => answerOwnerQuestion(tx, ctx, body.questionId, body.answer));
      return Response.json({ ok: true });
    }
    // decide_approval
    await withTenant(ctx, (tx) => decideApproval(tx, ctx, body.approvalId, body.decision, body.note));
    let executed: { outcome: string | null; message: string | null } | null = null;
    if (body.decision === 'approved') {
      try {
        const outcome = await executeApprovedIfEligible(ctx, body.approvalId);
        executed = { outcome: outcome.outcome, message: outcome.message };
      } catch (err) {
        // The decision is recorded; execution is best-effort (mirrors the Inbox).
        log.error('ops-chat executeApprovedIfEligible failed', { err, approvalId: body.approvalId });
        executed = { outcome: 'failed', message: 'Execution failed; the approval itself is recorded.' };
      }
    }
    return Response.json({ ok: true, executed });
  } catch (err) {
    if (!(err instanceof AppError)) log.error('ops-chat confirm failed', { err, action: body.action });
    return Response.json({ error: toPublicMessage(err) }, { status: statusFor(err) });
  }
}
