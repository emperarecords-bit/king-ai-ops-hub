import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { answerOwnerQuestion } from '@/domain/questions/questions';

/**
 * POST — execute a confirmed Ops Chat action. v2 supports exactly one action:
 * answering an owner-question. This is the ONLY place Ops Chat writes, and it
 * runs the SAME governed path the Inbox uses — requireTenant(projectKey) →
 * withTenant → answerOwnerQuestion — which re-validates admin role, tenant
 * scope, and that the question is still open. The client-supplied fields are
 * therefore never trusted blindly: the write is authoritative.
 */

const Body = z.object({
  action: z.literal('answer_question'),
  projectKey: z.string().min(1),
  questionId: z.string().uuid(),
  answer: z.string().trim().min(1).max(8000),
});

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
    await withTenant(ctx, (tx) => answerOwnerQuestion(tx, ctx, body.questionId, body.answer));
    return Response.json({ ok: true });
  } catch (err) {
    if (!(err instanceof AppError)) log.error('ops-chat confirm failed', { err, questionId: body.questionId });
    const status =
      err instanceof AppError && err.code === 'forbidden'
        ? 403
        : err instanceof AppError && (err.code === 'not_found' || err.code === 'conflict')
          ? 409
          : 400;
    return Response.json({ error: toPublicMessage(err) }, { status });
  }
}
