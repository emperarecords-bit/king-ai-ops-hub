import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops Chat Supabase bridge — the confirm-side domain (executeSupabaseDeployFromOpsChat). It must reach Supabase
 * ONLY through the existing governed path: validate → create anchor task → insert a supabase_deploy approval →
 * decideApproval(admin) → executeApprovedIfEligible (the dispatch choke point). No new executor/dispatch. A bad
 * proposal, an unlinked project, or an unlinked repo never creates an approval and never executes. Fully mocked.
 */

const h = vi.hoisted(() => ({
  withTenant: vi.fn(),
  listRepoLinks: vi.fn(),
  listSupabaseProjectLinks: vi.fn(),
  listAgents: vi.fn(),
  createTask: vi.fn(),
  setTaskStatus: vi.fn(),
  decideApproval: vi.fn(),
  executeApprovedIfEligible: vi.fn(),
  insertedApproval: vi.fn(),
}));

vi.mock('@/db/tenant', () => ({ withTenant: h.withTenant }));
vi.mock('@/db/schema', () => ({ approvals: { id: 'approvals.id' } }));
vi.mock('@/domain/github/links', () => ({ listRepoLinks: h.listRepoLinks }));
vi.mock('@/domain/supabase/links', () => ({ listSupabaseProjectLinks: h.listSupabaseProjectLinks }));
vi.mock('@/domain/agents/agents', () => ({ listAgents: h.listAgents }));
vi.mock('@/domain/tasks/tasks', () => ({ createTask: h.createTask, setTaskStatus: h.setTaskStatus }));
vi.mock('@/domain/approvals/approvals', () => ({ decideApproval: h.decideApproval }));
vi.mock('@/domain/execution/execute-on-approval', () => ({ executeApprovedIfEligible: h.executeApprovedIfEligible }));

import { executeSupabaseDeployFromOpsChat } from '@/domain/opschat/supabase-action';

const CTX = { userId: 'u1', orgId: 'o1', projectId: 'p1', orgRole: 'owner' as const, projectRole: 'admin' as const };
const PROJECT_REF = 'bblnywrcdsfdasytkzps';
const REPO = 'emperarecords-bit/accuratebids';
const SHA = 'a'.repeat(40);
const INPUT = {
  projectRef: PROJECT_REF,
  functionSlug: 'approve-quote',
  sourceRepo: REPO,
  sourceSha: SHA,
  sourcePath: 'supabase/functions/approve-quote',
  verifyJwt: false,
};

const fakeTx = {
  insert: () => ({ values: (v: unknown) => { h.insertedApproval(v); return { returning: async () => [{ id: 'a-123' }] }; } }),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx));
  h.listSupabaseProjectLinks.mockResolvedValue([{ projectRef: PROJECT_REF, label: 'AccurateBids' }]);
  h.listRepoLinks.mockResolvedValue([{ repoFullName: REPO, installationId: 1n, defaultBranch: 'main' }]);
  h.listAgents.mockResolvedValue([{ id: 'ag1', provider: 'openai', enabled: true }]);
  h.createTask.mockResolvedValue('t-1');
  h.decideApproval.mockResolvedValue(undefined);
  h.setTaskStatus.mockResolvedValue(undefined);
  h.executeApprovedIfEligible.mockResolvedValue({ attempted: true, outcome: 'succeeded', message: 'Deployed.', prUrl: null, preview: { version: 7, contentDigest: 'd'.repeat(64) } });
});

describe('executeSupabaseDeployFromOpsChat — governed path only', () => {
  it('validates → task → supabase_deploy approval → decideApproval(approved) → executeApprovedIfEligible', async () => {
    const r = await executeSupabaseDeployFromOpsChat(CTX, INPUT);

    expect(h.createTask).toHaveBeenCalledTimes(1);
    const taskInput = h.createTask.mock.calls[0]![2] as { title: string; input: string; reviewEnabled: boolean };
    expect(taskInput.title).toMatch(/Supabase deploy/);
    expect(taskInput.reviewEnabled).toBe(false);
    expect(h.insertedApproval).toHaveBeenCalledTimes(1);
    const approvalRow = h.insertedApproval.mock.calls[0]![0] as Record<string, unknown>;
    expect(approvalRow.actionType).toBe('supabase_deploy');
    expect(approvalRow.status).toBe('pending');
    expect(typeof approvalRow.payloadSha256).toBe('string');
    expect(h.decideApproval).toHaveBeenCalledWith(fakeTx, CTX, 'a-123', 'approved', expect.any(String));
    expect(h.executeApprovedIfEligible).toHaveBeenCalledWith(CTX, 'a-123');
    expect(h.decideApproval.mock.invocationCallOrder[0]!).toBeLessThan(h.executeApprovedIfEligible.mock.invocationCallOrder[0]!);
    expect(r.outcome).toBe('succeeded');
    expect(r.approvalId).toBe('a-123');
    expect(r.version).toBe(7);
    expect(r.contentDigest).toBe('d'.repeat(64));
  });

  it('a non-40-hex SHA throws and NEVER creates an approval or executes', async () => {
    await expect(executeSupabaseDeployFromOpsChat(CTX, { ...INPUT, sourceSha: 'main' })).rejects.toThrow();
    expect(h.insertedApproval).not.toHaveBeenCalled();
    expect(h.createTask).not.toHaveBeenCalled();
    expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
  });

  it('an unlinked target project is refused before any approval/execution', async () => {
    h.listSupabaseProjectLinks.mockResolvedValue([]);
    await expect(executeSupabaseDeployFromOpsChat(CTX, INPUT)).rejects.toThrow(/not linked/i);
    expect(h.insertedApproval).not.toHaveBeenCalled();
    expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
  });

  it('an unlinked source repo is refused before any approval/execution', async () => {
    h.listRepoLinks.mockResolvedValue([]);
    await expect(executeSupabaseDeployFromOpsChat(CTX, INPUT)).rejects.toThrow(/not linked/i);
    expect(h.insertedApproval).not.toHaveBeenCalled();
    expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
  });
});
