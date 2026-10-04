import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, RateLimitedError, UnauthenticatedError } from '@/lib/errors';

/**
 * Ops Chat v1 POST route — the ONLY provider-spend boundary. Fully mocked: no
 * real auth, DB, provider, or Anthropic call. Asserts the spend/auth gates and
 * that the provider is reached only on a valid, rate-limit-passing Send.
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  buildPulse: vi.fn(),
  stream: vi.fn(),
  consumeRateLimit: vi.fn(),
  transaction: vi.fn((fn: (tx: unknown) => unknown) => fn({})),
}));

vi.mock('@/domain/auth/guard', () => ({ requireUser: h.requireUser }));
vi.mock('@/domain/opschat/pulse', () => ({
  buildPulse: h.buildPulse,
  pulseContext: () => 'CTX',
}));
vi.mock('@/providers/registry', () => ({ getProvider: () => ({ stream: h.stream }) }));
vi.mock('@/domain/usage/rate-limit', () => ({ consumeRateLimit: h.consumeRateLimit }));
vi.mock('@/db/client', () => ({ getDb: () => ({ transaction: h.transaction }) }));
vi.mock('@/lib/env.server', () => ({ serverEnv: () => ({ RATE_LIMIT_RUNS_PER_MINUTE: 10 }) }));
vi.mock('@/lib/log', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { POST } from '@/app/api/ops-chat/route';

function call(body: unknown): Promise<Response> {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } };
  init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return POST(new Request('http://localhost/api/ops-chat', init));
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: 'u1', email: 'owner@example.com', displayName: 'Owner' });
  h.buildPulse.mockResolvedValue({});
  h.consumeRateLimit.mockResolvedValue(undefined);
  h.transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn({}));
  h.stream.mockImplementation(async function* () {
    yield { kind: 'delta', text: 'Hello' };
    yield { kind: 'done', response: {} };
  });
});

describe('POST /api/ops-chat — auth gate', () => {
  it('rejects an unauthenticated request with 401 and never calls the provider', async () => {
    h.requireUser.mockRejectedValue(new UnauthenticatedError());
    const res = await call({ message: 'what needs me' });
    expect(res.status).toBe(401);
    expect(h.stream).not.toHaveBeenCalled();
    expect(h.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('rejects a forbidden user with 403 and never calls the provider', async () => {
    h.requireUser.mockRejectedValue(new ForbiddenError());
    const res = await call({ message: 'what needs me' });
    expect(res.status).toBe(403);
    expect(h.stream).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops-chat — input validation', () => {
  it('rejects an empty message with 400 and never calls the provider', async () => {
    const res = await call({ message: '' });
    expect(res.status).toBe(400);
    expect(h.stream).not.toHaveBeenCalled();
  });

  it('rejects a non-JSON body with 400', async () => {
    const res = await call('not json at all');
    expect(res.status).toBe(400);
    expect(h.stream).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops-chat — provider-spend boundary', () => {
  it('a valid Send is the only path that reaches the provider; it streams the reply', async () => {
    const res = await call({ message: 'what needs me' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: delta');
    expect(text).toContain('Hello');
    expect(text).toContain('event: done');
    expect(h.stream).toHaveBeenCalledTimes(1);
  });

  it('consumes the per-user rate limit (owner-scoped) BEFORE spending', async () => {
    await (await call({ message: 'what needs me' })).text();
    expect(h.consumeRateLimit).toHaveBeenCalledTimes(1);
    const [, scopeKey, limit] = h.consumeRateLimit.mock.calls[0]!;
    expect(scopeKey).toBe('ops-chat:user:u1');
    expect(limit).toBe(10);
  });

  it('when rate-limited, returns 429 and never calls the provider', async () => {
    h.consumeRateLimit.mockRejectedValue(new RateLimitedError());
    const res = await call({ message: 'what needs me' });
    expect(res.status).toBe(429);
    expect(h.stream).not.toHaveBeenCalled();
  });
});
