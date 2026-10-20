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

describe('tool layer — list_open_questions duplicate groups', () => {
  it('reports every question plus same-workspace duplicate groups whose ids match the individual questions', async () => {
    const at = new Date('2026-10-01T00:00:00Z');
    h.openQuestionsForOwner.mockResolvedValue([
      { questionId: 'q1', projectKey: 'empera', workspaceName: 'Empera', askedBy: 'Bookkeeper', question: 'Which bank?', createdAt: at },
      { questionId: 'q2', projectKey: 'empera', workspaceName: 'Empera', askedBy: 'Bookkeeper', question: 'which  bank', createdAt: at },
      { questionId: 'q3', projectKey: 'accuratebids', workspaceName: 'AccurateBids', askedBy: null, question: 'Which bank?', createdAt: at },
    ]);
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(await ts.runTool({ name: 'list_open_questions', input: {} }));
    expect(out.count).toBe(3);
    expect(out.questions).toHaveLength(3);
    expect(out.distinctCount).toBe(2);
    expect(out.duplicateGroups).toEqual([{ workspace: 'Empera', question: 'which  bank', count: 2, questionIds: ['q1', 'q2'] }]);
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
    h.listAgents.mockResolvedValue([{ id: 'a-1', name: 'Scout', role: 'primary', enabled: true, provider: 'anthropic' }]);
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

describe('agent truth — server-cooling regression (said "Research Analyst" at 11:31, card dispatched Marketing Lead at 11:41)', () => {
  const TWO = [
    { id: 'ml', name: 'Marketing Lead (Empera Air Conditioning and Heating)', role: 'primary', enabled: true, provider: 'google' },
    { id: 'ra', name: 'Research Analyst (Empera Air Conditioning and Heating)', role: 'primary', enabled: true, provider: 'anthropic' },
    { id: 'rv', name: 'Reviewer (Empera)', role: 'reviewer', enabled: true, provider: 'anthropic' },
  ];
  const dispatch = async (agent?: string) => {
    h.listAgents.mockResolvedValue(TWO);
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(
      await ts.runTool({ name: 'propose_dispatch_task', input: { project: 'AccurateBids', title: 'Punch list', instructions: 'go', ...(agent ? { agent } : {}) } }),
    );
    return { out, proposals: ts.getProposals() };
  };

  it('with several agents and none named, NOTHING is prepared — the old silent "first agent" default is gone', async () => {
    const { out, proposals } = await dispatch();
    expect(out.error).toMatch(/several agents — name the one/);
    expect(out.agents).toEqual(expect.arrayContaining([TWO[0]!.name, TWO[1]!.name]));
    expect(proposals).toHaveLength(0);
  });

  it('naming "Research Analyst" puts Research Analyst on the card — id AND name — and the result tells the model to use exactly that name', async () => {
    const { out, proposals } = await dispatch('Research Analyst');
    expect(proposals[0]).toMatchObject({ kind: 'dispatch_task', agentId: 'ra', agentName: TWO[1]!.name });
    expect(out.agent).toBe(TWO[1]!.name);
    expect(out.note).toContain(`name exactly "${TWO[1]!.name}"`);
  });

  it('a reviewer in the workspace is assigned on the card; reviewers can never own the task', async () => {
    const { proposals } = await dispatch('Research Analyst');
    expect(proposals[0]).toMatchObject({ reviewerAgentId: 'rv', reviewerName: 'Reviewer (Empera)' });
    expect((await dispatch('Reviewer')).out.error).toMatch(/No enabled primary agent named/);
  });

  it('no reviewer in the workspace → the card and the note say UNREVIEWED DRAFT (not final)', async () => {
    h.listAgents.mockResolvedValue([TWO[1]]);
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(await ts.runTool({ name: 'propose_dispatch_task', input: { project: 'AccurateBids', title: 'x', instructions: 'y' } }));
    expect(ts.getProposals()[0]).toMatchObject({ agentId: 'ra', reviewerAgentId: null });
    expect(out.note).toMatch(/UNREVIEWED DRAFT \(intermediate, not final\)/);
  });
});

describe('get_task_detail — near-duplicate titles are never guessed', () => {
  it('two tasks with the same title → ambiguous with both candidates, no detail read', async () => {
    h.listTasks.mockResolvedValue([
      { id: 't1', title: 'Server Cabinet Cooling — Dual FUSION-TEC Punch List', status: 'completed', createdAt: new Date('2026-10-19T11:41:34Z') },
      { id: 't2', title: 'Server Cabinet Cooling — Dual FUSION-TEC Punch List', status: 'completed', createdAt: new Date('2026-10-19T12:33:58Z') },
    ]);
    const ts = createOpsChatToolset(AUTH);
    const out = JSON.parse(await ts.runTool({ name: 'get_task_detail', input: { project: 'AccurateBids', task: 'Server Cabinet Cooling' } }));
    expect(out.ambiguous).toBe(true);
    expect(out.candidates.map((c: { id: string }) => c.id)).toEqual(['t1', 't2']);
    expect(h.getTask).not.toHaveBeenCalled();
  });
});
