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
  // persistence (PR 2) — mocked so this suite stays a fast, DB-free gate/stream-shape test.
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
  // persistence defaults: a fresh conversation, a first-insert owner turn, no prior reply
  // (so the model runs), and a claimed turn.
  h.createConversation.mockResolvedValue({ id: 'conv1' });
  h.conversationExists.mockResolvedValue(true);
  h.appendOwnerMessage.mockResolvedValue({ id: 'owner1', seq: 1n, inserted: true });
  h.loadReplyForOwnerMessage.mockResolvedValue(null);
  h.loadPromptTurns.mockResolvedValue([{ role: 'user', content: 'what needs me' }]);
  h.earliestUnansweredOwnerId.mockResolvedValue('owner1'); // this turn IS next in order → proceeds
  h.appendAssistantMessage.mockResolvedValue({ id: 'asst1', seq: 2n });
  h.addProposal.mockResolvedValue({ id: 'prop1' });
  h.release.mockResolvedValue(undefined);
  h.convRelease.mockResolvedValue(undefined);
  h.tryClaimTurn.mockResolvedValue({ claimed: true, release: h.release });
  h.tryClaimConversation.mockResolvedValue({ claimed: true, release: h.convRelease });
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
    const res = await call({ message: 'what needs me', conversationId: CONV, turnId: TURN });
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

  it('consumes the owner-scoped rate limit before the model call, but only in the run branch', async () => {
    await (await call({ message: 'what needs me', conversationId: CONV, turnId: TURN })).text();
    expect(h.consumeRateLimit).toHaveBeenCalledTimes(1);
    const [, scopeKey, limit] = h.consumeRateLimit.mock.calls[0]!;
    expect(scopeKey).toBe('ops-chat:user:u1');
    expect(limit).toBe(10);
    // spend gate runs AFTER the owner message is persisted (owner-first) and after the claim.
    expect(h.appendOwnerMessage.mock.invocationCallOrder[0]!).toBeLessThan(h.consumeRateLimit.mock.invocationCallOrder[0]!);
    expect(h.consumeRateLimit.mock.invocationCallOrder[0]!).toBeLessThan(h.streamWithTools.mock.invocationCallOrder[0]!);
  });

  it('rate-limited → in-stream error (stream already open), no model call, claim released', async () => {
    h.consumeRateLimit.mockRejectedValue(new RateLimitedError());
    const res = await call({ message: 'what needs me', conversationId: CONV, turnId: TURN });
    expect(res.status).toBe(200); // the spend gate now lives inside the opened stream
    const events = parseSse(await res.text());
    expect(events.some((e) => e.event === 'error')).toBe(true);
    expect(events.some((e) => e.event === 'saved' || e.event === 'done')).toBe(false);
    expect(h.streamWithTools).not.toHaveBeenCalled();
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});

/** event/data pairs from an SSE response body. */
function parseSse(text: string): Array<{ event: string; data: Record<string, unknown> | undefined }> {
  const out: Array<{ event: string; data: Record<string, unknown> | undefined }> = [];
  for (const block of text.split('\n\n')) {
    let event: string | undefined;
    let data: string | undefined;
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (event) out.push({ event, data: data ? JSON.parse(data) : undefined });
  }
  return out;
}

const CONV = '11111111-1111-4111-8111-111111111111';
const TURN = '22222222-2222-4222-8222-222222222222';

