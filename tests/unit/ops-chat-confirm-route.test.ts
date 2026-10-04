import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError, RateLimitedError, UnauthenticatedError } from '@/lib/errors';

/**
 * Ops Chat v2 POST /api/ops-chat/confirm — the ONLY write boundary. Fully
 * mocked: no real auth, DB, provider, or execution. Asserts that every mutation
 * is authenticated, tenant-resolved through the current user, admin-gated, and
 * that a rejected request produces ZERO writes.
 */

const UUID = '11111111-1111-4111-8111-111111111111';

const h = vi.hoisted(() => ({
  requireTenant: vi.fn(),
  withTenant: vi.fn(),
  consumeRateLimit: vi.fn(),
  answerOwnerQuestion: vi.fn(),
  decideApproval: vi.fn(),
  executeApprovedIfEligible: vi.fn(),
  createTask: vi.fn(),
  getTask: vi.fn(),
  enqueueRun: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock('@/domain/auth/guard', () => ({ requireTenant: h.requireTenant }));
vi.mock('@/db/tenant', () => ({ withTenant: h.withTenant }));
vi.mock('@/db/client', () => ({ getDb: () => ({ transaction: (fn: (tx: unknown) => unknown) => fn({}) }) }));
vi.mock('@/domain/usage/rate-limit', () => ({ consumeRateLimit: h.consumeRateLimit }));
vi.mock('@/lib/env.server', () => ({ serverEnv: () => ({ RATE_LIMIT_RUNS_PER_MINUTE: 10 }) }));
vi.mock('@/lib/log', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/domain/questions/questions', () => ({ answerOwnerQuestion: h.answerOwnerQuestion }));
vi.mock('@/domain/approvals/approvals', () => ({ decideApproval: h.decideApproval }));
vi.mock('@/domain/execution/execute-on-approval', () => ({ executeApprovedIfEligible: h.executeApprovedIfEligible }));
vi.mock('@/domain/tasks/tasks', () => ({ createTask: h.createTask, getTask: h.getTask }));
vi.mock('@/domain/jobs/jobs', () => ({ enqueueRun: h.enqueueRun }));
vi.mock('@/domain/agents/agents', () => ({ listAgents: h.listAgents }));

import { POST } from '@/app/api/ops-chat/confirm/route';

function call(body: unknown): Promise<Response> {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } };
  init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return POST(new Request('http://localhost/api/ops-chat/confirm', init));
}

function ctxWithRole(projectRole: 'admin' | 'member') {
  return { userId: 'u1', orgId: 'o1', projectId: 'p-ab', orgRole: 'owner', projectRole };
}

/** No write-domain function was invoked. */
function expectNoWrites() {
  expect(h.answerOwnerQuestion).not.toHaveBeenCalled();
  expect(h.decideApproval).not.toHaveBeenCalled();
  expect(h.createTask).not.toHaveBeenCalled();
  expect(h.enqueueRun).not.toHaveBeenCalled();
  expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireTenant.mockResolvedValue(ctxWithRole('admin'));
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.consumeRateLimit.mockResolvedValue(undefined);
  h.answerOwnerQuestion.mockResolvedValue(undefined);
  h.decideApproval.mockResolvedValue(undefined);
  h.executeApprovedIfEligible.mockResolvedValue({ outcome: 'done', message: null });
  h.createTask.mockResolvedValue('task-123');
  h.getTask.mockResolvedValue({ id: UUID, title: 'T', status: 'completed' });
  h.enqueueRun.mockResolvedValue(undefined);
  h.listAgents.mockResolvedValue([{ id: UUID, name: 'Scout', role: 'researcher', enabled: true, provider: 'anthropic' }]);
});

describe('confirm — auth & validation gates (zero writes on rejection)', () => {
  it('unauthenticated → 401', async () => {
    h.requireTenant.mockRejectedValue(new UnauthenticatedError());
    const res = await call({ action: 'answer_question', projectKey: 'ab', questionId: UUID, answer: 'y' });
    expect(res.status).toBe(401);
    expectNoWrites();
  });

  it('malformed body → 400 (before tenant resolve)', async () => {
    const res = await call({ action: 'answer_question', projectKey: 'ab' }); // missing fields
    expect(res.status).toBe(400);
    expect(h.requireTenant).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('unknown / cross-tenant project → 403', async () => {
    h.requireTenant.mockRejectedValue(new ForbiddenError());
    const res = await call({ action: 'answer_question', projectKey: 'not-mine', questionId: UUID, answer: 'y' });
    expect(res.status).toBe(403);
    expectNoWrites();
  });

  it('rate-limited → 429, zero writes', async () => {
    h.consumeRateLimit.mockRejectedValue(new RateLimitedError());
    const res = await call({ action: 'answer_question', projectKey: 'ab', questionId: UUID, answer: 'y' });
    expect(res.status).toBe(429);
    expectNoWrites();
  });
});

describe('confirm — role enforcement (every action requires admin)', () => {
  it.each([
    { action: 'answer_question', projectKey: 'ab', questionId: UUID, answer: 'y' },
    { action: 'decide_approval', projectKey: 'ab', approvalId: UUID, decision: 'approved' },
    { action: 'dispatch_task', projectKey: 'ab', title: 't', instructions: 'i', agentId: UUID },
    { action: 'rerun_task', projectKey: 'ab', taskId: UUID },
  ])('non-admin → 403 for $action', async (body) => {
    h.requireTenant.mockResolvedValue(ctxWithRole('member'));
    const res = await call(body);
    expect(res.status).toBe(403);
    expectNoWrites();
  });
});

describe('confirm — writes happen only after a valid confirm', () => {
  it('answer_question (admin) calls answerOwnerQuestion exactly once', async () => {
    const res = await call({ action: 'answer_question', projectKey: 'ab', questionId: UUID, answer: 'yes' });
    expect(res.status).toBe(200);
    expect(h.answerOwnerQuestion).toHaveBeenCalledTimes(1);
  });

  it('decide_approval approved → decideApproval + executeApprovedIfEligible', async () => {
    const res = await call({ action: 'decide_approval', projectKey: 'ab', approvalId: UUID, decision: 'approved' });
    expect(res.status).toBe(200);
    expect(h.decideApproval).toHaveBeenCalledTimes(1);
    expect(h.executeApprovedIfEligible).toHaveBeenCalledTimes(1);
  });

  it('decide_approval rejected → decideApproval only, no execution', async () => {
    const res = await call({ action: 'decide_approval', projectKey: 'ab', approvalId: UUID, decision: 'rejected', note: 'no' });
    expect(res.status).toBe(200);
    expect(h.decideApproval).toHaveBeenCalledTimes(1);
    expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
  });

  it('dispatch_task (admin) → createTask + enqueueRun, returns taskId', async () => {
    const res = await call({ action: 'dispatch_task', projectKey: 'ab', title: 'Research', instructions: 'go', agentId: UUID });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, taskId: 'task-123' });
    expect(h.createTask).toHaveBeenCalledTimes(1);
    expect(h.enqueueRun).toHaveBeenCalledTimes(1);
  });

  it('dispatch_task with an unavailable agent → 409, no writes', async () => {
    h.listAgents.mockResolvedValue([]); // agent not found
    const res = await call({ action: 'dispatch_task', projectKey: 'ab', title: 'x', instructions: 'y', agentId: UUID });
    expect(res.status).toBe(409);
    expect(h.createTask).not.toHaveBeenCalled();
    expect(h.enqueueRun).not.toHaveBeenCalled();
  });

  it('rerun_task (admin) → tenant-verifies task then enqueueRun', async () => {
    const res = await call({ action: 'rerun_task', projectKey: 'ab', taskId: UUID });
    expect(res.status).toBe(200);
    expect(h.getTask).toHaveBeenCalledTimes(1);
    expect(h.enqueueRun).toHaveBeenCalledTimes(1);
  });

  it('stale/missing target → 409 (NotFound mapped), surfaced as a clean status', async () => {
    h.answerOwnerQuestion.mockRejectedValue(new NotFoundError('Owner question'));
    const res = await call({ action: 'answer_question', projectKey: 'ab', questionId: UUID, answer: 'y' });
    expect(res.status).toBe(409);
  });
});
