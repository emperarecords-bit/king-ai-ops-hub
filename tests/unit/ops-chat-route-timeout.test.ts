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
  // persistence (PR 2) — mocked so this stays a DB-free timeout/stream-close test.
  appendOwnerMessage: vi.fn(),
  appendAssistantMessage: vi.fn(),
  addProposal: vi.fn(),
  createConversation: vi.fn(),
  conversationExists: vi.fn(),
  loadReplyForOwnerMessage: vi.fn(),
  loadPromptTurns: vi.fn(),
  earliestUnansweredOwnerId: vi.fn(),
  tryClaimTurn: vi.fn(),
  tryClaimConversation: vi.fn(),
  release: vi.fn(),
  convRelease: vi.fn(),
}));

vi.mock('@/domain/auth/guard', () => ({
  requireUser: h.requireUser,
  listMyProjectsWithOrgRoles: h.listMyProjectsWithOrgRoles,
}));
vi.mock('@/domain/opschat/pulse', () => ({ buildPulse: h.buildPulse, pulseContext: () => 'CTX' }));
vi.mock('@/domain/opschat/tools', () => ({
  createOpsChatToolset: () => ({ tools: [], runTool: vi.fn(), getProposals: h.getProposals }),
  proposalKey: (p: { kind: string }) => `k:${p.kind}`,
}));
vi.mock('@/providers/registry', () => ({ getProvider: () => ({ streamWithTools: h.streamWithTools }) }));
vi.mock('@/domain/usage/rate-limit', () => ({ consumeRateLimit: h.consumeRateLimit }));
vi.mock('@/db/client', () => ({ getDb: () => ({ transaction: (fn: (tx: unknown) => unknown) => fn({}) }) }));
vi.mock('@/db/tenant', () => ({ withUser: (_s: unknown, fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock('@/domain/opschat/conversations', () => ({
  appendOwnerMessage: h.appendOwnerMessage,
  appendAssistantMessage: h.appendAssistantMessage,
  addProposal: h.addProposal,
  createConversation: h.createConversation,
  conversationExists: h.conversationExists,
  loadReplyForOwnerMessage: h.loadReplyForOwnerMessage,
  loadPromptTurns: h.loadPromptTurns,
  earliestUnansweredOwnerId: h.earliestUnansweredOwnerId,
}));
vi.mock('@/domain/opschat/turn-claim', () => ({ tryClaimTurn: h.tryClaimTurn, tryClaimConversation: h.tryClaimConversation }));
vi.mock('@/lib/env.server', () => ({ serverEnv: () => ({ RATE_LIMIT_RUNS_PER_MINUTE: 10 }) }));
vi.mock('@/lib/log', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
// Tiny server deadline so real timers fire fast; same message as production.
// NB: the factory is hoisted above module consts — the message is inlined here
// (it must equal TIMEOUT_MSG below, which assertions use).
vi.mock('@/domain/opschat/limits', () => ({
  OPS_CHAT_SERVER_DEADLINE_MS: 40,
  OPS_CHAT_TIMEOUT_MESSAGE: 'The AI request timed out. Nothing was changed. Try again.',
  OPS_CHAT_CLIENT_TIMEOUT_MS: 120_000,
  OPS_CHAT_MAX_PROMPT_TURNS: 8,
  OPS_CHAT_PERSIST_FAILED_MESSAGE: 'The reply could not be saved. Nothing was changed — try again.',
  OPS_CHAT_TURN_IN_PROGRESS_MESSAGE: 'This message is already being answered. Reload in a moment to see the reply.',
  OPS_CHAT_CONVERSATION_BUSY_MESSAGE: 'Another message in this conversation is still being answered. Try again in a moment.',
  OPS_CHAT_INTERRUPTED_REPLAY_MESSAGE: 'This reply was interrupted. Send a new message to continue.',
}));

import { POST } from '@/app/api/ops-chat/route';

const CONV = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';

function call(body: Record<string, unknown>): Promise<Response> {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } };
  // conversationId + turnId are now required; inject stable defaults unless the test overrides them.
  init.body = JSON.stringify({ conversationId: CONV, turnId: TURN, ...body });
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
  h.createConversation.mockResolvedValue({ id: 'conv1' });
  h.conversationExists.mockResolvedValue(true);
  h.appendOwnerMessage.mockResolvedValue({ id: 'owner1', seq: 1n, inserted: true });
  h.loadReplyForOwnerMessage.mockResolvedValue(null);
  h.loadPromptTurns.mockResolvedValue([{ role: 'user', content: 'hi' }]);
  h.earliestUnansweredOwnerId.mockResolvedValue('owner1');
  h.appendAssistantMessage.mockResolvedValue({ id: 'asst1', seq: 2n });
  h.addProposal.mockResolvedValue({ id: 'prop1' });
  h.release.mockResolvedValue(undefined);
  h.convRelease.mockResolvedValue(undefined);
  h.tryClaimTurn.mockResolvedValue({ claimed: true, release: h.release });
  h.tryClaimConversation.mockResolvedValue({ claimed: true, release: h.convRelease });
});

describe('POST /api/ops-chat — overall deadline', () => {
  it('never-ending stream → clean timeout error + stream closes (no indefinite Thinking)', async () => {
    h.streamWithTools.mockImplementation(stalling([{ kind: 'delta', text: 'working' }]));
    const text = await (await call({ message: 'hi' })).text();
    expect(text).toContain('event: error');
    expect(text).toContain(TIMEOUT_MSG);
    expect(text).not.toContain('event: done');
    expect(h.release).toHaveBeenCalledTimes(1); // claim released in finally on timeout
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
    expect(h.release).toHaveBeenCalledTimes(1); // claim released in finally on provider failure
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
