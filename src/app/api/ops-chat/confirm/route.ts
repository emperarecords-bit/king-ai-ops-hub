import { z } from 'zod';
import { AppError, RateLimitedError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getDb } from '@/db/client';
import { consumeRateLimit } from '@/domain/usage/rate-limit';
import { serverEnv } from '@/lib/env.server';
import { answerOwnerQuestion } from '@/domain/questions/questions';
import { decideApproval } from '@/domain/approvals/approvals';
import { executeApprovedIfEligible } from '@/domain/execution/execute-on-approval';
import { createTask, getTask } from '@/domain/tasks/tasks';
import { enqueueRun } from '@/domain/jobs/jobs';
import { listAgents } from '@/domain/agents/agents';

/**
 * POST — execute a confirmed Ops Chat action. The ONLY place Ops Chat writes.
 *
 * The client-supplied proposal is NEVER trusted as authorization. Each action:
 *   - authenticates and resolves the workspace through the CURRENT user's access
 *     (`requireTenant(projectKey)` — membership-gated, returns a fresh ctx);
 *   - re-enters tenant context (`withTenant`, RLS) and re-fetches/re-validates
 *     the target where appropriate;
 *   - enforces the required role at the ROUTE (defense-in-depth) in addition to
 *     the domain layer, which also enforces it:
 *       answer_question  → admin (route) + answerOwnerQuestion enforces admin
 *       decide_approval  → admin (route) + decideApproval enforces admin
 *       dispatch_task    → admin (route); createTask validates pinned agents
 *       rerun_task       → admin (route); getTask tenant-verifies before enqueue
 *   - maps domain errors to status (403 forbidden / 409 not-found|conflict / 400).
 *
 * SPEND: answer_question / decide_approval do not themselves call a model.
 * dispatch_task / rerun_task ENQUEUE a run — real, spend-producing work whose
 * budget/authorization is governed by the existing task/run machinery on the
 * execution path. A bounded per-user anti-abuse rate limit guards this endpoint;
 * it is NOT a substitute for the role/budget enforcement above.
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

/** Every confirmed action requires workspace-admin — matches the domain layer, enforced here too. */
function requireAdmin(projectRole: string): void {
  if (projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only workspace admins can perform this action.');
  }
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

  // Bounded anti-abuse guard on the write boundary (not a role/budget substitute).
  try {
    await getDb().transaction((tx) =>
      consumeRateLimit(tx, `ops-chat-confirm:user:${ctx.userId}`, serverEnv().RATE_LIMIT_RUNS_PER_MINUTE),
    );
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return Response.json({ error: toPublicMessage(err) }, { status: 429 });
    }
    log.error('ops-chat confirm rate-limit check failed', { err });
    return Response.json({ error: 'Something went wrong.' }, { status: 500 });
  }

  try {
    switch (body.action) {
      case 'answer_question': {
        requireAdmin(ctx.projectRole);
        await withTenant(ctx, (tx) => answerOwnerQuestion(tx, ctx, body.questionId, body.answer));
        return Response.json({ ok: true });
      }
      case 'decide_approval': {
        requireAdmin(ctx.projectRole);
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
        requireAdmin(ctx.projectRole);
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
        requireAdmin(ctx.projectRole);
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
