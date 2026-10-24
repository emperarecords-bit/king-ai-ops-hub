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
  listRunStartingCards: vi.fn(),
  previousOwnerMessageAt: vi.fn(),
  loadLinkedRunViews: vi.fn(),
  tenantForUser: vi.fn(),
}));

vi.mock('@/domain/auth/guard', () => ({
  requireUser: h.requireUser,
  listMyProjectsWithOrgRoles: h.listMyProjectsWithOrgRoles,
  tenantForUser: h.tenantForUser,
}));
vi.mock('@/domain/opschat/linked-runs', () => ({ loadLinkedRunViews: h.loadLinkedRunViews }));
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
  listRunStartingCards: h.listRunStartingCards,
  previousOwnerMessageAt: h.previousOwnerMessageAt,
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
  h.listRunStartingCards.mockResolvedValue([]);
  h.previousOwnerMessageAt.mockResolvedValue(null);
  h.loadLinkedRunViews.mockResolvedValue(new Map());
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

  // Hub prod 2026-10-23: a pasted Claude conversation was cut off at the old 4,000-char limit (stored at 3,999).
  it('a long pasted message (30,000 chars) is accepted whole; 30,001 is refused before any model call', async () => {
    h.streamWithTools.mockImplementation(async function* () {
      yield { kind: 'delta', text: 'ok' };
      yield { kind: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
    });
    const ok = await call({ message: 'x'.repeat(30_000), conversationId: CONV, turnId: TURN });
    expect(ok.status).toBe(200);
    await ok.text();
    h.streamWithTools.mockClear();
    const tooLong = await call({ message: 'x'.repeat(30_001), conversationId: CONV, turnId: TURN });
    expect(tooLong.status).toBe(400);
    expect(h.streamWithTools).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops-chat — P5a linked runs in the prompt (best-effort)', () => {
  it('the linked-run views for the conversation confirmed cards reach loadPromptTurns', async () => {
    const cards = [{ id: 'card1', kind: 'dispatch_task', state: 'done', proposal: { projectKey: 'hvac' } }];
    const views = new Map([['card1', { taskId: 't1', runId: 'r1', state: 'ready', finishedAt: '2026-10-20T10:42:00.000Z', text: 'Finished.' }]]);
    h.listRunStartingCards.mockResolvedValue(cards);
    h.loadLinkedRunViews.mockResolvedValue(views);
    const text = await (await call({ message: 'what needs me', conversationId: CONV, turnId: TURN })).text();
    expect(text).toContain('event: done');
    expect(h.listRunStartingCards).toHaveBeenCalledWith(expect.anything(), 'u1', CONV);
    expect(h.loadLinkedRunViews).toHaveBeenCalledWith(cards, expect.any(Function));
    expect(h.loadPromptTurns).toHaveBeenCalledWith(expect.anything(), 'u1', CONV, 'owner1', expect.objectContaining({ linkedRuns: views }));
  });

  it('a lookup failure (sync or async) never fails the turn — the prompt just has no run lines', async () => {
    for (const fail of [() => h.listRunStartingCards.mockImplementation(() => { throw new Error('sync boom'); }), () => h.loadLinkedRunViews.mockRejectedValue(new Error('db down'))]) {
      vi.clearAllMocks();
      h.listRunStartingCards.mockResolvedValue([]);
      fail();
      const text = await (await call({ message: 'what needs me', conversationId: CONV, turnId: TURN })).text();
      expect(text).toContain('event: done');
      expect(text).not.toContain('event: error');
      const opts = h.loadPromptTurns.mock.calls.at(-1)![4] as { linkedRuns: Map<string, unknown> };
      expect(opts.linkedRuns.size).toBe(0);
    }
  });
});

describe('POST /api/ops-chat — P5c-3 "THIS CONVERSATION" section in the system prompt', () => {
  const cards = [{ id: 'card1', kind: 'dispatch_task', state: 'done', proposal: { projectKey: 'hvac', title: 'Duct sizing' } }];
  const views = new Map([
    ['card1', { taskId: 't1', runId: 'r1', state: 'running', finishedAt: null, activeAt: '2026-10-20T10:42:00.000Z', text: 'Running now (started 2026-10-20 10:42 UTC).' }],
  ]);

  it('names the ACTIVE JOB and the follow-up rule, so "any response?" resolves to it', async () => {
    h.listRunStartingCards.mockResolvedValue(cards);
    h.loadLinkedRunViews.mockResolvedValue(views);
    const text = await (await call({ message: 'any response?', conversationId: CONV, turnId: TURN })).text();
    expect(text).toContain('event: done');
    const system = (h.streamWithTools.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain('=== THIS CONVERSATION');
    expect(system).toContain('ACTIVE JOB: dispatch "Duct sizing" — task t1 in workspace hvac');
    expect(system).toContain('RULE: a short follow-up that names no task');
  });

  it('a failure building the section never removes the card lines and never fails the turn', async () => {
    h.listRunStartingCards.mockResolvedValue(cards);
    h.loadLinkedRunViews.mockResolvedValue(views);
    h.previousOwnerMessageAt.mockRejectedValue(new Error('db down'));
    const text = await (await call({ message: 'any response?', conversationId: CONV, turnId: TURN })).text();
    expect(text).toContain('event: done');
    expect((h.streamWithTools.mock.calls[0]![0] as { system: string }).system).not.toContain('THIS CONVERSATION');
    expect(h.loadPromptTurns).toHaveBeenCalledWith(expect.anything(), 'u1', CONV, 'owner1', expect.objectContaining({ linkedRuns: views }));
  });

  it('no job started from this conversation → no section at all', async () => {
    await (await call({ message: 'hello', conversationId: CONV, turnId: TURN })).text();
    expect((h.streamWithTools.mock.calls[0]![0] as { system: string }).system).not.toContain('THIS CONVERSATION');
  });

  it('regression (prod 2026-10-22): the system prompt says PREPARE the update card in the same reply — never ask first, never a plain dispatch/re-run', async () => {
    await (await call({ message: 'server cooling?', conversationId: CONV, turnId: TURN })).text();
    const system = (h.streamWithTools.mock.calls[0]![0] as { system: string }).system;
    expect(system).toContain('in the SAME reply call propose_update_task to PREPARE ONE update card');
    expect(system).toContain('never ask "want me to dispatch / prepare a fresh run?" first');
    expect(system).toContain('Never redo stale work with propose_dispatch_task or propose_rerun_task.');
    expect(system).not.toContain('offer ONE update card');
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

  // End-to-end FIFO scenario through the route, against a small in-memory model of the store and
  // the conversation lock: A executes; B and C persist while A runs and both fail the conversation
  // claim; A completes; C retries BEFORE B and is still refused; only after B reaches a terminal
  // reply (complete OR interrupted) may C execute.
  for (const bOutcome of ['complete', 'interrupted'] as const) {
    it(`FIFO scenario — C retrying before B is refused until B is terminal (B ${bOutcome})`, async () => {
      const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      const owners: string[] = []; // persisted owner order (seq)
      const replies = new Map<string, string>(); // ownerId -> terminal reply status
      const providerRuns: string[] = []; // owner turns that reached the provider, in order
      let convHeld = false;

      h.appendOwnerMessage.mockImplementation(async (_tx: unknown, _u: string, args: { id: string }) => {
        const inserted = !owners.includes(args.id);
        if (inserted) owners.push(args.id);
        return { id: args.id, seq: BigInt(owners.indexOf(args.id) + 1), inserted };
      });
      h.loadReplyForOwnerMessage.mockImplementation(async () => null);
      h.earliestUnansweredOwnerId.mockImplementation(async () => owners.find((o) => !replies.has(o)) ?? null);
      h.appendAssistantMessage.mockImplementation(async (_tx: unknown, _u: string, args: { replyToMessageId: string; status?: string }) => {
        replies.set(args.replyToMessageId, args.status ?? 'complete');
        return { id: `asst-${args.replyToMessageId}`, seq: 99n };
      });
      h.tryClaimConversation.mockImplementation(async () => {
        if (convHeld) return { claimed: false, release: h.convRelease };
        convHeld = true;
        return {
          claimed: true,
          release: async () => {
            await h.convRelease();
            convHeld = false;
          },
        };
      });

      let unblockA!: () => void;
      const aGate = new Promise<void>((r) => (unblockA = r));
      let aStarted!: () => void;
      const aRunning = new Promise<void>((r) => (aStarted = r));
      h.streamWithTools.mockImplementation(() => {
        const turn = owners.find((o) => !replies.has(o))!; // the FIFO gate guarantees this is the runner
        providerRuns.push(turn);
        let n = 0;
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => {
              if (turn === A && n === 0) {
                aStarted();
                await aGate;
              }
              if (turn === B && bOutcome === 'interrupted' && n === 1) throw new Error('provider boom');
              const step = n++;
              if (step === 0) return { done: false, value: { kind: 'delta', text: `ans ${turn}` } };
              if (step === 1) return { done: false, value: { kind: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' } };
              return { done: true, value: undefined };
            },
          }),
        };
      });

      const send = async (turnId: string) => parseSse(await (await call({ message: `msg ${turnId}`, conversationId: CONV, turnId })).text());
      const errorOf = (events: Array<{ event: string; data: Record<string, unknown> | undefined }>) =>
        String(events.find((e) => e.event === 'error')?.data?.message ?? '');

      // A is executing (holds the conversation lock, blocked inside the provider).
      const aDone = send(A);
      await aRunning;

      // B and C persist while A runs; both fail the conversation claim — no spend.
      expect(errorOf(await send(B))).toContain('still being answered');
      expect(errorOf(await send(C))).toContain('still being answered');
      expect(owners).toEqual([A, B, C]);
      expect(providerRuns).toEqual([A]);

      // A completes and releases.
      unblockA();
      await aDone;
      expect(replies.get(A)).toBe('complete');
      expect(convHeld).toBe(false);

      // C retries BEFORE B: refused by the FIFO gate (B is earlier and unanswered); provider not called.
      const spendBefore = h.consumeRateLimit.mock.calls.length;
      expect(errorOf(await send(C))).toContain('earlier message');
      expect(providerRuns).toEqual([A]);
      expect(h.consumeRateLimit.mock.calls.length).toBe(spendBefore); // refused before the spend gate
      expect(replies.has(C)).toBe(false);
      expect(owners).toEqual([A, B, C]); // C's owner row stays persisted for a later retry

      // B executes and reaches a terminal reply.
      await send(B);
      expect(replies.get(B)).toBe(bOutcome);

      // Now C may execute.
      const cEvents = await send(C);
      expect(cEvents.some((e) => e.event === 'done')).toBe(true);
      expect(replies.get(C)).toBe('complete');
      expect(providerRuns).toEqual([A, B, C]);
      expect(convHeld).toBe(false);
    });
  }

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

describe('POST /api/ops-chat — a completed turn never ends silently after a tool', () => {
  const persistedText = (): string => {
    const args = h.appendAssistantMessage.mock.calls.at(-1) ?? [];
    return JSON.stringify(args);
  };

  it('"let me try…" + a tool + nothing after → an honest closing line is streamed AND persisted', async () => {
    h.getProposals.mockReturnValue([]);
    h.streamWithTools.mockImplementation(async function* () {
      yield { kind: 'delta', text: 'Let me try preparing the send card anyway.' };
      yield { kind: 'tool_start', name: 'propose_accuratebids_send' };
      yield { kind: 'tool_end', name: 'propose_accuratebids_send', ok: true };
      yield { kind: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
    });
    const text = await (await call({ message: 'send it', conversationId: CONV, turnId: TURN })).text();
    expect(text).toContain("I couldn't finish that step, and nothing was created or sent.");
    expect(text).toContain('event: done');
    expect(persistedText()).toContain("I couldn't finish that step");
  });

  it('when the turn DID prepare a card, the closing line points at it instead', async () => {
    h.streamWithTools.mockImplementation(async function* () {
      yield { kind: 'tool_start', name: 'propose_accuratebids_send' };
      yield { kind: 'tool_end', name: 'propose_accuratebids_send', ok: true };
      yield { kind: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
    });
    const text = await (await call({ message: 'send it', conversationId: CONV, turnId: TURN })).text();
    expect(text).toContain('nothing happens until you click Confirm');
  });

  it('words after the last tool → no closing line is added', async () => {
    h.streamWithTools.mockImplementation(async function* () {
      yield { kind: 'tool_start', name: 'list_tasks' };
      yield { kind: 'tool_end', name: 'list_tasks', ok: true };
      yield { kind: 'delta', text: 'You have 3 open tasks.' };
      yield { kind: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
    });
    const text = await (await call({ message: 'what needs me', conversationId: CONV, turnId: TURN })).text();
    expect(text).not.toContain("couldn't finish that step");
    expect(text).not.toContain('nothing happens until you click Confirm');
  });

  // Hub prod 2026-10-23: three "couldn't finish that step" replies were really the model running out of output room.
  it('a turn that ran out of output room says so — not "couldn\'t finish that step" — and is persisted that way', async () => {
    h.getProposals.mockReturnValue([]);
    h.streamWithTools.mockImplementation(async function* () {
      yield { kind: 'done', usage: { inputTokens: 9, outputTokens: 24_000 }, stopReason: 'max_tokens', cutOff: true, roomRetried: true };
    });
    const text = await (await call({ message: 'do all 3', conversationId: CONV, turnId: TURN })).text();
    expect(text).toContain('My reply ran out of room before I could write it. Nothing was created or sent.');
    expect(text).not.toContain("couldn't finish that step");
    expect(text).toContain('event: done');
    expect(persistedText()).toContain('ran out of room');
  });

  it('cut off after words were shown → the words stay and the note says it ran out of room', async () => {
    h.getProposals.mockReturnValue([]);
    h.streamWithTools.mockImplementation(async function* () {
      yield { kind: 'delta', text: 'Here are the first two decisions…' };
      yield { kind: 'done', usage: { inputTokens: 9, outputTokens: 8_000 }, stopReason: 'max_tokens', cutOff: true, roomRetried: false };
    });
    const text = await (await call({ message: 'do all 3', conversationId: CONV, turnId: TURN })).text();
    expect(text).toContain('Here are the first two decisions…');
    expect(text).toContain('My reply ran out of room before I finished.');
  });

  it('every Ops Chat model call gets the larger output room', async () => {
    h.streamWithTools.mockImplementation(async function* () {
      yield { kind: 'delta', text: 'ok' };
      yield { kind: 'done', usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'end_turn' };
    });
    await (await call({ message: 'hi', conversationId: CONV, turnId: TURN })).text();
    const req = h.streamWithTools.mock.calls.at(-1)?.[0] as { maxOutputTokens?: number };
    expect(req.maxOutputTokens).toBe(8_000);
  });
});

describe('POST /api/ops-chat — current AccurateBids capabilities are stated at turn start', () => {
  const systemOfLastCall = (): string => {
    const req = h.streamWithTools.mock.calls.at(-1)?.[0] as { system?: string } | undefined;
    return req?.system ?? '';
  };
  const ENV_KEYS = ['ACCURATEBIDS_SIGHT_PROJECT_KEYS', 'ACCURATEBIDS_SERVICE_TOKEN', 'ACCURATEBIDS_SEND_URL', 'ACCURATEBIDS_INVOICE_URL', 'ACCURATEBIDS_QUOTE_URL'] as const;

  it('a connected, send-configured release tells the model on the FIRST turn that an owner-given email is supported', async () => {
    const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    Object.assign(process.env, {
      ACCURATEBIDS_SIGHT_PROJECT_KEYS: 'empera',
      ACCURATEBIDS_SERVICE_TOKEN: 't',
      ACCURATEBIDS_SEND_URL: 'https://x/functions/v1/hub-send',
      ACCURATEBIDS_INVOICE_URL: 'https://x/functions/v1/hub-invoice',
      ACCURATEBIDS_QUOTE_URL: 'https://x/functions/v1/hub-quote',
    });
    try {
      await (await call({ message: 'email INV-1 to joe@example.com', conversationId: CONV, turnId: TURN })).text();
      const system = systemOfLastCall();
      expect(system).toContain('=== ACCURATEBIDS CAPABILITIES');
      expect(system).toMatch(/Invoice with NO email on file \(has_email false\): SUPPORTED/);
      expect(system).toMatch(/out of date/);
      // Stated before the live snapshot, alongside the standing rules.
      expect(system.indexOf('=== ACCURATEBIDS CAPABILITIES')).toBeLessThan(system.indexOf('=== LIVE HUB SNAPSHOT'));
    } finally {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('no AccurateBids workspace configured → no capabilities block', async () => {
    const saved = process.env.ACCURATEBIDS_SIGHT_PROJECT_KEYS;
    delete process.env.ACCURATEBIDS_SIGHT_PROJECT_KEYS;
    try {
      await (await call({ message: 'hi', conversationId: CONV, turnId: TURN })).text();
      expect(systemOfLastCall()).not.toContain('ACCURATEBIDS CAPABILITIES');
    } finally {
      if (saved !== undefined) process.env.ACCURATEBIDS_SIGHT_PROJECT_KEYS = saved;
    }
  });
});
