import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/ops-chat — overall end-to-end deadline. Fully mocked (no real auth,
 * DB, provider). The server deadline is mocked tiny so real timers fire quickly.
 * Verifies: a never-ending stream and a stalled tool both yield a clean, retryable
 * timeout and CLOSE the stream (the UI can never be left on "Thinking…"); a
 * provider failure surfaces an error and closes; a normal run streams through.
 * No write path is exercised in any case (the loop never confirms/dispatches).
 */

const TIMEOUT_MSG = 'The AI request timed out. Nothing was changed. Try again.';

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
// Tiny server deadline so real timers fire fast; same message as production.
// NB: the factory is hoisted above module consts — the message is inlined here
// (it must equal TIMEOUT_MSG below, which assertions use).
vi.mock('@/domain/opschat/limits', () => ({
  OPS_CHAT_SERVER_DEADLINE_MS: 40,
  OPS_CHAT_TIMEOUT_MESSAGE: 'The AI request timed out. Nothing was changed. Try again.',
  OPS_CHAT_CLIENT_TIMEOUT_MS: 120_000,
}));

import { POST } from '@/app/api/ops-chat/route';

function call(body: unknown): Promise<Response> {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } };
  init.body = JSON.stringify(body);
  return POST(new Request('http://localhost/api/ops-chat', init));
}

/** Yields some events, then waits for the request's abort signal and returns. */
function stalling(preamble: Array<Record<string, unknown>>) {
  return async function* (request: { signal?: AbortSignal }) {
    for (const e of preamble) yield e;
    await new Promise<void>((resolve) => {
      if (request.signal?.aborted) resolve();
      else request.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    // After abort: no further yields. (The route already emitted the timeout.)
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: 'u1', email: 'o@e.com', displayName: 'Owner' });
  h.listMyProjectsWithOrgRoles.mockResolvedValue({
    user: { id: 'u1', email: 'o@e.com', displayName: 'Owner' },
    projects: [],
    orgRoles: new Map(),
  });
  h.buildPulse.mockResolvedValue({});
  h.consumeRateLimit.mockResolvedValue(undefined);
  h.getProposals.mockReturnValue([]);
});

describe('POST /api/ops-chat — overall deadline', () => {
  it('never-ending stream → clean timeout error + stream closes (no indefinite Thinking)', async () => {
    h.streamWithTools.mockImplementation(stalling([{ kind: 'delta', text: 'working' }]));
    const text = await (await call({ message: 'hi' })).text();
    expect(text).toContain('event: error');
    expect(text).toContain(TIMEOUT_MSG);
    expect(text).not.toContain('event: done');
  });

  it('stalled tool → clean timeout error + stream closes', async () => {
    h.streamWithTools.mockImplementation(stalling([{ kind: 'tool_start', name: 'list_tasks' }]));
    const text = await (await call({ message: 'why did it fail' })).text();
    expect(text).toContain('event: tool'); // tool_start surfaced before the stall
    expect(text).toContain('event: error');
    expect(text).toContain(TIMEOUT_MSG);
    expect(text).not.toContain('event: done');
  });

  it('provider failure → error surfaced + stream closes (not left pending)', async () => {
    // Provider fails during iteration (e.g. Anthropic request timeout).
    h.streamWithTools.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error('Anthropic request timed out')) }),
    }));
    const res = await call({ message: 'hi' });
    const text = await res.text();
    expect(text).toContain('event: error');
    expect(text).not.toContain('event: done');
  });

  it('normal completion streams delta/tool/proposal/done within the deadline', async () => {
    h.getProposals.mockReturnValue([{ kind: 'answer_question', questionId: 'q1', projectKey: 'ab', workspaceName: 'W', question: 'x?', answer: 'y' }]);
    h.streamWithTools.mockImplementation(async function* () {
      yield { kind: 'delta', text: 'Hello' };
      yield { kind: 'tool_start', name: 'list_tasks' };
      yield { kind: 'tool_end', name: 'list_tasks', ok: true };
      yield { kind: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
    });
    const text = await (await call({ message: 'what needs me' })).text();
    expect(text).toContain('event: delta');
    expect(text).toContain('Hello');
    expect(text).toContain('event: tool');
    expect(text).toContain('event: proposal');
    expect(text).toContain('event: done');
    expect(text).not.toContain(TIMEOUT_MSG);
  });
});
