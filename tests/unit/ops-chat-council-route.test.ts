import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, RateLimitedError, UnauthenticatedError } from '@/lib/errors';

/**
 * POST /api/ops-chat/council — the owner-triggered review endpoint. Fully mocked:
 * no real auth, DB, or provider. Asserts the auth gate, server-side scope
 * re-resolution (cross-tenant key rejected), the owner-scoped rate-limit spend
 * gate (consumed BEFORE Council runs), safe-unavailable mapping, and that Council
 * is reached only on a valid, scope-checked, rate-limit-passing request.
 */

const h = vi.hoisted(() => {
  class CouncilUnavailableError extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'CouncilUnavailableError';
    }
  }
  return {
    requireUser: vi.fn(),
    requireTenant: vi.fn(),
    listMyProjectsWithOrgRoles: vi.fn(),
    buildPulse: vi.fn(),
    consumeRateLimit: vi.fn(),
    runCouncil: vi.fn(),
    CouncilUnavailableError,
  };
});

vi.mock('@/domain/auth/guard', () => ({
  requireUser: h.requireUser,
  requireTenant: h.requireTenant,
  listMyProjectsWithOrgRoles: h.listMyProjectsWithOrgRoles,
}));
vi.mock('@/domain/opschat/pulse', () => ({ buildPulse: h.buildPulse, pulseContext: () => 'CTX' }));
vi.mock('@/domain/opschat/council', () => ({
  runCouncil: h.runCouncil,
  CouncilUnavailableError: h.CouncilUnavailableError,
  COUNCIL_MAX_QUESTION_CHARS: 4000,
  COUNCIL_MAX_ANSWER_CHARS: 12_000,
}));
vi.mock('@/domain/usage/rate-limit', () => ({ consumeRateLimit: h.consumeRateLimit }));
vi.mock('@/db/client', () => ({ getDb: () => ({ transaction: (fn: (tx: unknown) => unknown) => fn({}) }) }));
vi.mock('@/lib/env.server', () => ({ serverEnv: () => ({ RATE_LIMIT_RUNS_PER_MINUTE: 10 }) }));
vi.mock('@/lib/log', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import { POST } from '@/app/api/ops-chat/council/route';

const GOOD = { message: 'How is AccurateBids?', answer: 'It is healthy.' };

function call(body: unknown): Promise<Response> {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } };
  init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return POST(new Request('http://localhost/api/ops-chat/council', init));
}

const COUNCIL_RESULT = {
  synthesis: {
    agreement: ['supported'],
    disagreements: [],
    recommendation: 'Proceed.',
    risks: [],
    confidence: 'high',
    ownerDecisionNeeded: [],
  },
  reviewers: [],
  degraded: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: 'u1', email: 'owner@example.com', displayName: 'Owner' });
  h.listMyProjectsWithOrgRoles.mockResolvedValue({
    user: { id: 'u1', email: 'owner@example.com', displayName: 'Owner' },
    projects: [{ projectId: 'p1', orgId: 'o1', key: 'ab', name: 'AccurateBids', description: '', projectRole: 'admin' }],
    orgRoles: new Map([['o1', 'owner']]),
  });
  h.requireTenant.mockResolvedValue({ userId: 'u1', orgId: 'o1', projectId: 'p1', orgRole: 'owner', projectRole: 'admin' });
  h.buildPulse.mockResolvedValue({});
  h.consumeRateLimit.mockResolvedValue(undefined);
  h.runCouncil.mockResolvedValue(COUNCIL_RESULT);
});

