import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForbiddenError, NotFoundError, RateLimitedError, UnauthenticatedError } from '@/lib/errors';

/**
 * POST /api/ops-chat/confirm — the ONLY Ops Chat write boundary, PROPOSAL-ID AUTHORITATIVE.
 * Fully mocked: no real auth, DB, provider, or execution. The client sends only
 * { proposalId, intent }; the server loads the owner's persisted, immutable proposal and uses
 * THAT as the payload. Asserts: every mutation is authenticated, the action is reconstructed +
 * validated from the STORED payload, tenant-resolved through the current user, admin-gated, and
 * CAS-guarded; a rejected request produces ZERO writes; cancel never executes; a lost CAS is a
 * clean 409; and an executed-but-unpersisted terminal is surfaced as `unrecorded`.
 */

const UUID = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';
const PROP = '44444444-4444-4444-8444-444444444444';

type Kind = 'answer_question' | 'decide_approval' | 'dispatch_task' | 'rerun_task';

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireTenant: vi.fn(),
  withUser: vi.fn(),
  withTenant: vi.fn(),
  loadProposal: vi.fn(),
  transitionProposal: vi.fn(),
  consumeRateLimit: vi.fn(),
  answerOwnerQuestion: vi.fn(),
  decideApproval: vi.fn(),
  executeApprovedIfEligible: vi.fn(),
  createTask: vi.fn(),
  getTask: vi.fn(),
  enqueueRun: vi.fn(),
  requestRerun: vi.fn(),
  listAgents: vi.fn(),
  RerunRefusedError: class RerunRefusedError extends Error {
    constructor(
      readonly reason: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock('@/domain/auth/guard', () => ({ requireUser: h.requireUser, requireTenant: h.requireTenant }));
vi.mock('@/db/tenant', () => ({ withUser: h.withUser, withTenant: h.withTenant }));
vi.mock('@/db/client', () => ({ getDb: () => ({ transaction: (fn: (tx: unknown) => unknown) => fn({}) }) }));
vi.mock('@/domain/usage/rate-limit', () => ({ consumeRateLimit: h.consumeRateLimit }));
vi.mock('@/lib/env.server', () => ({ serverEnv: () => ({ RATE_LIMIT_RUNS_PER_MINUTE: 10 }) }));
vi.mock('@/lib/log', () => ({ log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));
vi.mock('@/domain/questions/questions', () => ({ answerOwnerQuestion: h.answerOwnerQuestion }));
vi.mock('@/domain/approvals/approvals', () => ({ decideApproval: h.decideApproval }));
vi.mock('@/domain/execution/execute-on-approval', () => ({ executeApprovedIfEligible: h.executeApprovedIfEligible }));
vi.mock('@/domain/tasks/tasks', () => ({ createTask: h.createTask, getTask: h.getTask }));
vi.mock('@/domain/jobs/jobs', () => ({ enqueueRun: h.enqueueRun, requestRerun: h.requestRerun, RerunRefusedError: h.RerunRefusedError }));
vi.mock('@/domain/agents/agents', () => ({ listAgents: h.listAgents }));
vi.mock('@/domain/opschat/conversations', () => ({ loadProposal: h.loadProposal, transitionProposal: h.transitionProposal }));
// The confirm route imports the governed external executors at top level; mock them so the
// module loads without their server-only dependencies (they are not exercised in this suite).
vi.mock('@/domain/opschat/github-action', () => ({
  executeGitHubPrFromOpsChat: vi.fn(),
  executeGitHubMergeFromOpsChat: vi.fn(),
  executeGitHubRerunFromOpsChat: vi.fn(),
  executeGitHubRevertFromOpsChat: vi.fn(),
}));
vi.mock('@/domain/opschat/supabase-action', () => ({ executeSupabaseDeployFromOpsChat: vi.fn() }));
vi.mock('@/domain/opschat/vercel-action', () => ({ executeVercelMutationFromOpsChat: vi.fn() }));

import { POST } from '@/app/api/ops-chat/confirm/route';

function call(body: unknown): Promise<Response> {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' } };
  init.body = typeof body === 'string' ? body : JSON.stringify(body);
  return POST(new Request('http://localhost/api/ops-chat/confirm', init));
}

function ctxWithRole(projectRole: 'admin' | 'member') {
  return { userId: 'u1', orgId: 'o1', projectId: 'p-ab', orgRole: 'owner', projectRole };
}

/** The stored (immutable) proposal payload for a kind — carries the fields the confirm route
 *  reconstructs the action from, plus display-only fields the server ignores. */
function payloadFor(kind: Kind): Record<string, unknown> {
  switch (kind) {
    case 'answer_question':
      return { kind, projectKey: 'ab', questionId: UUID, answer: 'yes', workspaceName: 'W', question: 'x?' };
    case 'decide_approval':
      return { kind, projectKey: 'ab', approvalId: UUID, decision: 'approved', note: undefined, workspaceName: 'W', summary: 's' };
    case 'dispatch_task':
      return { kind, projectKey: 'ab', title: 'Research', instructions: 'go', agentId: UUID, workspaceName: 'W', agentName: 'Scout' };
    case 'rerun_task':
      return { kind, projectKey: 'ab', taskId: UUID, workspaceName: 'W', taskTitle: 'T' };
  }
}

function storedProposal(kind: Kind, over: Record<string, unknown> = {}) {
  return { id: PROP, conversationId: CONV, messageId: MSG, kind, proposal: { ...payloadFor(kind), ...over }, state: 'pending' as const };
}

/** No write-domain function was invoked. */
function expectNoWrites() {
  expect(h.answerOwnerQuestion).not.toHaveBeenCalled();
  expect(h.decideApproval).not.toHaveBeenCalled();
  expect(h.createTask).not.toHaveBeenCalled();
  expect(h.enqueueRun).not.toHaveBeenCalled();
  expect(h.requestRerun).not.toHaveBeenCalled();
  expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  h.requireUser.mockResolvedValue({ id: 'u1', email: 'o@e.com', displayName: 'Owner' });
  h.requireTenant.mockResolvedValue(ctxWithRole('admin'));
  h.withUser.mockImplementation((_s: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.withTenant.mockImplementation((_c: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.consumeRateLimit.mockResolvedValue(undefined);
  // CAS succeeds by default: the row transitions to the requested state.
  h.transitionProposal.mockImplementation((_tx: unknown, _uid: unknown, args: { proposalId: string; to: string }) =>
    Promise.resolve({ id: args.proposalId, state: args.to }),
  );
  h.loadProposal.mockResolvedValue(storedProposal('answer_question'));
  h.answerOwnerQuestion.mockResolvedValue(undefined);
  h.decideApproval.mockResolvedValue(undefined);
  h.executeApprovedIfEligible.mockResolvedValue({ outcome: 'done', message: null });
  h.createTask.mockResolvedValue('task-123');
  h.getTask.mockResolvedValue({ id: UUID, title: 'T', status: 'completed' });
  h.enqueueRun.mockResolvedValue({ inserted: true, jobId: 'job-1' });
  h.requestRerun.mockResolvedValue({ status: 'started', taskId: UUID, jobId: 'job-2', previousStatus: 'completed', previousRunId: 'run-1' });
  h.listAgents.mockResolvedValue([{ id: UUID, name: 'Scout', role: 'primary', enabled: true, provider: 'anthropic' }]);
});

describe('confirm — auth & validation gates (zero writes on rejection)', () => {
  it('unauthenticated → 401', async () => {
    h.requireUser.mockRejectedValue(new UnauthenticatedError());
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(401);
    expectNoWrites();
  });

  it('malformed body → 400 (before auth or load)', async () => {
    const res = await call({ proposalId: 'not-a-uuid', intent: 'confirm' });
    expect(res.status).toBe(400);
    expect(h.requireUser).not.toHaveBeenCalled();
    expect(h.loadProposal).not.toHaveBeenCalled();
    expectNoWrites();
  });

  it('proposal not found → 404', async () => {
    h.loadProposal.mockResolvedValue(null);
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(404);
    expectNoWrites();
  });

  it('unknown / cross-tenant project → 403', async () => {
    h.requireTenant.mockRejectedValue(new ForbiddenError());
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(403);
    expectNoWrites();
  });

  it('rate-limited → 429, zero writes', async () => {
    h.consumeRateLimit.mockRejectedValue(new RateLimitedError());
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(429);
    expectNoWrites();
  });
});

describe('confirm — role enforcement (every action requires admin)', () => {
  it.each<Kind>(['answer_question', 'decide_approval', 'dispatch_task', 'rerun_task'])(
    'non-admin → 403 for %s',
    async (kind) => {
      h.loadProposal.mockResolvedValue(storedProposal(kind));
      h.requireTenant.mockResolvedValue(ctxWithRole('member'));
      const res = await call({ proposalId: PROP, intent: 'confirm' });
      expect(res.status).toBe(403);
      expectNoWrites();
    },
  );
});

describe('confirm — writes happen only after a valid confirm (from the stored payload)', () => {
  it('answer_question (admin) calls answerOwnerQuestion exactly once', async () => {
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(200);
    expect(h.answerOwnerQuestion).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({ ok: true, state: 'done' });
  });

  it('decide_approval approved → decideApproval + executeApprovedIfEligible', async () => {
    h.loadProposal.mockResolvedValue(storedProposal('decide_approval', { decision: 'approved' }));
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(200);
    expect(h.decideApproval).toHaveBeenCalledTimes(1);
    expect(h.executeApprovedIfEligible).toHaveBeenCalledTimes(1);
  });

  it('decide_approval with a display `content` view → same governed decision; content never reaches the write', async () => {
    const content = { format: 'email', title: 'Email to send', fields: [], body: 'Hi there', truncated: false, redacted: false };
    h.loadProposal.mockResolvedValue(storedProposal('decide_approval', { decision: 'approved', content }));
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(200);
    expect(h.decideApproval).toHaveBeenCalledTimes(1);
    // decideApproval(tx, ctx, approvalId, decision, note) — the display content is not an input.
    expect(h.decideApproval.mock.calls[0]!.slice(2)).toEqual([UUID, 'approved', undefined]);
    expect(h.executeApprovedIfEligible).toHaveBeenCalledTimes(1);
  });

  it('decide_approval rejected → decideApproval only, no execution', async () => {
    h.loadProposal.mockResolvedValue(storedProposal('decide_approval', { decision: 'rejected', note: 'no' }));
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(200);
    expect(h.decideApproval).toHaveBeenCalledTimes(1);
    expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
  });

  it('dispatch_task (admin) → createTask + enqueueRun, returns taskId in executed', async () => {
    h.loadProposal.mockResolvedValue(storedProposal('dispatch_task'));
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, executed: { taskId: 'task-123' }, state: 'done' });
    expect(h.createTask).toHaveBeenCalledTimes(1);
    expect(h.enqueueRun).toHaveBeenCalledTimes(1);
  });

  it('dispatch_task: the agent on the card is the agent that runs; a changed/disabled agent fails stale with a reason', async () => {
    h.loadProposal.mockResolvedValue(storedProposal('dispatch_task'));
    h.listAgents.mockResolvedValue([{ id: UUID, name: 'Scout', role: 'primary', enabled: false, provider: 'anthropic' }]);
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.state).toBe('stale');
    expect(body.error).toMatch(/agent on this card is no longer available — ask Ops Chat for a new card. Nothing was started/);
    expect(h.createTask).not.toHaveBeenCalled();
  });

  it('dispatch_task with a reviewer on the card → the task is created REVIEWED by exactly that reviewer', async () => {
    const REV = '99999999-9999-4999-8999-999999999999';
    h.loadProposal.mockResolvedValue(storedProposal('dispatch_task', { reviewerAgentId: REV }));
    h.listAgents.mockResolvedValue([
      { id: UUID, name: 'Scout', role: 'primary', enabled: true, provider: 'anthropic' },
      { id: REV, name: 'Checker', role: 'reviewer', enabled: true, provider: 'openai' },
    ]);
    const body = await (await call({ proposalId: PROP, intent: 'confirm' })).json();
    expect(body.executed).toMatchObject({ taskId: 'task-123', agentName: 'Scout', reviewerName: 'Checker' });
    expect(h.createTask.mock.calls[0]![2]).toMatchObject({ primaryAgentId: UUID, reviewEnabled: true, reviewerAgentId: REV });
  });

  it('dispatch_task card from before reviewer assignment (no reviewer field) → unreviewed, exactly as the card said', async () => {
    h.loadProposal.mockResolvedValue(storedProposal('dispatch_task'));
    await call({ proposalId: PROP, intent: 'confirm' });
    expect(h.createTask.mock.calls[0]![2]).toMatchObject({ reviewEnabled: false, reviewerAgentId: null });
  });

  it('dispatch_task with an unavailable agent → 409 (stale), no writes', async () => {
    h.loadProposal.mockResolvedValue(storedProposal('dispatch_task'));
    h.listAgents.mockResolvedValue([]); // agent not found
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(409);
    expect(h.createTask).not.toHaveBeenCalled();
    expect(h.enqueueRun).not.toHaveBeenCalled();
  });

  it('rerun_task of a COMPLETED task → a real new attempt; the card result says so and carries the ids', async () => {
    h.loadProposal.mockResolvedValue(storedProposal('rerun_task'));
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(200);
    expect(h.requestRerun).toHaveBeenCalledTimes(1);
    expect(h.requestRerun.mock.calls[0]![2]).toBe(UUID);
    const body = await res.json();
    expect(body).toMatchObject({ state: 'done', executed: { outcome: 'started', taskId: UUID, jobId: 'job-2', previousRunId: 'run-1' } });
    expect(body.executed.message).toMatch(/new attempt .*previous completed run and its result are kept/);
  });

  it('rerun_task when a job is already live → "already queued", nothing new claimed', async () => {
    h.loadProposal.mockResolvedValue(storedProposal('rerun_task'));
    h.requestRerun.mockResolvedValue({ status: 'already_queued', taskId: UUID, jobId: 'job-live', previousStatus: 'running' });
    const body = await (await call({ proposalId: PROP, intent: 'confirm' })).json();
    expect(body.executed).toMatchObject({ outcome: 'already_queued', jobId: 'job-live' });
    expect(body.executed.message).toMatch(/nothing new was queued/);
  });

  it.each([
    ['awaiting_approval', /Decide that approval first/],
    ['cancelled', /Dispatch a new task/],
  ])('rerun_task of a %s task fails EXPLICITLY (409 stale with the reason) — never a silent "queued"', async (reason, msg) => {
    h.loadProposal.mockResolvedValue(storedProposal('rerun_task'));
    h.requestRerun.mockRejectedValue(
      new h.RerunRefusedError(reason, reason === 'cancelled' ? '"T" was cancelled. Dispatch a new task instead.' : '"T" is waiting on an approval decision. Decide that approval first.'),
    );
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.state).toBe('stale');
    expect(body.error).toMatch(msg);
  });

  it('stale/missing target → 409 (NotFound mapped to the stale terminal)', async () => {
    h.answerOwnerQuestion.mockRejectedValue(new NotFoundError('Owner question'));
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(409);
  });
});

describe('confirm — CAS & cancel (proposal-id authoritative)', () => {
  it('cancel → CAS pending→cancelled, never executes', async () => {
    const res = await call({ proposalId: PROP, intent: 'cancel' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, state: 'cancelled' });
    expect(h.transitionProposal).toHaveBeenCalledWith(expect.anything(), 'u1', expect.objectContaining({ from: 'pending', to: 'cancelled' }));
    expectNoWrites();
  });

  it('cancel on a non-pending proposal → 409 (CAS miss)', async () => {
    h.transitionProposal.mockResolvedValue(null);
    const res = await call({ proposalId: PROP, intent: 'cancel' });
    expect(res.status).toBe(409);
    expectNoWrites();
  });

  it('confirm losing the pending→confirming CAS → 409, no execution', async () => {
    // Precheck passes, but another tab already acquired `confirming`.
    h.transitionProposal.mockImplementation((_tx: unknown, _uid: unknown, args: { to: string }) =>
      Promise.resolve(args.to === 'confirming' ? null : { id: PROP, state: args.to }),
    );
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(409);
    expectNoWrites();
  });

  it('executed but the terminal CAS does not land → state "unrecorded" (never a false "done")', async () => {
    h.transitionProposal.mockImplementation((_tx: unknown, _uid: unknown, args: { from: string; to: string }) =>
      // Acquire `confirming`, but fail to persist `done`.
      Promise.resolve(args.to === 'done' ? null : { id: PROP, state: args.to }),
    );
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(200);
    expect(h.answerOwnerQuestion).toHaveBeenCalledTimes(1); // the action DID run
    expect(await res.json()).toMatchObject({ ok: true, state: 'unrecorded' });
  });
});
