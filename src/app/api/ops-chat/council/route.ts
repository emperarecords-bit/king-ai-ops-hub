import { z } from 'zod';
import { AppError, RateLimitedError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireUser, requireTenant, listMyProjectsWithOrgRoles } from '@/domain/auth/guard';
import { getDb } from '@/db/client';
import { consumeRateLimit } from '@/domain/usage/rate-limit';
import { serverEnv } from '@/lib/env.server';
import { buildPulse, pulseContext } from '@/domain/opschat/pulse';
import { runCouncil, CouncilUnavailableError, COUNCIL_MAX_QUESTION_CHARS, COUNCIL_MAX_ANSWER_CHARS } from '@/domain/opschat/council';

/**
 * POST — Ops Chat COUNCIL review (owner-triggered). REVIEW ONLY.
 *
 * This endpoint sends an already-produced primary answer to several independent
 * reviewer models and returns a compact synthesis for the owner to weigh. It is
 * NOT on the default answer path (/api/ops-chat remains the primary answer) and
 * NEVER runs automatically — the UI calls it only when the owner taps "Ask
 * Council".
 *
 * SAFETY (preserves every v2 guarantee):
 *   - Auth before any work: authenticated owner with project access, same as the
 *     primary answer path. Failures are proper status codes, never a partial run.
 *   - Context is RE-RESOLVED SERVER-SIDE (`buildPulse`) from the signed-in
 *     owner's own workspaces — arbitrary client-supplied workspace data is never
 *     trusted. An optional `projectKey` focus is validated through
 *     `requireTenant` (membership-gated; a cross-tenant key is rejected 403).
 *   - Council writes NOTHING and imports no mutation/DB-write helpers (enforced
 *     by the read-only guard test). Any action the owner then decides to take
 *     still goes through the unchanged propose → /api/ops-chat/confirm boundary.
 *
 * COST: Council is several model calls. The same owner-scoped per-user rate limit
 * used by the primary path bounds request rate here (its own scope key); the
 * reviewer count, per-reviewer output tokens, per-call timeout and overall
 * Council deadline are capped in the domain layer. No retries.
 */

const Body = z.object({
  message: z.string().trim().min(1).max(COUNCIL_MAX_QUESTION_CHARS),
  answer: z.string().trim().min(1).max(COUNCIL_MAX_ANSWER_CHARS),
  projectKey: z.string().trim().min(1).max(200).optional(),
});

export async function POST(req: Request): Promise<Response> {
  // Auth resolves first so failures are clean status codes.
  let auth: Awaited<ReturnType<typeof listMyProjectsWithOrgRoles>>;
  try {
    await requireUser();
    auth = await listMyProjectsWithOrgRoles();
  } catch (err) {
    return Response.json(
      { error: toPublicMessage(err) },
      { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 },
    );
  }

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await req.json());
  } catch {
    return Response.json({ error: 'Invalid request.' }, { status: 400 });
  }

  // Optional focus scope: re-resolve server-side through the membership gate.
  // A key the owner does not belong to is rejected here (cross-tenant guard),
  // and we never trust client-supplied workspace data beyond the opaque key.
  let focusWorkspace: string | undefined;
  if (body.projectKey) {
    try {
      await requireTenant(body.projectKey);
    } catch (err) {
      return Response.json(
        { error: toPublicMessage(err) },
        { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 },
      );
    }
    focusWorkspace = auth.projects.find((p) => p.key === body.projectKey)?.name ?? body.projectKey;
  }

  // Provider-spend gate: Council makes several paid calls, so bound it with the
  // existing per-user rate limiter BEFORE any provider work. Fail-closed.
  try {
    await getDb().transaction((tx) =>
      consumeRateLimit(tx, `ops-chat-council:user:${auth.user.id}`, serverEnv().RATE_LIMIT_RUNS_PER_MINUTE),
    );
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return Response.json({ error: toPublicMessage(err) }, { status: 429 });
    }
    log.error('ops-chat council rate-limit check failed', { err });
    return Response.json({ error: 'Something went wrong.' }, { status: 500 });
  }

  // Re-resolve the authorized read-only context server-side (owner's own
  // workspaces only — never client-supplied).
  let context: string;
  try {
    context = pulseContext(await buildPulse());
  } catch (err) {
    if (!(err instanceof AppError)) log.error('ops-chat council pulse build failed', { err });
    return Response.json({ error: toPublicMessage(err) }, { status: 500 });
  }

  try {
    const result = await runCouncil({
      question: body.message,
      primaryAnswer: body.answer,
      context,
      focusWorkspace,
      signal: req.signal,
    });
    return Response.json(result);
  } catch (err) {
    if (err instanceof CouncilUnavailableError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    log.error('ops-chat council failed', { err });
    return Response.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