describe('POST /api/ops-chat — persistence turn protocol (PR 2)', () => {
  it('owner commits BEFORE the provider; reply links to the owner turn; proposals correlate via `saved` (after proposal, before done); claim released', async () => {
    const events = parseSse(await (await call({ message: 'what needs me', conversationId: CONV, turnId: TURN })).text());

    // point 1 — owner message persisted before any provider call.
    expect(h.appendOwnerMessage.mock.invocationCallOrder[0]!).toBeLessThan(h.streamWithTools.mock.invocationCallOrder[0]!);
    expect(h.appendOwnerMessage).toHaveBeenCalledWith(expect.anything(), 'u1', expect.objectContaining({ conversationId: CONV, content: 'what needs me', id: TURN }));

    // point 4 — the completed reply is explicitly linked to the owner turn.
    expect(h.appendAssistantMessage).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ conversationId: CONV, replyToMessageId: 'owner1', status: 'complete' }),
    );

    // point 5 + 8 — assistant + proposals commit, THEN `saved` carries the correlationKey→proposalId map;
    // a proposal card is streamed (with only a correlationKey) and `saved` makes it actionable.
    const order = events.map((e) => e.event);
    expect(order.indexOf('proposal')).toBeLessThan(order.indexOf('saved'));
    expect(order.indexOf('saved')).toBeLessThan(order.indexOf('done'));
    const proposalEv = events.find((e) => e.event === 'proposal')!.data!;
    expect(proposalEv.correlationKey).toBe('k:answer_question');
    const saved = events.find((e) => e.event === 'saved')!.data!;
    expect(saved).toMatchObject({ conversationId: CONV, messageId: 'asst1', status: 'complete', proposals: [{ correlationKey: 'k:answer_question', proposalId: 'prop1' }] });

    // point 3 — BOTH claims (turn + conversation) are released on the success path.
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.convRelease).toHaveBeenCalledTimes(1);
    // the prompt is built turn-aware for THIS owner message (not raw-seq).
    expect(h.loadPromptTurns).toHaveBeenCalledWith(expect.anything(), 'u1', CONV, 'owner1', expect.anything());
  });

  it('serializes per conversation — a busy conversation (different turn running) returns a retry and does NOT run the model', async () => {
    h.tryClaimConversation.mockResolvedValue({ claimed: false, release: h.convRelease });
    h.loadReplyForOwnerMessage.mockResolvedValue(null);
    const events = parseSse(await (await call({ message: 'second tab', conversationId: CONV, turnId: TURN })).text());
    expect(h.streamWithTools).not.toHaveBeenCalled();
    expect(h.consumeRateLimit).not.toHaveBeenCalled(); // conversation claim gates BEFORE the spend gate
    expect(String(events.find((e) => e.event === 'error')!.data!.message)).toContain('still being answered');
    expect(h.release).toHaveBeenCalledTimes(1); // turn claim released
    expect(h.convRelease).toHaveBeenCalledTimes(1); // NOOP conversation release still invoked
  });

  it('enforces FIFO — an earlier unanswered owner turn blocks this one (retry), model not run, both claims released', async () => {
    h.earliestUnansweredOwnerId.mockResolvedValue('ownerEARLIER'); // an older turn is still pending
    const events = parseSse(await (await call({ message: 'third turn', conversationId: CONV, turnId: TURN })).text());
    expect(h.streamWithTools).not.toHaveBeenCalled();
    expect(h.consumeRateLimit).not.toHaveBeenCalled(); // FIFO gate is before the spend gate
    expect(String(events.find((e) => e.event === 'error')!.data!.message)).toContain('earlier message');
    expect(h.release).toHaveBeenCalledTimes(1);
    expect(h.convRelease).toHaveBeenCalledTimes(1);
  });

  it('lock releases are failure-independent — a conversation-release failure still releases the turn claim', async () => {
    h.convRelease.mockRejectedValue(new Error('pg_advisory_unlock failed'));
    await (await call({ message: 'what needs me', conversationId: CONV, turnId: TURN })).text();
    // conversation release threw, but the turn claim was still released (separate reserved session).
    expect(h.convRelease).toHaveBeenCalledTimes(1);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('a conversationId that is not the user\'s is a clean 404 and never calls the model', async () => {
    h.conversationExists.mockResolvedValue(false);
    const res = await call({ message: 'hi', conversationId: CONV, turnId: TURN });
    expect(res.status).toBe(404);
    expect(h.streamWithTools).not.toHaveBeenCalled();
  });

  it('a missing turnId or conversationId → 400 (idempotency ids are mandatory, not a convention)', async () => {
    expect((await call({ message: 'hi', conversationId: CONV })).status).toBe(400); // no turnId
    expect((await call({ message: 'hi', turnId: TURN })).status).toBe(400); // no conversationId
    expect(h.appendOwnerMessage).not.toHaveBeenCalled();
    expect(h.streamWithTools).not.toHaveBeenCalled();
  });

  it('point 6 — a failed persist emits NO `saved`, a retryable error, and still releases the claim', async () => {
    h.appendAssistantMessage.mockRejectedValue(new Error('db unavailable'));
    const events = parseSse(await (await call({ message: 'hi', conversationId: CONV, turnId: TURN })).text());
    expect(events.some((e) => e.event === 'saved')).toBe(false);
    const err = events.find((e) => e.event === 'error')!.data!;
    expect(String(err.message)).toContain('could not be saved');
    expect(events.some((e) => e.event === 'done')).toBe(false);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('point 2 — losing the execution claim with no persisted reply yields an in-progress error and does NOT run the model', async () => {
    h.tryClaimTurn.mockResolvedValue({ claimed: false, release: h.release });
    h.loadReplyForOwnerMessage.mockResolvedValue(null);
    const events = parseSse(await (await call({ message: 'hi', conversationId: CONV, turnId: TURN })).text());
    expect(h.streamWithTools).not.toHaveBeenCalled();
    expect(h.consumeRateLimit).not.toHaveBeenCalled(); // spend gate never reached on claim loss
    expect(String(events.find((e) => e.event === 'error')!.data!.message)).toContain('already being answered');
    expect(h.release).toHaveBeenCalledTimes(1); // NOOP release still invoked in finally
  });

  it('point 7 — an already-persisted reply is replayed EXACTLY (not re-run); provider is never called', async () => {
    h.loadReplyForOwnerMessage.mockResolvedValue({
      conversationId: CONV,
      messageId: 'asstPrior',
      content: 'the prior answer',
      status: 'complete',
      question: 'what needs me',
      proposals: [
        { id: 'propPrior', kind: 'answer_question', proposal: { kind: 'answer_question', questionId: 'q1', projectKey: 'ab', workspaceName: 'W', question: 'x?', answer: 'y' }, state: 'pending', result: null, error: null },
      ],
    });
    const events = parseSse(await (await call({ message: 'what needs me', conversationId: CONV, turnId: TURN })).text());
    expect(h.streamWithTools).not.toHaveBeenCalled();
    expect(h.consumeRateLimit).not.toHaveBeenCalled(); // replay bypasses the spend gate
    expect(h.buildPulse).not.toHaveBeenCalled(); // and the pulse build
    expect(h.appendAssistantMessage).not.toHaveBeenCalled(); // never create a second reply
    expect(events.find((e) => e.event === 'delta')!.data!.text).toBe('the prior answer');
    const saved = events.find((e) => e.event === 'saved')!.data!;
    expect(saved).toMatchObject({ messageId: 'asstPrior', status: 'complete', proposals: [{ correlationKey: 'k:answer_question', proposalId: 'propPrior' }] });
    expect(events.some((e) => e.event === 'done')).toBe(true);
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('replaying an INTERRUPTED reply replays partial text + saved(interrupted, proposals:[]) + error, NEVER done', async () => {
    h.loadReplyForOwnerMessage.mockResolvedValue({
      conversationId: CONV,
      messageId: 'asstPartial',
      content: 'partial thought…',
      status: 'interrupted',
      question: 'what needs me',
      proposals: [], // interrupted turns never persist proposals
    });
    const events = parseSse(await (await call({ message: 'what needs me', conversationId: CONV, turnId: TURN })).text());
    expect(h.streamWithTools).not.toHaveBeenCalled();
    expect(events.find((e) => e.event === 'delta')!.data!.text).toBe('partial thought…');
    const saved = events.find((e) => e.event === 'saved')!.data!;
    expect(saved).toMatchObject({ messageId: 'asstPartial', status: 'interrupted', proposals: [] });
    expect(events.some((e) => e.event === 'done')).toBe(false); // never masquerades as complete
    const err = events.find((e) => e.event === 'error')!.data!;
    expect(String(err.message)).toContain('interrupted');
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it('point 3/6 — a provider failure persists the partial TEXT as interrupted with ZERO proposals, then errors and releases the claim', async () => {
    // Model streams some text, proposes a card, then the provider throws mid-turn.
    h.streamWithTools.mockImplementation(() => ({
      [Symbol.asyncIterator]: () => {
        let n = 0;
        return {
          next: () =>
            n++ === 0
              ? Promise.resolve({ done: false, value: { kind: 'delta', text: 'partial' } })
              : Promise.reject(new Error('provider boom')),
        };
      },
    }));
    const events = parseSse(await (await call({ message: 'hi', conversationId: CONV, turnId: TURN })).text());
    // interrupted reply keeps the partial TEXT...
    expect(h.appendAssistantMessage).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ replyToMessageId: 'owner1', status: 'interrupted', content: 'partial' }),
    );
    // ...but NEVER persists proposals (governed writes only at a successful finalize).
    expect(h.addProposal).not.toHaveBeenCalled();
    expect(events.some((e) => e.event === 'proposal')).toBe(false);
    const saved = events.find((e) => e.event === 'saved')!.data!;
    expect(saved).toMatchObject({ status: 'interrupted', proposals: [] });
    expect(events.some((e) => e.event === 'done')).toBe(false);
    expect(events.some((e) => e.event === 'error')).toBe(true);
    expect(h.release).toHaveBeenCalledTimes(1);
  });
});
