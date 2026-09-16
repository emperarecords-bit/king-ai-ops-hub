import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { answerOwnerQuestion } from '@/domain/questions/questions';
import { decideApproval } from '@/domain/approvals/approvals';
import { executeApprovedIfEligible } from '@/domain/execution/execute-on-approval';
import { createTask, getTask } from '@/domain/tasks/tasks';
import { enqueueRun } from '@/domain/jobs/jobs';
import { listAgents } from '@/domain/agents/agents';

/**
 * POST — execute a confirmed Ops Chat action. The ONLY place Ops Chat writes.
 * Each action runs the SAME governed path the UI uses, so client-supplied fields
 * are never trusted blindly:
 *   answer_question  → answerOwnerQuestion
 *   decide_approval  → decideApproval (+ best-effort executeApprovedIfEligible)
 *   dispatch_task    → createTask + enqueueRun (admin-gated; spends money)
 *   rerun_task       → verify task in tenant, then enqueueRun (admin-gated)
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
  z.object({
    action: z.literal('dispatch_task'),
    projectKey: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    instructions: z.string().trim().min(1).max(32_000),
    agentId: z.string().uuid(),
  }),
  z.object({
    action: z.literal('rerun_task'),
    projectKey: z.string().min(1),
    taskId: z.string().uuid(),
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
    switch (body.action) {
      case 'answer_question': {
        await withTenant(ctx, (tx) => answerOwnerQuestion(tx, ctx, body.questionId, body.answer));
        return Response.json({ ok: true });
      }
      case 'decide_approval': {
        await withTenant(ctx, (tx) => decideApproval(tx, ctx, body.approvalId, body.decision, body.note));
        let executed: { outcome: string | null; message: string | null } | null = null;
        if (body.decision === 'approved') {
          try {
            const outcome = await executeApprovedIfEligible(ctx, body.approvalId);
            executed = { outcome: outcome.outcome, message: outcome.message };
          } catch (err) {
            log.error('ops-chat executeApprovedIfEligible failed', { err, approvalId: body.approvalId });
            executed = { outcome: 'failed', message: 'Execution failed; the approval itself is recorded.' };
          }
        }
        return Response.json({ ok: true, executed });
      }
      case 'dispatch_task': {
        if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only workspace admins can dispatch work.');
        const agent = (await withTenant(ctx, (tx) => listAgents(tx, ctx))).find((a) => a.id === body.agentId && a.enabled);
        if (!agent) throw new AppError('not_found', 'That agent is not available in this workspace.');
        const taskId = await withTenant(ctx, async (tx) => {
          const id = await createTask(tx, ctx, {
            title: body.title,
            input: body.instructions,
            providerSelection: agent.provider,
            reviewEnabled: false,
            modelTier: 'standard',
            flagshipCategory: null,
            objectiveId: null,
            scheduleId: null,
            primaryAgentId: agent.id,
            reviewerAgentId: null,
          });
          await enqueueRun(tx, ctx, id);
          return id;
        });
        return Response.json({ ok: true, taskId });
      }
      case 'rerun_task': {
        if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'Only workspace admins can re-run work.');
        await withTenant(ctx, async (tx) => {
          await getTask(tx, ctx, body.taskId); // throws NotFound if outside tenant
          await enqueueRun(tx, ctx, body.taskId);
        });
        return Response.json({ ok: true });
      }
    }
  } catch (err) {
    if (!(err instanceof AppError)) log.error('ops-chat confirm failed', { err, action: body.action });
    return Response.json({ error: toPublicMessage(err) }, { status: statusFor(err) });
  }
}
