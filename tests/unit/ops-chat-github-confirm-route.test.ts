import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, UnauthenticatedError } from '@/lib/errors';

/**
 * POST /api/ops-chat/confirm — the governed GitHub actions (PR / merge / rerun), PROPOSAL-ID
 * AUTHORITATIVE. The client sends only { proposalId, intent }; the server loads the owner's
 * persisted, immutable proposal and reconstructs + validates the action from THAT payload.
 * Fully mocked — each governed bridge is a spy; this proves the route reconstructs the action
 * from the stored payload and gates admin + validation + CAS BEFORE the bridge is ever reached.
 */

const PROP = '44444444-4444-4444-8444-444444444444';
const CONV = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireTenant: vi.fn(),
  withUser: vi.fn(),
  withTenant: vi.fn(),
  loadProposal: vi.fn(),
  transitionProposal: vi.fn(),
  consumeRateLimit: vi.fn(),
  executeGitHubPrFromOpsChat: vi.fn(),
  executeGitHubMergeFromOpsChat: vi.fn(),
  executeGitHubRerunFromOpsChat: vi.fn(),
  executeGitHubRevertFromOpsChat: vi.fn(),
}));

vi.mock('@/domain/auth/guard', () => ({ requireUser: h.requireUser, requireTenant: h.requireTenant }));
vi.mock('@/db/tenant', () => ({ withUser: h.withUser, withTenant: h.withTenant }));
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
vi.mock('@/domain/opschat/conversations', () => ({ loadProposal: h.loadProposal, transitionProposal: h.transitionProposal }));
vi.mock('@/domain/opschat/github-action', () => ({
  executeGitHubPrFromOpsChat: h.executeGitHubPrFromOpsChat,
  executeGitHubMergeFromOpsChat: h.executeGitHubMergeFromOpsChat,
  executeGitHubRerunFromOpsChat: h.executeGitHubRerunFromOpsChat,
  executeGitHubRevertFromOpsChat: h.executeGitHubRevertFromOpsChat,
}));
vi.mock('@/domain/opschat/supabase-action', () => ({ executeSupabaseDeployFromOpsChat: vi.fn() }));
vi.mock('@/domain/opschat/vercel-action', () => ({ executeVercelMutationFromOpsChat: vi.fn() }));

import { POST } from '@/app/api/ops-chat/confirm/route';

function call(body: unknown): Promise<Response> {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } };
  init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return POST(new Request('http://localhost/api/ops-chat/confirm', init));
}
const ctx = (projectRole: 'admin' | 'member') => ({ userId: 'u1', orgId: 'o1', projectId: 'p-ab', orgRole: 'owner', projectRole });

/** A stored, immutable proposal of the given kind with its payload (display fields the server
 *  ignores are included to mirror what the toolset persists). `over` mutates the payload. */
