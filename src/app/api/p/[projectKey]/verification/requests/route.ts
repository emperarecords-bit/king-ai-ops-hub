import { z } from 'zod';
import { AppError, toPublicMessage } from '@/lib/errors';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { createVerificationRequest } from '@/domain/verification';
import { createDrizzleVerificationStore } from '@/domain/verification/drizzle-store';

/**
 * POST — create a verification REQUEST (the contract) for a task at an exact commit (VER-002).
 *
 * Authorization: `requireTenant` resolves the project key to the caller's tenant; only a member of
 * that project may create a contract in it. org/project/creator are taken from that context, NEVER the
 * body, so a caller cannot bind a contract to another tenant (the DB RLS with-check pins it too).
 *
 * Write permission: creating a verification contract is a project WRITE. The `admin` and `member` roles
 * may create one; the `viewer` (read-only) role may not. An authenticated non-member is rejected earlier
 * by requireTenant (403), because they have no access record for the project.
 *
 * The contract is immutable: creating one for a (task, commit) that already has an IDENTICAL contract
 * returns it (200, created:false); a DIFFERENT contract for the same (task, commit) is a 409 conflict.
 * There is no update route.
 */
const bodySchema = z.object({
  taskId: z.string().uuid(),
  repoFullName: z.string().min(1),
  commitSha: z.string().min(1),
  requiredChecks: z.array(z.string()),
  requiredArtifacts: z.array(z.string()).optional().default([]),
  allowDirty: z.boolean().optional().default(false),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ projectKey: string }> },
): Promise<Response> {
  const { projectKey } = await params;

  let ctx;
  try {
    ctx = await requireTenant(projectKey);
  } catch (err) {
    return Response.json(
      { error: toPublicMessage(err) },
      { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 },
    );
  }

  // admin + member may create a verification contract; viewer (read-only) may not.
  if (ctx.projectRole === 'viewer') {
    return Response.json({ error: 'Viewers cannot create verification requests.' }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: 'Invalid verification request.', issues: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const outcome = await withTenant(ctx, (tx) =>
      createVerificationRequest(createDrizzleVerificationStore(tx), ctx, parsed.data),
    );
    if (outcome.rejection) {
      const code = outcome.rejection.code;
      const status =
        code === 'invalid_input' ? 400 : code === 'task_not_in_project' ? 404 : code === 'repo_not_authorized' ? 403 : 409; // no_repo_binding, contract_conflict
      return Response.json({ error: outcome.rejection.message, code }, { status });
    }
    return Response.json({ request: outcome.request, created: outcome.created }, { status: outcome.created ? 201 : 200 });
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: 500 });
  }
}
