import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnauthenticatedError } from '@/lib/errors';

/**
 * POST /api/ops-chat/confirm — the execute_github_pr action. The GitHub PR bridge writes ONLY here, only for
 * a project admin, only after the owner confirms. Fully mocked — the governed bridge (executeGitHubPrFromOpsChat)
 * is a spy; this proves the route gates admin + validation BEFORE the bridge is ever reached.
 */

const h = vi.hoisted(() => ({
  requireTenant: vi.fn(),
  withTenant: vi.fn(),
  consumeRateLimit: vi.fn(),
  executeGitHubPrFromOpsChat: vi.fn(),
}));

vi.mock('@/domain/auth/guard', () => ({ requireTenant: h.requireTenant }));
vi.mock('@/db/tenant', () => ({ withTenant: h.withTenant }));
vi.mock('@/db/client', () => ({ getDb: () => ({ transaction: (fn: (tx: unknown) => unknown) => fn({}) }) }));
vi.mock('@/domain/usage/rate-limit', () => ({ consumeRateLimit: h.consumeRateLimit }));
vi.mock('@/lib/env.server', () => ({ serverEnv: () => ({ RATE_LIMIT_RUNS_PER_MINUTE: 10 }) }));
vi.mock('@/lib/log', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/domain/questions/questions', () => ({ answerOwnerQuestion: vi.fn() }));
vi.mock('@/domain/approvals/approvals', () => ({ decideApproval: vi.fn() }));
vi.mock('@/domain/execution/execute-on-approval', () => ({ executeApprovedIfEligible: vi.fn() }));
vi.mock('@/domain/tasks/tasks', () => ({ createTask: vi.fn(), getTask: vi.fn() }));
vi.mock('@/domain/jobs/jobs', () => ({ enqueueRun: vi.fn() }));
vi.mock('@/domain/agents/agents', () => ({ listAgents: vi.fn() }));
vi.mock('@/domain/opschat/github-action', () => ({ executeGitHubPrFromOpsChat: h.executeGitHubPrFromOpsChat }));

import { POST } from '@/app/api/ops-chat/confirm/route';

function call(body: unknown): Promise<Response> {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } };
  init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return POST(new Request('http://localhost/api/ops-chat/confirm', init));
}
const ctx = (projectRole: 'admin' | 'member') => ({ userId: 'u1', orgId: 'o1', projectId: 'p-ab', orgRole: 'owner', projectRole });
const GOOD = { action: 'execute_github_pr', projectKey: 'ab', repo: 'o/r', branch: 'hub/x', title: 'T', files: [{ path: 'a.md', content: 'real content' }] };

beforeEach(() => {
  vi.clearAllMocks();
  h.requireTenant.mockResolvedValue(ctx('admin'));
  h.withTenant.mockImplementation((_c: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.consumeRateLimit.mockResolvedValue(undefined);
  h.executeGitHubPrFromOpsChat.mockResolvedValue({ approvalId: 'a1', attempted: true, outcome: 'succeeded', message: 'ok', prUrl: 'https://github.com/o/r/pull/3' });
});

describe('POST /api/ops-chat/confirm — execute_github_pr', () => {
  it('admin + valid → runs the governed bridge and returns provenance', async () => {
    const res = await call(GOOD);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executed.prUrl).toBe('https://github.com/o/r/pull/3');
    expect(h.executeGitHubPrFromOpsChat).toHaveBeenCalledTimes(1);
    const [, input] = h.executeGitHubPrFromOpsChat.mock.calls[0]!;
    expect(input).toMatchObject({ repo: 'o/r', branch: 'hub/x', title: 'T' });
  });

  it('a non-admin is refused (403) and the bridge is never reached', async () => {
    h.requireTenant.mockResolvedValue(ctx('member'));
    const res = await call(GOOD);
    expect(res.status).toBe(403);
    expect(h.executeGitHubPrFromOpsChat).not.toHaveBeenCalled();
  });

  it('a malformed request (no files) → 400, bridge never reached', async () => {
    const res = await call({ ...GOOD, files: [] });
    expect(res.status).toBe(400);
    expect(h.executeGitHubPrFromOpsChat).not.toHaveBeenCalled();
  });

  it('unauthenticated → 401, bridge never reached', async () => {
    h.requireTenant.mockRejectedValue(new UnauthenticatedError());
    const res = await call(GOOD);
    expect(res.status).toBe(401);
    expect(h.executeGitHubPrFromOpsChat).not.toHaveBeenCalled();
  });

  it('forbidden tenant → 403, bridge never reached', async () => {
    h.requireTenant.mockRejectedValue(new ForbiddenError());
    const res = await call(GOOD);
    expect(res.status).toBe(403);
    expect(h.executeGitHubPrFromOpsChat).not.toHaveBeenCalled();
  });
});
