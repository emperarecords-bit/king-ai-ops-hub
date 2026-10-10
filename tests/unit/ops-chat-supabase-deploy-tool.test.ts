import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops Chat Supabase DEPLOY tool (Phase 2C write slice) — the PROPOSE side. propose_supabase_deploy records a
 * confirmation proposal; it NEVER deploys and NEVER writes. It requires workspace-admin, a linked target project,
 * a linked source repo, and a valid exact-SHA payload. Fully mocked — no DB, no network.
 */

const h = vi.hoisted(() => ({
  withTenant: vi.fn(),
  listRepoLinks: vi.fn(),
  listWorkspaceSupabaseProjects: vi.fn(),
}));

vi.mock('@/db/tenant', () => ({ withTenant: h.withTenant }));
vi.mock('@/domain/objectives/objectives', () => ({ listObjectives: vi.fn() }));
vi.mock('@/domain/health/health', () => ({ assessWorkspaceHealth: vi.fn() }));
vi.mock('@/domain/tasks/tasks', () => ({ listTasks: vi.fn(), getTask: vi.fn(), listRuns: vi.fn(), listRunSteps: vi.fn() }));
vi.mock('@/domain/questions/questions', () => ({ openQuestionsForOwner: vi.fn() }));
vi.mock('@/domain/approvals/approvals', () => ({ listApprovalsForQueue: vi.fn(), getApprovalDetail: vi.fn() }));
vi.mock('@/domain/agents/agents', () => ({ listAgents: vi.fn() }));
vi.mock('@/domain/github/links', () => ({ listRepoLinks: h.listRepoLinks }));
vi.mock('@/domain/github/client', () => ({ getGitHubClient: vi.fn() }));
vi.mock('@/domain/github/inspection', () => ({
  githubWorkspaceCapabilities: vi.fn(),
  listWorkspaceRepos: vi.fn(),
  listWorkspacePullRequests: vi.fn(),
  getWorkspacePullRequest: vi.fn(),
  getWorkspaceWorkflowRun: vi.fn(),
  RepoNotLinkedError: class extends Error {},
}));
vi.mock('@/domain/supabase/client', () => ({ getSupabaseClient: vi.fn() }));
vi.mock('@/domain/supabase/inspection', () => ({
  supabaseWorkspaceCapabilities: vi.fn(),
  listWorkspaceSupabaseProjects: h.listWorkspaceSupabaseProjects,
  getWorkspaceSupabaseProject: vi.fn(),
  listWorkspaceEdgeFunctions: vi.fn(),
  listWorkspaceMigrations: vi.fn(),
  SupabaseProjectNotLinkedError: class extends Error {},
}));

import { createOpsChatToolset } from '@/domain/opschat/tools';

const REF = 'bblnywrcdsfdasytkzps';
const REPO = 'emperarecords-bit/accuratebids';
const SHA = 'a'.repeat(40);
const ADMIN_PROJECT = { projectId: 'p-ab', orgId: 'o1', key: 'accuratebids', name: 'AccurateBids', description: '', projectRole: 'admin' as const };
const MEMBER_PROJECT = { ...ADMIN_PROJECT, projectRole: 'member' as const };

function toolset(projectRole: 'admin' | 'member' = 'admin') {
  const projects = [projectRole === 'admin' ? ADMIN_PROJECT : MEMBER_PROJECT];
  return createOpsChatToolset({ userId: 'u1', projects, orgRoles: new Map([['o1', 'owner' as const]]) });
}

const INPUT = {
  project: 'accuratebids',
  project_ref: REF,
  function_slug: 'approve-quote',
  source_repo: REPO,
  source_sha: SHA,
  source_path: 'supabase/functions/approve-quote',
  verify_jwt: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.listWorkspaceSupabaseProjects.mockResolvedValue([{ projectRef: REF, label: 'AccurateBids' }]);
  h.listRepoLinks.mockResolvedValue([{ repoFullName: REPO, installationId: 1n, defaultBranch: 'main' }]);
});

describe('propose_supabase_deploy', () => {
  it('records exactly one supabase_deploy proposal for a valid, linked deploy — and writes nothing', async () => {
    const ts = toolset('admin');
    const out = JSON.parse(await ts.runTool({ name: 'propose_supabase_deploy', input: INPUT }));
    expect(out.prepared).toBe(true);
    const proposals = ts.getProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: 'supabase_deploy', projectRef: REF, functionSlug: 'approve-quote', sourceRepo: REPO, sourceSha: SHA, verifyJwt: false });
  });

  it('refuses a non-admin with no proposal', async () => {
    const ts = toolset('member');
    const out = JSON.parse(await ts.runTool({ name: 'propose_supabase_deploy', input: INPUT }));
    expect(out.error).toMatch(/admin/i);
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('refuses when the target Supabase project is not linked', async () => {
    h.listWorkspaceSupabaseProjects.mockResolvedValue([]);
    const ts = toolset('admin');
    const out = JSON.parse(await ts.runTool({ name: 'propose_supabase_deploy', input: INPUT }));
    expect(out.error).toMatch(/not linked/i);
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('refuses when the source repo is not linked', async () => {
    h.listRepoLinks.mockResolvedValue([]);
    const ts = toolset('admin');
    const out = JSON.parse(await ts.runTool({ name: 'propose_supabase_deploy', input: INPUT }));
    expect(out.error).toMatch(/not linked/i);
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('refuses a branch/short SHA (exact source SHA required) with no proposal', async () => {
    const ts = toolset('admin');
    const out = JSON.parse(await ts.runTool({ name: 'propose_supabase_deploy', input: { ...INPUT, source_sha: 'main' } }));
    expect(out.error).toMatch(/not valid/i);
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('lowercases an uppercase SHA so the confirm boundary (lowercase) accepts it', async () => {
    const ts = toolset('admin');
    await ts.runTool({ name: 'propose_supabase_deploy', input: { ...INPUT, source_sha: 'A'.repeat(40) } });
    const proposals = ts.getProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ sourceSha: 'a'.repeat(40) });
  });
});
