import { afterEach, describe, expect, it, vi } from 'vitest';
import { cancelUnreadRequestBody } from '@/lib/http-body';

/**
 * VER-002 PR-4 (round 3, finding 3): the redeem route must cancel an UNREAD request body on every
 * early-return path — a disabled control, an authentication rejection, and a non-runner principal — not
 * only the redeem paths. These tests prove the cancellation helper's contract and that the route calls it
 * on the disabled and authentication-rejected paths (both reachable without a DB).
 */

/** A ReadableStream that stays open (one chunk, never closes), with a spy-able cancel. */
function openBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3]));
    },
  });
}

describe('cancelUnreadRequestBody', () => {
  it('cancels an unlocked body', async () => {
    const body = openBody();
    const spy = vi.spyOn(body, 'cancel');
    await cancelUnreadRequestBody({ body });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT cancel a locked body (its reader owns cancellation)', async () => {
    const body = openBody();
    const reader = body.getReader(); // locks the stream
    const spy = vi.spyOn(body, 'cancel');
    await cancelUnreadRequestBody({ body });
    expect(spy).not.toHaveBeenCalled();
    reader.releaseLock();
  });

  it('is a no-op on an absent body and never throws', async () => {
    await expect(cancelUnreadRequestBody({ body: null })).resolves.toBeUndefined();
    await expect(cancelUnreadRequestBody({})).resolves.toBeUndefined();
  });
});

describe('PUT redeem route — cancels the unread body on early-return paths', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  // serverEnv() validates the whole environment; provide the minimum valid, non-production values.
  function stubBaseEnv(): void {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    vi.stubEnv('APP_ENCRYPTION_KEY', 'nEX663P2IcY+6NtCNY+TQv++9YWvHn0v8gOcs5AawYw=');
  }

  async function callPut(headers: Record<string, string> = {}): Promise<{ status: number; cancelled: boolean }> {
    vi.resetModules();
    const { PUT } = await import('@/app/api/p/[projectKey]/verification/uploads/[grantId]/route');
    const req = new Request('http://127.0.0.1/api/p/stresspro/verification/uploads/g1', {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream', ...headers },
      body: openBody(),
      // @ts-expect-error Node/undici requires duplex for a streaming request body
      duplex: 'half',
    });
    const cancelSpy = vi.spyOn(req.body!, 'cancel');
    const res = await PUT(req, { params: Promise.resolve({ projectKey: 'stresspro', grantId: 'g1' }) });
    return { status: res.status, cancelled: cancelSpy.mock.calls.length > 0 };
  }

  it('DISABLED (flag off) → 403 and the unread body is cancelled', async () => {
    stubBaseEnv();
    vi.stubEnv('VERIFICATION_RUNNER_UPLOAD_ENABLED', '0');
    const out = await callPut();
    expect(out.status).toBe(403);
    expect(out.cancelled).toBe(true);
  });

  it('AUTH-REJECTED (bearer while machine-auth off) → 401 and the unread body is cancelled', async () => {
    stubBaseEnv();
    vi.stubEnv('VERIFICATION_RUNNER_UPLOAD_ENABLED', '1');
    vi.stubEnv('VERIFICATION_RUNNER_MACHINE_AUTH_ENABLED', '0');
    const out = await callPut({ authorization: 'Bearer 11111111-1111-4111-8111-111111111111.some-secret-value' });
    expect(out.status).toBe(401);
    expect(out.cancelled).toBe(true);
  });
});