describe('POST /api/ops-chat/council — auth gate', () => {
  it('unauthenticated → 401, Council not run, no rate consume', async () => {
    h.requireUser.mockRejectedValue(new UnauthenticatedError());
    const res = await call(GOOD);
    expect(res.status).toBe(401);
    expect(h.runCouncil).not.toHaveBeenCalled();
    expect(h.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('forbidden → 403, Council not run', async () => {
    h.listMyProjectsWithOrgRoles.mockRejectedValue(new ForbiddenError());
    const res = await call(GOOD);
    expect(res.status).toBe(403);
    expect(h.runCouncil).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops-chat/council — input validation', () => {
  it('missing answer → 400, Council not run', async () => {
    const res = await call({ message: 'hi' });
    expect(res.status).toBe(400);
    expect(h.runCouncil).not.toHaveBeenCalled();
  });

  it('empty message → 400', async () => {
    const res = await call({ message: '', answer: 'x' });
    expect(res.status).toBe(400);
    expect(h.runCouncil).not.toHaveBeenCalled();
  });

  it('non-JSON body → 400', async () => {
    const res = await call('not json');
    expect(res.status).toBe(400);
    expect(h.runCouncil).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops-chat/council — server-side scope re-resolution', () => {
  it('rejects a cross-tenant / non-member projectKey (403) and does NOT run Council', async () => {
    h.requireTenant.mockRejectedValue(new ForbiddenError());
    const res = await call({ ...GOOD, projectKey: 'someone-elses-ws' });
    expect(res.status).toBe(403);
    expect(h.requireTenant).toHaveBeenCalledWith('someone-elses-ws');
    expect(h.runCouncil).not.toHaveBeenCalled();
    expect(h.consumeRateLimit).not.toHaveBeenCalled();
  });

  it('a member projectKey is re-resolved server-side and the focus workspace name is used', async () => {
    const res = await call({ ...GOOD, projectKey: 'ab' });
    expect(res.status).toBe(200);
    expect(h.requireTenant).toHaveBeenCalledWith('ab');
    const arg = h.runCouncil.mock.calls[0]![0] as { focusWorkspace?: string; context: string };
    expect(arg.focusWorkspace).toBe('AccurateBids'); // resolved from the authorized project set, not the raw key
    expect(arg.context).toBe('CTX'); // context rebuilt server-side (pulseContext mock)
  });

  it('no projectKey → no tenant resolution, still runs', async () => {
    const res = await call(GOOD);
    expect(res.status).toBe(200);
    expect(h.requireTenant).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops-chat/council — spend / rate-limit boundary', () => {
  it('consumes the owner-scoped council rate limit BEFORE Council runs', async () => {
    await call(GOOD);
    expect(h.consumeRateLimit).toHaveBeenCalledTimes(1);
    const [, scopeKey, limit] = h.consumeRateLimit.mock.calls[0]!;
    expect(scopeKey).toBe('ops-chat-council:user:u1');
    expect(limit).toBe(10);
    // Rate limit precedes the (mocked) Council call.
    expect(h.consumeRateLimit.mock.invocationCallOrder[0]!).toBeLessThan(h.runCouncil.mock.invocationCallOrder[0]!);
  });

  it('rate-limited → 429 and Council not run', async () => {
    h.consumeRateLimit.mockRejectedValue(new RateLimitedError());
    const res = await call(GOOD);
    expect(res.status).toBe(429);
    expect(h.runCouncil).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops-chat/council — results and safe failure', () => {
  it('valid request returns the structured Council result', async () => {
    const res = await call(GOOD);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.synthesis.recommendation).toBe('Proceed.');
    expect(body.synthesis.confidence).toBe('high');
    expect(h.runCouncil).toHaveBeenCalledTimes(1);
    const arg = h.runCouncil.mock.calls[0]![0] as { question: string; primaryAnswer: string };
    expect(arg.question).toBe(GOOD.message);
    expect(arg.primaryAnswer).toBe(GOOD.answer);
  });

  it('CouncilUnavailableError → 503 with its safe message', async () => {
    h.runCouncil.mockRejectedValue(new h.CouncilUnavailableError('Council is unavailable right now.'));
    const res = await call(GOOD);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('Council is unavailable right now.');
  });

  it('an unexpected error → 500 generic', async () => {
    h.runCouncil.mockRejectedValue(new Error('boom'));
    const res = await call(GOOD);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Something went wrong.');
  });
});
