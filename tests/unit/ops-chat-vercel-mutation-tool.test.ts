import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops Chat Vercel mutation PROPOSE tools (Phase 2D). propose_vercel_redeploy/promote/rollback record a
 * confirmation proposal; they NEVER mutate and NEVER write. Admin-gated, linked-project only, exact ids. Mocked.
 */

const h = vi.hoisted(() => ({ withTenant: vi.fn(), listWorkspaceVercelProjects: vi.fn() }));
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
vi.mock('@/domain/vercel/client', () => ({ getVercelClient: vi.fn() }));
vi.mock('@/domain/vercel/inspection', () => ({
  vercelWorkspaceCapabilities: vi.fn(),
  listWorkspaceVercelProjects: h.listWorkspaceVercelProjects,
  getWorkspaceVercelProject: vi.fn(),
  listWorkspaceVercelDeployments: vi.fn(),
  VercelProjectNotLinkedError: class extends Error {},
}));

import { createOpsChatToolset } from '@/domain/opschat/tools';

const PRJ = 'prj_accuratebids0001xyz';
const TARGET = 'dpl_target00000001';
const CURRENT = 'dpl_current0000002';
const SOURCE = 'dpl_source0000003';
const SHA = 'a'.repeat(40);
const ADMIN = { projectId: 'p-ab', orgId: 'o1', key: 'accuratebids', name: 'AccurateBids', description: '', projectRole: 'admin' as const };
const MEMBER = { ...ADMIN, projectRole: 'member' as const };
const toolset = (role: 'admin' | 'member' = 'admin') =>
  createOpsChatToolset({ userId: 'u1', projects: [role === 'admin' ? ADMIN : MEMBER], orgRoles: new Map([['o1', 'owner' as const]]) });

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.listWorkspaceVercelProjects.mockResolvedValue([{ vercelProjectId: PRJ, vercelTeamId: null, label: 'AccurateBids' }]);
});

describe('propose_vercel_* tools', () => {
  it('propose_vercel_promote records one vercel_mutation proposal (promote), no write', async () => {
    const ts = toolset('admin');
    const out = JSON.parse(await ts.runTool({ name: 'propose_vercel_promote', input: { project: 'accuratebids', vercel_project_id: PRJ, target_deployment_id: TARGET, expected_target_sha: SHA, expected_current_production_deployment_id: CURRENT } }));
    expect(out.prepared).toBe(true);
    const proposals = ts.getProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'vercel_mutation', operation: 'promote', vercelProjectId: PRJ, targetDeploymentId: TARGET, expectedCurrentProductionDeploymentId: CURRENT });
  });

  it('propose_vercel_redeploy records a redeploy proposal with source id + SHA', async () => {
    const ts = toolset('admin');
    const out = JSON.parse(await ts.runTool({ name: 'propose_vercel_redeploy', input: { project: 'accuratebids', vercel_project_id: PRJ, source_deployment_id: SOURCE, expected_source_sha: SHA } }));
    expect(out.prepared).toBe(true);
    expect(ts.getProposals()[0]).toMatchObject({ kind: 'vercel_mutation', operation: 'redeploy', sourceDeploymentId: SOURCE });
  });

  it('refuses a non-admin with no proposal', async () => {
    const ts = toolset('member');
    const out = JSON.parse(await ts.runTool({ name: 'propose_vercel_rollback', input: { project: 'accuratebids', vercel_project_id: PRJ, target_deployment_id: TARGET, expected_target_sha: SHA, expected_current_production_deployment_id: CURRENT } }));
    expect(out.error).toMatch(/admin/i);
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('refuses an unlinked project', async () => {
    h.listWorkspaceVercelProjects.mockResolvedValue([]);
    const ts = toolset('admin');
    const out = JSON.parse(await ts.runTool({ name: 'propose_vercel_promote', input: { project: 'accuratebids', vercel_project_id: PRJ, target_deployment_id: TARGET, expected_target_sha: SHA, expected_current_production_deployment_id: CURRENT } }));
    expect(out.error).toMatch(/not linked/i);
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('refuses a bad deployment id with no proposal', async () => {
    const ts = toolset('admin');
    const out = JSON.parse(await ts.runTool({ name: 'propose_vercel_promote', input: { project: 'accuratebids', vercel_project_id: PRJ, target_deployment_id: 'nope', expected_target_sha: SHA, expected_current_production_deployment_id: CURRENT } }));
    expect(out.error).toMatch(/not valid/i);
    expect(ts.getProposals()).toHaveLength(0);
  });
});
