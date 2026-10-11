import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops Chat Vercel bridge — the read tools (Phase 2D, READ-ONLY). They fetch project + deployment state through
 * the tenant boundary; none records a proposal or writes anything (there is no Vercel executor or write tool
 * yet). Fully mocked — no DB, no network.
 */

const h = vi.hoisted(() => {
  class VercelProjectNotLinkedError extends Error {}
  return {
    withTenant: vi.fn(),
    getVercelClient: vi.fn(),
    vercelWorkspaceCapabilities: vi.fn(),
    listWorkspaceVercelProjects: vi.fn(),
    getWorkspaceVercelProject: vi.fn(),
    listWorkspaceVercelDeployments: vi.fn(),
    VercelProjectNotLinkedError,
  };
});

vi.mock('@/db/tenant', () => ({ withTenant: h.withTenant }));
vi.mock('@/domain/objectives/objectives', () => ({ listObjectives: vi.fn() }));
vi.mock('@/domain/health/health', () => ({ assessWorkspaceHealth: vi.fn() }));
vi.mock('@/domain/tasks/tasks', () => ({ listTasks: vi.fn(), getTask: vi.fn(), listRuns: vi.fn(), listRunSteps: vi.fn() }));
vi.mock('@/domain/questions/questions', () => ({ openQuestionsForOwner: vi.fn() }));
vi.mock('@/domain/approvals/approvals', () => ({ listApprovalsForQueue: vi.fn(), getApprovalDetail: vi.fn() }));
vi.mock('@/domain/agents/agents', () => ({ listAgents: vi.fn() }));
vi.mock('@/domain/github/links', () => ({ listRepoLinks: vi.fn() }));
vi.mock('@/domain/github/client', () => ({ getGitHubClient: vi.fn() }));
vi.mock('@/domain/github/inspection', () => ({
  githubWorkspaceCapabilities: vi.fn(), listWorkspaceRepos: vi.fn(), listWorkspacePullRequests: vi.fn(),
  getWorkspacePullRequest: vi.fn(), getWorkspaceWorkflowRun: vi.fn(), RepoNotLinkedError: class extends Error {},
}));
vi.mock('@/domain/supabase/client', () => ({ getSupabaseClient: vi.fn() }));
vi.mock('@/domain/supabase/inspection', () => ({
  supabaseWorkspaceCapabilities: vi.fn(), listWorkspaceSupabaseProjects: vi.fn(), getWorkspaceSupabaseProject: vi.fn(),
  listWorkspaceEdgeFunctions: vi.fn(), listWorkspaceMigrations: vi.fn(), SupabaseProjectNotLinkedError: class extends Error {},
}));
vi.mock('@/domain/vercel/client', () => ({ getVercelClient: h.getVercelClient }));
vi.mock('@/domain/vercel/inspection', () => ({
  vercelWorkspaceCapabilities: h.vercelWorkspaceCapabilities,
  listWorkspaceVercelProjects: h.listWorkspaceVercelProjects,
  getWorkspaceVercelProject: h.getWorkspaceVercelProject,
  listWorkspaceVercelDeployments: h.listWorkspaceVercelDeployments,
  VercelProjectNotLinkedError: h.VercelProjectNotLinkedError,
}));

import { createOpsChatToolset } from '@/domain/opschat/tools';

const PROJECTS = [{ projectId: 'p-ab', orgId: 'o1', key: 'accuratebids', name: 'AccurateBids', description: '', projectRole: 'admin' as const }];
const AUTH = { userId: 'u1', projects: PROJECTS, orgRoles: new Map([['o1', 'owner' as const]]) };
const VID = 'prj_accuratebids0001xyz';
const toolset = () => createOpsChatToolset(AUTH);

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.getVercelClient.mockReturnValue({});
  h.vercelWorkspaceCapabilities.mockResolvedValue({ vercelConfigured: true, linkedProjects: [{ vercelProjectId: VID, vercelTeamId: null, label: 'AccurateBids' }], canInspect: true });
  h.listWorkspaceVercelProjects.mockResolvedValue([{ vercelProjectId: VID, vercelTeamId: null, label: 'AccurateBids' }]);
  h.getWorkspaceVercelProject.mockResolvedValue({ id: VID, name: 'accuratebids', framework: 'nextjs', productionUrl: 'accuratebids.com' });
  h.listWorkspaceVercelDeployments.mockResolvedValue([
    { id: 'dpl_1', url: 'ab.vercel.app', state: 'READY', target: 'production', sourceSha: 'a'.repeat(40), branch: 'main', createdAt: '2026-10-10T00:00:00Z', inspectorUrl: 'https://vercel.com/x/dpl_1' },
  ]);
});

describe('Vercel read tools — read-only, record no proposal', () => {
  it('vercel_capabilities returns capabilities and records no proposal', async () => {
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'vercel_capabilities', input: { project: 'accuratebids' } }));
    expect(out).toMatchObject({ workspace: 'AccurateBids', vercelConfigured: true, canInspect: true });
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('list_vercel_projects returns linked projects', async () => {
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'list_vercel_projects', input: { project: 'accuratebids' } }));
    expect(out.projects).toEqual([{ vercelProjectId: VID, vercelTeamId: null, label: 'AccurateBids' }]);
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('inspect_vercel_project returns project state', async () => {
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'inspect_vercel_project', input: { project: 'accuratebids', vercel_project_id: VID } }));
    expect(out.project).toMatchObject({ id: VID, name: 'accuratebids', productionUrl: 'accuratebids.com' });
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('inspect_vercel_deployments returns deployments with target + source SHA', async () => {
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'inspect_vercel_deployments', input: { project: 'accuratebids', vercel_project_id: VID } }));
    expect(out.count).toBe(1);
    expect(out.deployments[0]).toMatchObject({ target: 'production', state: 'READY', sourceSha: 'a'.repeat(40) });
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('a not-linked project is reported as an error, never a crash', async () => {
    h.getWorkspaceVercelProject.mockRejectedValue(new h.VercelProjectNotLinkedError('Vercel project "x" is not linked to this workspace.'));
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'inspect_vercel_project', input: { project: 'accuratebids', vercel_project_id: 'x' } }));
    expect(out.error).toMatch(/not linked/i);
    expect(ts.getProposals()).toHaveLength(0);
  });
});
