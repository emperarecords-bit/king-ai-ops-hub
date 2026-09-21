import { AppError, toPublicMessage } from '@/lib/errors';
import { requireRunnerOrTenant } from '@/domain/auth/guard';
import { cancelUnreadRequestBody } from '@/lib/http-body';
import { serverEnv } from '@/lib/env.server';
import { withRunner } from '@/db/tenant';
import type { VerificationCaller } from '@/types/domain';
import { redeemUploadGrant, type RedeemRejectionCode } from '@/domain/verification';
import { createDrizzleUploadGrantStore } from '@/domain/verification/drizzle-store';
import { exclusiveArtifactWriter, objectStoreArtifactStore } from '@/domain/verification/runtime-adapters';

/**
 * PUT — redeem an artifact upload grant by STREAMING the bytes (VER-002 PR-4; disabled by default).
 *
 * RUNNER-ONLY, behind `VERIFICATION_RUNNER_UPLOAD_ENABLED`. The Hub streams the body into a private temp
 * file (never the final key), enforcing the per-artifact cap + exact declared size + declared checksum,
 * then publishes atomically create-only (no overwrite). Completion is an append-only event; an identical
 * retry replays idempotently, and a later failed retry can never undo a completion. Upload COMPLETION is
 * separate from quota finalization (a later slice does no accounting here).
 */
const STATUS: Record<RedeemRejectionCode, number> = {
  grant_not_found: 404,
  grant_expired: 410,
  too_large: 413,
  size_mismatch: 400,
  checksum_mismatch: 422,
  grant_binding_mismatch: 409,
  write_unsupported: 503,
};

/**
 * Adapt the web ReadableStream request body to an async iterable of chunks (empty when absent). On an
 * EARLY return by the consumer (size-limit abort, checksum failure, etc.) the generator's `return()`
 * runs the `finally`, which CANCELS the reader — draining/aborting the unread request body rather than
 * leaking a half-read stream.
 */
async function* bodyChunks(req: Request): AsyncIterable<Uint8Array> {
  const body = req.body;
  if (!body) return;
  const reader = body.getReader();
  let drained = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        break;
      }
      if (value) yield value;
    }
  } finally {
    if (!drained) {
      try {
        await reader.cancel(); // cancel the unread remainder on an early/interrupted return
      } catch {
        /* body already errored/closed */
      }
    }
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ projectKey: string; grantId: string }> },
): Promise<Response> {
  // One outer finally so EVERY exit — disabled control, authentication rejection, non-runner principal,
  // a redeem rejection, or a thrown error — cancels an unread request body (bodyChunks owns/cancels it
  // once the streaming redeem locks it).
  try {
    const { projectKey, grantId } = await params;

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
    if (caller.kind !== 'runner') {
      return Response.json({ error: 'Only a runner credential may redeem an upload grant.' }, { status: 403 });
    }
    const runner = caller.runner;

    try {
      const writer = await exclusiveArtifactWriter();
      const outcome = await withRunner(runner, (tx) =>
        redeemUploadGrant(
          {
            grants: createDrizzleUploadGrantStore(tx),
            writer,
            artifacts: objectStoreArtifactStore(runner),
          },
          runner,
          grantId,
          bodyChunks(req),
        ),
      );
      if (outcome.rejection) {
        return Response.json({ error: outcome.rejection.message, code: outcome.rejection.code }, { status: STATUS[outcome.rejection.code] });
      }
      return Response.json(
        { completed: outcome.completed, idempotent: outcome.idempotent, reconciled: outcome.reconciled, objectKey: outcome.objectKey },
        { status: 200 },
      );
    } catch (err) {
      return Response.json({ error: toPublicMessage(err) }, { status: 500 });
    }
  } finally {
    await cancelUnreadRequestBody(req);
  }
}
