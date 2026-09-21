import { AppError, toPublicMessage } from '@/lib/errors';
import { requireTenant } from '@/domain/auth/guard';
import { revokeRunnerKey } from '@/db/runner-keys';

/**
 * POST — revoke a runner (machine) credential (VER-002 PR-2).
 *
 * Explicitly authorized: human session, **project admin only**. Deliberately INDEPENDENT of the
 * issuance control — disabling issuance must never prevent an admin from revoking an already-issued
 * credential. RLS confines the update to the admin's own project, so a keyId from another project is a
 * 404 (not found in this tenant).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ projectKey: string; keyId: string }> },
): Promise<Response> {
  const { projectKey, keyId } = await params;

  let ctx;
  try {
    ctx = await requireTenant(projectKey);
  } catch (err) {
    return Response.json(
      { error: toPublicMessage(err) },
      { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 },
    );
  }
  if (ctx.projectRole !== 'admin') {
    return Response.json({ error: 'Only a project admin may revoke runner credentials.' }, { status: 403 });
  }
  if (!UUID_RE.test(keyId)) {
    return Response.json({ error: 'Invalid runner key id.' }, { status: 400 });
  }

  try {
    const revoked = await revokeRunnerKey(ctx, keyId);
    if (!revoked) {
      // Not in this project, or already revoked.
      return Response.json({ error: 'Runner credential not found or already revoked.' }, { status: 404 });
    }
    return Response.json({ keyId, revoked: true }, { status: 200 });
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: 500 });
  }
}
