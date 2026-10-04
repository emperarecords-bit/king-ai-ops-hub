import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops Chat v2 tool layer. Fully mocked domain + tenant: the tools READ through
 * the tenant boundary and RECORD proposals; they must never resolve a workspace
 * outside the caller's access, and the PROPOSE tools must not mutate (they only
 * append a proposal object). No DB, no provider.
 */

const h = vi.hoisted(() => ({
  withTenant: vi.fn(),
  listObjectives: vi.fn(),
  assessWorkspaceHealth: vi.fn(),
  listTasks: vi.fn(),
  getTask: vi.fn(),
  listRuns: vi.fn(),
  listRunSteps: vi.fn(),
  openQuestionsForOwner: vi.fn(),
  listApprovalsForQueue: vi.fn(),
  getApprovalDetail: vi.fn(),
  listAgents: vi.fn(),
}));

vi.mock('@/db/tenant', () => ({ withTenant: h.withTenant }));
vi.mock('@/domain/objectives/objectives', () => ({ listObjectives: h.listObjectives }));
vi.mock('@/domain/health/health', () => ({ assessWorkspaceHealth: h.assessWorkspaceHealth }));
vi.mock('@/domain/tasks/tasks', () => ({
  listTasks: h.listTasks,
  getTask: h.getTask,
  listRuns: h.listRuns,
  listRunSteps: h.listRunSteps,
}));
vi.mock('@/domain/questions/questions', () => ({ openQuestionsForOwner: h.openQuestionsForOwner }));
vi.mock('@/domain/approvals/approvals', () => ({
  listApprovalsForQueue: h.listApprovalsForQueue,
  getApprovalDetail: h.getApprovalDetail,
}));
vi.mock('@/domain/agents/agents', () => ({ listAgents: h.listAgents }));

import { createOpsChatToolset } from '@/domain/opschat/tools';

const PROJECTS = [
  { projectId: 'p-ab', orgId: 'o1', key: 'accuratebids', name: 'AccurateBids', description: '', projectRole: 'admin' as const },
  { projectId: 'p-sp', orgId: 'o1', key: 'stressprobe', name: 'StressProbe', description: '', projectRole: 'member' as const },
];
const AUTH = { userId: 'u1', projects: PROJECTS, orgRoles: new Map([['o1', 'owner' as const]]) };

beforeEach(() => {
  vi.clearAllMocks();
  // withTenant(ctx, fn) runs fn with a fake tx and returns its result.
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.listObjectives.mockResolvedValue([]);
  h.listAgents.mockResolvedValue([]);
  h.openQuestionsForOwner.mockResolvedValue([]);
  h.listApprovalsForQueue.mockResolvedValue([]);
});

describe('tool layer — reads are tenant-scoped to the caller', () => {
  it('resolves an authorized workspace and reads under its tenant context', async () => {
    h.listObjectives.mockResolvedValue([
      { id: 'o-1', title: 'Launch', status: 'active', successCriteria: [], progress: 0 },
    ]);
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(await ts.runTool({ name: 'list_objectives', input: { project: 'AccurateBids' } }));
    expect(out.workspace).toBe('AccurateBids');
    expect(out.objectives).toHaveLength(1);
    // Ran under the resolved project's tenant context.
    const ctx = h.withTenant.mock.calls[0]![0] as { projectId: string; userId: string };
    expect(ctx.projectId).toBe('p-ab');
    expect(ctx.userId).toBe('u1');
  });

  it('rejects an unknown / out-of-scope workspace', async () => {
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(await ts.runTool({ name: 'list_objectives', input: { project: 'kodisnap' } }));
    expect(out.error).toMatch(/No workspace matched/i);
    expect(h.withTenant).not.toHaveBeenCalled();
  });
});

describe('tool layer — propose tools record data only, never mutate', () => {
  it('propose_answer_question records a proposal for a question the owner can see', async () => {
    h.openQuestionsForOwner.mockResolvedValue([
      { questionId: 'q1', projectKey: 'accuratebids', workspaceName: 'AccurateBids', askedBy: null, question: 'ship it?', createdAt: new Date() },
    ]);
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(await ts.runTool({ name: 'propose_answer_question', input: { questionId: 'q1', answer: 'yes' } }));
    expect(out.prepared).toBe(true);
    const proposals = ts.getProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'answer_question', questionId: 'q1', answer: 'yes' });
  });

  it('propose_answer_question refuses a question the owner cannot see (no proposal)', async () => {
    h.openQuestionsForOwner.mockResolvedValue([]); // not among the owner's open questions
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(await ts.runTool({ name: 'propose_answer_question', input: { questionId: 'nope', answer: 'x' } }));
    expect(out.error).toBeTruthy();
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('propose_dispatch_task requires workspace admin', async () => {
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(
      await ts.runTool({ name: 'propose_dispatch_task', input: { project: 'StressProbe', title: 'x', instructions: 'do it' } }),
    );
    expect(out.error).toMatch(/admin/i);
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('propose_dispatch_task on an admin workspace records a proposal (and enqueues nothing)', async () => {
    h.listAgents.mockResolvedValue([{ id: 'a-1', name: 'Scout', role: 'researcher', enabled: true, provider: 'anthropic' }]);
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(
      await ts.runTool({ name: 'propose_dispatch_task', input: { project: 'AccurateBids', title: 'Research', instructions: 'go' } }),
    );
    expect(out.prepared).toBe(true);
    const proposals = ts.getProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'dispatch_task', projectKey: 'accuratebids', agentId: 'a-1' });
  });
});
