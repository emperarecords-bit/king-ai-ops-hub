import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, RateLimitedError, UnauthenticatedError } from '@/lib/errors';

/**
 * Ops Chat v2 POST /api/ops-chat — the chat/tool-loop boundary. Fully mocked: no
 * real auth, DB, provider, or Anthropic call. Asserts auth/spend gates and that
 * the model tool-loop is reached only on a valid, rate-limit-passing Send, and
 * that proposals are streamed (never written here).
 */

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  listMyProjectsWithOrgRoles: vi.fn(),
  buildPulse: vi.fn(),
  streamWithTools: vi.fn(),
  consumeRateLimit: vi.fn(),
  getProposals: vi.fn(),
}));

vi.mock('@/domain/auth/guard', () => ({
  requireUser: h.requireUser,
  listMyProjectsWithOrgRoles: h.listMyProjectsWithOrgRoles,
}));
vi.mock('@/domain/opschat/pulse', () => ({ buildPulse: h.buildPulse, pulseContext: () => 'CTX' }));
vi.mock('@/domain/opschat/tools', () => ({
  createOpsChatToolset: () => ({ tools: [], runTool: vi.fn(), getProposals: h.getProposals }),
}));
vi.mock('@/providers/registry', () => ({ getProvider: () => ({ streamWithTools: h.streamWithTools }) }));
vi.mock('@/domain/usage/rate-limit', () => ({ consumeRateLimit: h.consumeRateLimit }));
vi.mock('@/db/client', () => ({ getDb: () => ({ transaction: (fn: (tx: unknown) => unknown) => fn({}) }) }));
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
  h.listMyProjectsWithOrgRoles.mockResolvedValue({
    user: { id: 'u1', email: 'owner@example.com', displayName: 'Owner' },
    projects: [],
    orgRoles: new Map(),
  });
  h.buildPulse.mockResolvedValue({});
  h.consumeRateLimit.mockResolvedValue(undefined);
  h.getProposals.mockReturnValue([
    { kind: 'answer_question', questionId: 'q1', projectKey: 'ab', workspaceName: 'AccurateBids', question: 'x?', answer: 'y' },
  ]);
  h.streamWithTools.mockImplementation(async function* () {
    yield { kind: 'delta', text: 'Hello' };
    yield { kind: 'tool_start', name: 'list_tasks' };
    yield { kind: 'tool_end', name: 'list_tasks', ok: true };
    yield { kind: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
  });
});

describe('POST /api/ops-chat (v2) — auth gate', () => {
  it('unauthenticated → 401, no model call, no rate consume', async () => {
    h.requireUser.mockRejectedValue(new UnauthenticatedError());
    const res = await call({ message: 'what needs me' });
    expect(res.status).toBe(401);
    expect(h.streamWithTools).not.toHaveBeenCalled();
    expect(h.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('forbidden → 403, no model call', async () => {
    h.listMyProjectsWithOrgRoles.mockRejectedValue(new ForbiddenError());
    const res = await call({ message: 'what needs me' });
    expect(res.status).toBe(403);
    expect(h.streamWithTools).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops-chat (v2) — input validation', () => {
  it('empty message → 400, no model call', async () => {
    const res = await call({ message: '' });
    expect(res.status).toBe(400);
    expect(h.streamWithTools).not.toHaveBeenCalled();
  });

  it('non-JSON body → 400', async () => {
    const res = await call('nonsense');
    expect(res.status).toBe(400);
    expect(h.streamWithTools).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops-chat (v2) — spend boundary preserved', () => {
  it('a valid Send reaches the tool loop and streams delta/tool/proposal/done', async () => {
    const res = await call({ message: 'what needs me' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const text = await res.text();
    expect(text).toContain('event: delta');
    expect(text).toContain('Hello');
    expect(text).toContain('event: tool');
    expect(text).toContain('event: proposal');
    expect(text).toContain('event: done');
    expect(h.streamWithTools).toHaveBeenCalledTimes(1);
  });

  it('consumes the owner-scoped rate limit BEFORE any model call (v1 preserved)', async () => {
    await (await call({ message: 'what needs me' })).text();
    expect(h.consumeRateLimit).toHaveBeenCalledTimes(1);
    const [, scopeKey, limit] = h.consumeRateLimit.mock.calls[0]!;
    expect(scopeKey).toBe('ops-chat:user:u1');
    expect(limit).toBe(10);
  });

  it('rate-limited → 429 and no model call', async () => {
    h.consumeRateLimit.mockRejectedValue(new RateLimitedError());
    const res = await call({ message: 'what needs me' });
    expect(res.status).toBe(429);
    expect(h.streamWithTools).not.toHaveBeenCalled();
  });
});
