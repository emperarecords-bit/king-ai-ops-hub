import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { requireRunnerOrTenant } from '@/domain/auth/guard';
import { serverEnv } from '@/lib/env.server';
import { withRunner } from '@/db/tenant';
import type { VerificationCaller } from '@/types/domain';
import { requestUploadGrant, type GrantRequestRejectionCode, type UploadGrant } from '@/domain/verification';
import { createDrizzleUploadGrantStore, createDrizzleVerificationStore } from '@/domain/verification/drizzle-store';

/**
 * POST — request an artifact UPLOAD grant (VER-002 PR-4, mechanism only; disabled by default).
 *
 * RUNNER-ONLY: only a machine principal may request a grant; a human session is refused (403). Behind
 * `VERIFICATION_RUNNER_UPLOAD_ENABLED` (default off ⇒ 403, nothing issued). The grant binds
 * (tenant, contract, attempt, logical path) to one server-derived object key + the declared size/digest.
 * Identical re-request is idempotent (200); a changed declaration is a conflict (409). Required-artifact
 * paths only. No bytes move here — this issues the grant the runner later redeems.
 */
const grantSchema = z.object({
  requestId: z.string().uuid(),
  attemptId: z.string().min(1),
  logicalPath: z.string().min(1),
  declaredSize: z.number().int().nonnegative(),
  declaredSha256: z.string().min(1),
  contentType: z.string().optional(),
});

function grantView(g: UploadGrant, projectKey: string): Record<string, unknown> {
  return {
    grantId: g.id,
    objectKey: g.objectKey,
    logicalPath: g.logicalPath,
    attemptId: g.attemptId,
    declaredSize: g.declaredSize,
    declaredSha256: g.declaredSha256,
    contentType: g.contentType,
    expiresAt: g.expiresAt,
    uploadPath: `/api/p/${projectKey}/verification/uploads/${g.id}`,
  };
}

const STATUS: Record<GrantRequestRejectionCode, number> = {
  invalid_input: 400,
  unknown_request: 404,
  catalog_unpinned: 409,
  path_not_required: 400,
  grant_conflict: 409,
};

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectKey: string }> },
): Promise<Response> {
  const { projectKey } = await params;

  // Its own default-off control. Off ⇒ 403, nothing issued (checked before auth so "disabled" is uniform).
  if (!serverEnv().VERIFICATION_RUNNER_UPLOAD_ENABLED) {
    return Response.json({ error: 'Artifact uploads are disabled.' }, { status: 403 });
  }

  let caller: VerificationCaller;
  try {
    caller = await requireRunnerOrTenant(projectKey, req);
  } catch (err) {
    const code = err instanceof AppError ? err.code : null;
    const status = code === 'unauthenticated' ? 401 : code === 'validation' ? 400 : 403;
    return Response.json({ error: toPublicMessage(err) }, { status });
  }
  // Runner-only: a human session may not request a grant.
  if (caller.kind !== 'runner') {
    return Response.json({ error: 'Only a runner credential may request an upload grant.' }, { status: 403 });
  }
  const runner = caller.runner;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = grantSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid upload grant request.', issues: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const outcome = await withRunner(runner, (tx) =>
      requestUploadGrant(
        { store: createDrizzleVerificationStore(tx), grants: createDrizzleUploadGrantStore(tx) },
        runner,
        parsed.data,
      ),
    );
    if (outcome.rejection) {
      return Response.json({ error: outcome.rejection.message, code: outcome.rejection.code }, { status: STATUS[outcome.rejection.code] });
    }
    return Response.json({ grant: grantView(outcome.grant!, projectKey), created: outcome.created }, { status: outcome.created ? 201 : 200 });
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: 500 });
  }
}