function stored(kind: string, proposal: Record<string, unknown>) {
  return { id: PROP, conversationId: CONV, messageId: MSG, kind, state: 'pending' as const, proposal: { kind, ...proposal } };
}
const PR_PAYLOAD = { projectKey: 'ab', workspaceName: 'W', repo: 'o/r', branch: 'hub/x', baseBranch: 'main', title: 'T', body: '', riskClass: 'external_reversible', files: [{ path: 'a.md', content: 'real content' }] };
const MERGE_PAYLOAD = { projectKey: 'ab', workspaceName: 'W', repo: 'o/r', prNumber: 7, expectedHeadSha: 'a'.repeat(40), expectedBaseBranch: 'main', mergeMethod: 'squash', riskClass: 'external_reversible' };
const RERUN_PAYLOAD = { projectKey: 'ab', workspaceName: 'W', repo: 'o/r', runId: 99, expectedHeadSha: 'a'.repeat(40), expectedRunAttempt: 1, riskClass: 'external_reversible' };
const CONFIRM = { proposalId: PROP, intent: 'confirm' };

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: 'u1', email: 'o@e.com', displayName: 'Owner' });
  h.requireTenant.mockResolvedValue(ctx('admin'));
  h.withUser.mockImplementation((_s: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.withTenant.mockImplementation((_c: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.consumeRateLimit.mockResolvedValue(undefined);
  h.transitionProposal.mockImplementation((_tx: unknown, _uid: unknown, args: { proposalId: string; to: string }) =>
    Promise.resolve({ id: args.proposalId, state: args.to }),
  );
  h.loadProposal.mockResolvedValue(stored('github_pr', PR_PAYLOAD));
  h.executeGitHubPrFromOpsChat.mockResolvedValue({ approvalId: 'a1', attempted: true, outcome: 'succeeded', message: 'ok', prUrl: 'https://github.com/o/r/pull/3' });
  h.executeGitHubMergeFromOpsChat.mockResolvedValue({ approvalId: 'a2', attempted: true, outcome: 'succeeded', message: 'merged', prUrl: 'https://github.com/o/r/pull/7', mergeCommitSha: 'c'.repeat(40) });
  h.executeGitHubRerunFromOpsChat.mockResolvedValue({ approvalId: 'a3', attempted: true, outcome: 'succeeded', message: 'rerun', runId: 99, attempt: 2, state: 'in_progress', runUrl: 'https://github.com/o/r/actions/runs/99' });
});

describe('POST /api/ops-chat/confirm — github_pr', () => {
  it('admin + valid stored payload → runs the governed bridge and returns provenance', async () => {
    const res = await call(CONFIRM);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executed.prUrl).toBe('https://github.com/o/r/pull/3');
    expect(body.state).toBe('done');
    expect(h.executeGitHubPrFromOpsChat).toHaveBeenCalledTimes(1);
    const [, input] = h.executeGitHubPrFromOpsChat.mock.calls[0]!;
    expect(input).toMatchObject({ repo: 'o/r', branch: 'hub/x', title: 'T' });
  });

  it('a non-admin is refused (403) and the bridge is never reached', async () => {
    h.requireTenant.mockResolvedValue(ctx('member'));
    const res = await call(CONFIRM);
    expect(res.status).toBe(403);
    expect(h.executeGitHubPrFromOpsChat).not.toHaveBeenCalled();
  });

  it('a stored payload that no longer validates (no files) → 400, bridge never reached', async () => {
    h.loadProposal.mockResolvedValue(stored('github_pr', { ...PR_PAYLOAD, files: [] }));
    const res = await call(CONFIRM);
    expect(res.status).toBe(400);
    expect(h.executeGitHubPrFromOpsChat).not.toHaveBeenCalled();
  });

  it('unauthenticated → 401, bridge never reached', async () => {
    h.requireUser.mockRejectedValue(new UnauthenticatedError());
    const res = await call(CONFIRM);
    expect(res.status).toBe(401);
    expect(h.executeGitHubPrFromOpsChat).not.toHaveBeenCalled();
  });

  it('forbidden tenant → 403, bridge never reached', async () => {
    h.requireTenant.mockRejectedValue(new ForbiddenError());
    const res = await call(CONFIRM);
    expect(res.status).toBe(403);
    expect(h.executeGitHubPrFromOpsChat).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops-chat/confirm — github_merge', () => {
  beforeEach(() => h.loadProposal.mockResolvedValue(stored('github_merge', MERGE_PAYLOAD)));

  it('admin + valid → runs the merge bridge and returns the merge commit SHA', async () => {
    const res = await call(CONFIRM);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executed.mergeCommitSha).toBe('c'.repeat(40));
    const [, input] = h.executeGitHubMergeFromOpsChat.mock.calls[0]!;
    expect(input).toMatchObject({ repo: 'o/r', prNumber: 7, expectedHeadSha: 'a'.repeat(40), expectedBaseBranch: 'main' });
  });

  it('a non-admin is refused (403) and the merge bridge is never reached', async () => {
    h.requireTenant.mockResolvedValue(ctx('member'));
    const res = await call(CONFIRM);
    expect(res.status).toBe(403);
    expect(h.executeGitHubMergeFromOpsChat).not.toHaveBeenCalled();
  });

  it('a stored malformed head SHA → 400, bridge never reached', async () => {
    h.loadProposal.mockResolvedValue(stored('github_merge', { ...MERGE_PAYLOAD, expectedHeadSha: 'not-a-sha' }));
    const res = await call(CONFIRM);
    expect(res.status).toBe(400);
    expect(h.executeGitHubMergeFromOpsChat).not.toHaveBeenCalled();
  });
});

describe('POST /api/ops-chat/confirm — github_rerun', () => {
  beforeEach(() => h.loadProposal.mockResolvedValue(stored('github_rerun', RERUN_PAYLOAD)));

  it('admin + valid → runs the rerun bridge and returns run state', async () => {
    const res = await call(CONFIRM);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.executed.runId).toBe(99);
    expect(body.executed.state).toBe('in_progress');
    const [, input] = h.executeGitHubRerunFromOpsChat.mock.calls[0]!;
    expect(input).toMatchObject({ repo: 'o/r', runId: 99, expectedRunAttempt: 1 });
  });

  it('a non-admin is refused (403) and the rerun bridge is never reached', async () => {
    h.requireTenant.mockResolvedValue(ctx('member'));
    const res = await call(CONFIRM);
    expect(res.status).toBe(403);
    expect(h.executeGitHubRerunFromOpsChat).not.toHaveBeenCalled();
  });

  it('a stored payload missing the run attempt → 400, bridge never reached', async () => {
    const { expectedRunAttempt: _omit, ...bad } = RERUN_PAYLOAD;
    h.loadProposal.mockResolvedValue(stored('github_rerun', bad));
    const res = await call(CONFIRM);
    expect(res.status).toBe(400);
    expect(h.executeGitHubRerunFromOpsChat).not.toHaveBeenCalled();
  });
});
