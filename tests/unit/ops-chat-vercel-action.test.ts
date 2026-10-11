import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops Chat Vercel mutation bridge — executeVercelMutationFromOpsChat. Reaches Vercel ONLY through the existing
 * governed path: validate → anchor task → insert a vercel_mutation approval → decideApproval(admin) →
 * executeApprovedIfEligible. No new executor/dispatch. A bad payload or unlinked project never creates an
 * approval and never executes. Fully mocked.
 */

const h = vi.hoisted(() => ({
  withTenant: vi.fn(),
  listVercelProjectLinks: vi.fn(),
  listAgents: vi.fn(),
  createTask: vi.fn(),
  setTaskStatus: vi.fn(),
  decideApproval: vi.fn(),
  executeApprovedIfEligible: vi.fn(),
  insertedApproval: vi.fn(),
}));

vi.mock('@/db/tenant', () => ({ withTenant: h.withTenant }));
vi.mock('@/db/schema', () => ({ approvals: { id: 'approvals.id' } }));
vi.mock('@/domain/vercel/links', () => ({ listVercelProjectLinks: h.listVercelProjectLinks }));
vi.mock('@/domain/agents/agents', () => ({ listAgents: h.listAgents }));
vi.mock('@/domain/tasks/tasks', () => ({ createTask: h.createTask, setTaskStatus: h.setTaskStatus }));
vi.mock('@/domain/approvals/approvals', () => ({ decideApproval: h.decideApproval }));
vi.mock('@/domain/execution/execute-on-approval', () => ({ executeApprovedIfEligible: h.executeApprovedIfEligible }));

import { executeVercelMutationFromOpsChat } from '@/domain/opschat/vercel-action';

const CTX = { userId: 'u1', orgId: 'o1', projectId: 'p1', orgRole: 'owner' as const, projectRole: 'admin' as const };
const PRJ = 'prj_accuratebids0001xyz';
const TARGET = 'dpl_target00000001';
const CURRENT = 'dpl_current0000002';
const SHA = 'a'.repeat(40);
const PROMOTE = { operation: 'promote' as const, vercelProjectId: PRJ, targetDeploymentId: TARGET, expectedTargetSha: SHA, expectedCurrentProductionDeploymentId: CURRENT };

const fakeTx = { insert: () => ({ values: (v: unknown) => { h.insertedApproval(v); return { returning: async () => [{ id: 'a-9' }] }; } }) };

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn(fakeTx));
  h.listVercelProjectLinks.mockResolvedValue([{ vercelProjectId: PRJ, vercelTeamId: null, label: 'AccurateBids' }]);
  h.listAgents.mockResolvedValue([{ id: 'ag1', provider: 'openai', enabled: true }]);
  h.createTask.mockResolvedValue('t-1');
  h.decideApproval.mockResolvedValue(undefined);
  h.setTaskStatus.mockResolvedValue(undefined);
  h.executeApprovedIfEligible.mockResolvedValue({ attempted: true, outcome: 'succeeded', message: 'Production now points to ' + TARGET, prUrl: null, preview: { productionDeploymentId: TARGET, productionChanged: true } });
});

describe('executeVercelMutationFromOpsChat — governed path only', () => {
  it('validates → task → vercel_mutation approval → decideApproval(approved) → executeApprovedIfEligible', async () => {
    const r = await executeVercelMutationFromOpsChat(CTX, PROMOTE);
    expect(h.createTask).toHaveBeenCalledTimes(1);
    expect(h.insertedApproval).toHaveBeenCalledTimes(1);
    const row = h.insertedApproval.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.actionType).toBe('vercel_mutation');
    expect(row.status).toBe('pending');
    expect(typeof row.payloadSha256).toBe('string');
    expect(h.decideApproval).toHaveBeenCalledWith(fakeTx, CTX, 'a-9', 'approved', expect.any(String));
    expect(h.executeApprovedIfEligible).toHaveBeenCalledWith(CTX, 'a-9');
    expect(h.decideApproval.mock.invocationCallOrder[0]!).toBeLessThan(h.executeApprovedIfEligible.mock.invocationCallOrder[0]!);
    expect(r.outcome).toBe('succeeded');
    expect(r.operation).toBe('promote');
    expect(r.productionDeploymentId).toBe(TARGET);
    expect(r.productionChanged).toBe(true);
  });

  it('a malformed payload (bad deployment id) throws and NEVER creates an approval or executes', async () => {
    await expect(executeVercelMutationFromOpsChat(CTX, { ...PROMOTE, targetDeploymentId: 'not-a-dpl' })).rejects.toThrow();
    expect(h.insertedApproval).not.toHaveBeenCalled();
    expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
  });

  it('an unlinked project is refused before any approval/execution', async () => {
    h.listVercelProjectLinks.mockResolvedValue([]);
    await expect(executeVercelMutationFromOpsChat(CTX, PROMOTE)).rejects.toThrow(/not linked/i);
    expect(h.insertedApproval).not.toHaveBeenCalled();
    expect(h.executeApprovedIfEligible).not.toHaveBeenCalled();
  });
});
