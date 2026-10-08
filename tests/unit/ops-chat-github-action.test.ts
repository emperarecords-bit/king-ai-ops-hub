import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops Chat GitHub bridge — the confirm-side domain (executeGitHubPrFromOpsChat). It must reach GitHub ONLY
 * through the existing governed path: validate → create anchor task → insert a git_pr approval →
 * decideApproval(admin) → executeApprovedIfEligible (the dispatch choke point). No new executor/dispatch.
 * A bad proposal never creates an approval and never executes. Fully mocked — no DB, no network.
 */

const h = vi.hoisted(() => ({
  withTenant: vi.fn(),
  listRepoLinks: vi.fn(),
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
vi.mock('@/domain/agents/agents', () => ({ listAgents: h.listAgents }));
vi.mock('@/domain/tasks/tasks', () => ({ createTask: h.createTask, setTaskStatus: h.setTaskStatus }));
vi.mock('@/domain/approvals/approvals', () => ({ decideApproval: h.decideApproval }));
vi.mock('@/domain/execution/execute-on-approval', () => ({ executeApprovedIfEligible: h.executeApprovedIfEligible }));

import { executeGitHubPrFromOpsChat } from '@/domain/opschat/github-action';

const CTX = { userId: 'u1', orgId: 'o1', projectId: 'p1', orgRole: 'owner' as const, projectRole: 'admin' as const };
const LINK = { id: 'l1', installationId: 1n, repoFullName: 'emperarecords-bit/king-ai-ops-hub', defaultBranch: 'main', linkedBy: 'u1', createdAt: new Date() };
const INPUT = { repo: LINK.repoFullName, branch: 'hub/fix-1', title: 'Fix the thing', files: [{ path: 'docs/n.md', content: 'real content here' }] };

const fakeTx = {
  insert: () => ({ values: (v: unknown) => { h.insertedApproval(v); return { returning: async () => [{ id: 'a-123' }] }; } }),
};

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx));
  h.listRepoLinks.mockResolvedValue([LINK]);
  h.listAgents.mockResolvedValue([{ id: 'ag1', provider: 'openai', enabled: true }]);
  h.createTask.mockResolvedValue('t-1');
  h.decideApproval.mockResolvedValue(undefined);
  h.setTaskStatus.mockResolvedValue(undefined);
  h.executeApprovedIfEligible.mockResolvedValue({ attempted: true, outcome: 'succeeded', message: 'Opened pull request #7.', prUrl: 'https://github.com/x/pull/7' });
});

describe('executeGitHubPrFromOpsChat — governed path only', () => {
  it('validates → task → approval → decideApproval(approved) → executeApprovedIfEligible, returns provenance', async () => {
    const r = await executeGitHubPrFromOpsChat(CTX, INPUT);

    expect(h.createTask).toHaveBeenCalledTimes(1);
    // The anchor task is a clearly-identified governed operation, with NO cross-check/review and NO AI run.
    const taskInput = h.createTask.mock.calls[0]![2] as { title: string; input: string; reviewEnabled: boolean };
    expect(taskInput.title).toMatch(/GitHub PR/);
    expect(taskInput.input).toMatch(/Owner-initiated GitHub pull request/i);
    expect(taskInput.reviewEnabled).toBe(false);
    // an approval row for git_pr was inserted
    expect(h.insertedApproval).toHaveBeenCalledTimes(1);
    const approvalRow = h.insertedApproval.mock.calls[0]![0] as Record<string, unknown>;
    expect(approvalRow.actionType).toBe('git_pr');
    expect(approvalRow.status).toBe('pending');
    expect(typeof approvalRow.payloadSha256).toBe('string');
    // decided (admin) then executed through the EXISTING dispatch path
    expect(h.decideApproval).toHaveBeenCalledWith(fakeTx, CTX, 'a-123', 'approved', expect.any(String));
    expect(h.executeApprovedIfEligible).toHaveBeenCalledWith(CTX, 'a-123');
    // decideApproval must precede execution
    expect(h.decideApproval.mock.invocationCallOrder[0]!).toBeLessThan(h.executeApprovedIfEligible.mock.invocationCallOrder[0]!);
    // provenance surfaced
    expect(r.outcome).toBe('succeeded');
    expect(r.prUrl).toBe('https://github.com/x/pull/7');
    expect(r.approvalId).toBe('a-123');
  });

  it('a malformed payload (no files) throws and NEVER creates an approval or executes', async () => {
    await expect(executeGitHubPrFromOpsChat(CTX, { ...INPUT, files: [] })).rejects.toThrow();
    expect(h.insertedApproval).not.toHaveBeenCalled();
    expect(h.createTask).not.toHaveBeenCalled();
    expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
  });

  it('placeholder content throws before any approval/execution', async () => {
    await expect(
      executeGitHubPrFromOpsChat(CTX, { ...INPUT, files: [{ path: 'a.ts', content: '<COMPLETE FILE CONTENT NEEDED>' }] }),
    ).rejects.toThrow();
    expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
  });

  it('an unlinked repository is refused — no approval, no execution', async () => {
    h.listRepoLinks.mockResolvedValue([]);
    await expect(executeGitHubPrFromOpsChat(CTX, INPUT)).rejects.toThrow(/not linked/i);
    expect(h.insertedApproval).not.toHaveBeenCalled();
    expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
  });

  it('no enabled employee to anchor the action → refused, no execution', async () => {
    h.listAgents.mockResolvedValue([{ id: 'ag1', provider: 'openai', enabled: false }]);
    await expect(executeGitHubPrFromOpsChat(CTX, INPUT)).rejects.toThrow();
    expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
  });

  it('a blocked/failed dispatch outcome is returned honestly (not a false success)', async () => {
    h.executeApprovedIfEligible.mockResolvedValue({ attempted: true, outcome: 'blocked', message: 'The executor is disabled.', prUrl: null });
    const r = await executeGitHubPrFromOpsChat(CTX, INPUT);
    expect(r.outcome).toBe('blocked');
    expect(r.prUrl).toBeNull();
    expect(r.message).toContain('disabled');
  });
});
