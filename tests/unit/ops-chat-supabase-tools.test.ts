import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops Chat Supabase bridge — the tool layer (Phase 2C, READ-ONLY). The read tools fetch project / edge-function
 * / migration state through the tenant boundary; none records a proposal or writes anything (there is no
 * Supabase executor or write tool yet). Fully mocked — no DB, no network.
 */

const h = vi.hoisted(() => {
  class SupabaseProjectNotLinkedError extends Error {}
  return {
    withTenant: vi.fn(),
    getSupabaseClient: vi.fn(),
    supabaseWorkspaceCapabilities: vi.fn(),
    listWorkspaceSupabaseProjects: vi.fn(),
    getWorkspaceSupabaseProject: vi.fn(),
    listWorkspaceEdgeFunctions: vi.fn(),
    listWorkspaceMigrations: vi.fn(),
    SupabaseProjectNotLinkedError,
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
  githubWorkspaceCapabilities: vi.fn(),
  listWorkspaceRepos: vi.fn(),
  listWorkspacePullRequests: vi.fn(),
  getWorkspacePullRequest: vi.fn(),
  getWorkspaceWorkflowRun: vi.fn(),
  RepoNotLinkedError: class extends Error {},
}));
vi.mock('@/domain/supabase/client', () => ({ getSupabaseClient: h.getSupabaseClient }));
vi.mock('@/domain/supabase/inspection', () => ({
  supabaseWorkspaceCapabilities: h.supabaseWorkspaceCapabilities,
  listWorkspaceSupabaseProjects: h.listWorkspaceSupabaseProjects,
  getWorkspaceSupabaseProject: h.getWorkspaceSupabaseProject,
  listWorkspaceEdgeFunctions: h.listWorkspaceEdgeFunctions,
  listWorkspaceMigrations: h.listWorkspaceMigrations,
  SupabaseProjectNotLinkedError: h.SupabaseProjectNotLinkedError,
}));

import { createOpsChatToolset } from '@/domain/opschat/tools';

const PROJECTS = [
  { projectId: 'p-ab', orgId: 'o1', key: 'accuratebids', name: 'AccurateBids', description: '', projectRole: 'admin' as const },
];
const AUTH = { userId: 'u1', projects: PROJECTS, orgRoles: new Map([['o1', 'owner' as const]]) };
const REF = 'bblnywrcdsfdasytkzps';

function toolset() {
  return createOpsChatToolset(AUTH);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.getSupabaseClient.mockReturnValue({});
  h.supabaseWorkspaceCapabilities.mockResolvedValue({ supabaseConfigured: true, linkedProjects: [{ projectRef: REF, label: 'AccurateBids' }], canInspect: true });
  h.listWorkspaceSupabaseProjects.mockResolvedValue([{ projectRef: REF, label: 'AccurateBids' }]);
  h.getWorkspaceSupabaseProject.mockResolvedValue({ ref: REF, name: 'AccurateBids', region: 'us-east-1', status: 'ACTIVE_HEALTHY', databaseVersion: '15.1' });
  h.listWorkspaceEdgeFunctions.mockResolvedValue([{ slug: 'approve-quote', name: 'approve-quote', status: 'ACTIVE', version: 32, verifyJwt: false, updatedAt: '2026-10-09T00:00:00Z' }]);
  h.listWorkspaceMigrations.mockResolvedValue([{ version: '20261009000000', name: 'contractor_recorded_quote_approval' }]);
});

describe('Supabase read tools — read-only, record no proposal', () => {
  it('supabase_capabilities returns capabilities and records no proposal', async () => {
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'supabase_capabilities', input: { project: 'accuratebids' } }));
    expect(out).toMatchObject({ workspace: 'AccurateBids', supabaseConfigured: true, canInspect: true });
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('list_supabase_projects returns linked projects', async () => {
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'list_supabase_projects', input: { project: 'accuratebids' } }));
    expect(out.projects).toEqual([{ projectRef: REF, label: 'AccurateBids' }]);
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('inspect_supabase_project returns project state', async () => {
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'inspect_supabase_project', input: { project: 'accuratebids', project_ref: REF } }));
    expect(out.project).toMatchObject({ ref: REF, name: 'AccurateBids', status: 'ACTIVE_HEALTHY' });
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('inspect_edge_functions returns the functions', async () => {
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'inspect_edge_functions', input: { project: 'accuratebids', project_ref: REF } }));
    expect(out.count).toBe(1);
    expect(out.edgeFunctions[0]).toMatchObject({ slug: 'approve-quote', version: 32, verifyJwt: false });
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('inspect_migrations returns the migrations', async () => {
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'inspect_migrations', input: { project: 'accuratebids', project_ref: REF } }));
    expect(out.count).toBe(1);
    expect(out.migrations[0]).toMatchObject({ version: '20261009000000' });
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('a not-linked project is reported as an error, never a crash', async () => {
    h.getWorkspaceSupabaseProject.mockRejectedValue(new h.SupabaseProjectNotLinkedError('Supabase project "x" is not linked to this workspace.'));
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'inspect_supabase_project', input: { project: 'accuratebids', project_ref: 'x' } }));
    expect(out.error).toMatch(/not linked/i);
    expect(ts.getProposals()).toHaveLength(0);
  });
});
