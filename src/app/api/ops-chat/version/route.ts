import { AppError, toPublicMessage } from '@/lib/errors';
import { requireUser } from '@/domain/auth/guard';
import { currentBuildId } from '@/lib/build-id';

/**
 * GET /api/ops-chat/version — the build this server runs, so an open Ops Chat tab can tell it is running an older one
 * ("Ops Chat was updated — reload"). Signed-in users only (the commit id is not public information); never cached.
 */
export async function GET(): Promise<Response> {
  try {
    await requireUser();
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 });
  }
  return Response.json({ buildId: currentBuildId() }, { headers: { 'cache-control': 'no-store' } });
}
