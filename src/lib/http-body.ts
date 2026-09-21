/**
 * Cancel an unread request body (VER-002 PR-4). On any early return that never consumes the body —
 * a disabled control, an authentication rejection, a non-runner principal, or a redemption failure —
 * the handler must not leave the request stream dangling. Cancelling drains/aborts it.
 *
 * A body that is `locked` is owned by whoever is reading it (the streaming redeem path), which cancels
 * it itself on an interrupted read — so we skip it here. Absent body is a no-op. Never throws.
 */
export async function cancelUnreadRequestBody(req: { body?: ReadableStream<Uint8Array> | null }): Promise<void> {
  try {
    const body = req.body;
    if (body && !body.locked) await body.cancel();
  } catch {
    /* already consumed, errored, or unsupported — nothing to clean up */
  }
}
