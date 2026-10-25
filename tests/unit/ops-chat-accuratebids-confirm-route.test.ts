import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * POST /api/ops-chat/confirm — the AccurateBids cards (draft quote / create invoice / email a
 * record), PROPOSAL-ID AUTHORITATIVE. The client sends only { proposalId, intent }; the server
 * reconstructs the action from the owner's persisted, immutable proposal. Fully mocked — the
 * governed bridge is a spy; this proves admin + validation + CAS gate it, the stored kind must
 * match the payload's kind, and cancel never reaches it.
 */

const PROP = '44444444-4444-4444-8444-444444444444';
const CONV = '22222222-2222-4222-8222-222222222222';
const MSG = '33333333-3333-4333-8333-333333333333';
const INV = '4c5e2a92-fa7c-49db-b9fd-8eb31cb8b901';

const h = vi.hoisted(() => ({
  requireUser: vi.fn(),
  requireTenant: vi.fn(),
  withUser: vi.fn(),
  withTenant: vi.fn(),
  loadProposal: vi.fn(),
  transitionProposal: vi.fn(),
  consumeRateLimit: vi.fn(),
  executeAccurateBidsFromOpsChat: vi.fn(),
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
  executeGitHubPrFromOpsChat: vi.fn(),
  executeGitHubMergeFromOpsChat: vi.fn(),
  executeGitHubRerunFromOpsChat: vi.fn(),
  executeGitHubRevertFromOpsChat: vi.fn(),
}));
vi.mock('@/domain/opschat/supabase-action', () => ({ executeSupabaseDeployFromOpsChat: vi.fn() }));
vi.mock('@/domain/opschat/vercel-action', () => ({ executeVercelMutationFromOpsChat: vi.fn() }));
vi.mock('@/domain/opschat/accuratebids-action', () => ({ executeAccurateBidsFromOpsChat: h.executeAccurateBidsFromOpsChat }));

import { POST } from '@/app/api/ops-chat/confirm/route';

const call = (body: unknown) =>
  POST(new Request('http://localhost/api/ops-chat/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const ctx = (projectRole: 'admin' | 'member') => ({ userId: 'u1', orgId: 'o1', projectId: 'p-ab', orgRole: 'owner', projectRole });
const SEND = { kind: 'accuratebids_send', send: 'invoice', invoice_id: INV, label: 'INV-123456' };
const stored = (kind: string, payload: Record<string, unknown>) => ({
  id: PROP,
  conversationId: CONV,
  messageId: MSG,
  kind,
  state: 'pending' as const,
  proposal: { kind, projectKey: 'empera', workspaceName: 'Empera A/C', summary: 'Email the invoice', payload, content: { title: 't' } },
});

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
  h.loadProposal.mockResolvedValue(stored('accuratebids_send', SEND));
  h.executeAccurateBidsFromOpsChat.mockResolvedValue({ approvalId: 'a1', attempted: true, outcome: 'succeeded', message: 'Invoice INV-123456 emailed', preview: { sentTo: 'p***@x.com' } });
});

describe('POST /api/ops-chat/confirm — AccurateBids cards', () => {
  it('admin + stored send → the governed bridge runs with EXACTLY the stored payload', async () => {
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('done');
    expect(body.executed).toMatchObject({ outcome: 'succeeded' });
    expect(h.executeAccurateBidsFromOpsChat).toHaveBeenCalledTimes(1);
    const [, projectKey, payload] = h.executeAccurateBidsFromOpsChat.mock.calls[0]!;
    expect(projectKey).toBe('empera');
    expect(payload).toEqual(SEND);
  });

  it.each(['accuratebids_quote', 'accuratebids_invoice'])('maps %s to the same bridge', async (kind) => {
    const payload = kind === 'accuratebids_quote' ? { kind, job_name: 'J', customer_name: 'C' } : { kind, quote_id: INV };
    h.loadProposal.mockResolvedValue(stored(kind, payload));
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(200);
    expect(h.executeAccurateBidsFromOpsChat.mock.calls[0]![2]).toEqual(payload);
  });

  it('a stored card whose kind does not match its payload never reaches the bridge', async () => {
    h.loadProposal.mockResolvedValue(stored('accuratebids_quote', SEND));
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.ok).toBe(false);
    expect(h.executeAccurateBidsFromOpsChat).not.toHaveBeenCalled();
  });

  it('a non-admin is refused (403) and the bridge is never reached', async () => {
    h.requireTenant.mockResolvedValue(ctx('member'));
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(403);
    expect(h.executeAccurateBidsFromOpsChat).not.toHaveBeenCalled();
  });

  it('cancel never reaches the bridge (nothing created or emailed)', async () => {
    const res = await call({ proposalId: PROP, intent: 'cancel' });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe('cancelled');
    expect(h.executeAccurateBidsFromOpsChat).not.toHaveBeenCalled();
  });

  it('a lost confirm race (already confirming/done) never runs the bridge a second time', async () => {
    h.transitionProposal.mockResolvedValue(null);
    const res = await call({ proposalId: PROP, intent: 'confirm' });
    expect(res.status).toBe(409);
    expect(h.executeAccurateBidsFromOpsChat).not.toHaveBeenCalled();
  });
});
