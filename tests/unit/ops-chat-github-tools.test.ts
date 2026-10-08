import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops Chat GitHub bridge — the tool layer (Phase 2A). The READ tools fetch repo/PR/CI state through the
 * tenant boundary; the PROPOSE tool only RECORDS a proposal. Neither writes or executes: there is no
 * executor, approval, or dispatch import in the model-facing tool layer. Fully mocked — no DB, no network.
 */

const h = vi.hoisted(() => {
  class RepoNotLinkedError extends Error {}
  return {
    withTenant: vi.fn(),
    listRepoLinks: vi.fn(),
    getGitHubClient: vi.fn(),
    githubWorkspaceCapabilities: vi.fn(),
    listWorkspaceRepos: vi.fn(),
    listWorkspacePullRequests: vi.fn(),
    getWorkspacePullRequest: vi.fn(),
    RepoNotLinkedError,
  };
});

vi.mock('@/db/tenant', () => ({ withTenant: h.withTenant }));
vi.mock('@/domain/objectives/objectives', () => ({ listObjectives: vi.fn() }));
vi.mock('@/domain/health/health', () => ({ assessWorkspaceHealth: vi.fn() }));
vi.mock('@/domain/tasks/tasks', () => ({ listTasks: vi.fn(), getTask: vi.fn(), listRuns: vi.fn(), listRunSteps: vi.fn() }));
vi.mock('@/domain/questions/questions', () => ({ openQuestionsForOwner: vi.fn() }));
vi.mock('@/domain/approvals/approvals', () => ({ listApprovalsForQueue: vi.fn(), getApprovalDetail: vi.fn() }));
vi.mock('@/domain/agents/agents', () => ({ listAgents: vi.fn() }));
vi.mock('@/domain/github/links', () => ({ listRepoLinks: h.listRepoLinks }));
vi.mock('@/domain/github/client', () => ({ getGitHubClient: h.getGitHubClient }));
vi.mock('@/domain/github/inspection', () => ({
  githubWorkspaceCapabilities: h.githubWorkspaceCapabilities,
  listWorkspaceRepos: h.listWorkspaceRepos,
  listWorkspacePullRequests: h.listWorkspacePullRequests,
  getWorkspacePullRequest: h.getWorkspacePullRequest,
  RepoNotLinkedError: h.RepoNotLinkedError,
}));

import { createOpsChatToolset } from '@/domain/opschat/tools';

const PROJECTS = [
  { projectId: 'p-ab', orgId: 'o1', key: 'accuratebids', name: 'AccurateBids', description: '', projectRole: 'admin' as const },
  { projectId: 'p-sp', orgId: 'o1', key: 'stressprobe', name: 'StressProbe', description: '', projectRole: 'member' as const },
];
const AUTH = { userId: 'u1', projects: PROJECTS, orgRoles: new Map([['o1', 'owner' as const]]) };
const LINK = { id: 'l1', installationId: 1n, repoFullName: 'emperarecords-bit/king-ai-ops-hub', defaultBranch: 'main', linkedBy: 'u1', createdAt: new Date() };

function toolset() {
  return createOpsChatToolset(AUTH);
}
const call = (name: string, input: unknown) => toolset().runTool({ name, input });

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.listRepoLinks.mockResolvedValue([LINK]);
  h.getGitHubClient.mockReturnValue({});
  h.githubWorkspaceCapabilities.mockResolvedValue({
    githubConfigured: true,
    gitPr: { actionType: 'git_pr', riskClass: 'external_reversible', executorRegistered: true, executorEnabled: true, confirmationRequired: true },
    linkedRepos: [{ repoFullName: LINK.repoFullName, defaultBranch: 'main' }],
    canProposePr: true,
  });
  h.listWorkspaceRepos.mockResolvedValue([{ repoFullName: LINK.repoFullName, defaultBranch: 'main' }]);
  h.listWorkspacePullRequests.mockResolvedValue([{ number: 5, title: 'x', state: 'open', draft: false, merged: false, headRef: 'f', headSha: 'abc', baseRef: 'main', url: 'https://github.com/x/5' }]);
  h.getWorkspacePullRequest.mockResolvedValue({ pr: { number: 5, title: 'x', state: 'open', draft: false, merged: false, headRef: 'f', headSha: 'abc', baseRef: 'main', url: 'u' }, checks: { ref: 'abc', state: 'success', checks: [] } });
});

const validFiles = [{ path: 'docs/note.md', content: 'A real line of content.' }];

describe('GitHub read tools — read-only, never record a proposal', () => {
  it('github_capabilities returns capabilities and records no proposal', async () => {
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({ name: 'github_capabilities', input: { project: 'accuratebids' } }));
    expect(out.workspace).toBe('AccurateBids');
    expect(out.canProposePr).toBe(true);
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('list_github_repos / list_pull_requests / get_pull_request read and record no proposal', async () => {
    const ts = toolset();
    expect(JSON.parse(await ts.runTool({ name: 'list_github_repos', input: { project: 'accuratebids' } })).repos).toHaveLength(1);
    expect(JSON.parse(await ts.runTool({ name: 'list_pull_requests', input: { project: 'accuratebids', repo: LINK.repoFullName } })).count).toBe(1);
    const pr = JSON.parse(await ts.runTool({ name: 'get_pull_request', input: { project: 'accuratebids', repo: LINK.repoFullName, number: 5 } }));
    expect(pr.ci.state).toBe('success');
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('a repo not linked to the workspace is refused (not a silent empty)', async () => {
    h.listWorkspacePullRequests.mockRejectedValue(new h.RepoNotLinkedError('Repository "x/y" is not linked to this workspace.'));
    const out = JSON.parse(await call('list_pull_requests', { project: 'accuratebids', repo: 'x/y' }));
    expect(out.error).toContain('not linked');
  });
});

describe('propose_github_pr — prepares a proposal, executes nothing', () => {
  it('a valid proposal is recorded with the exact target/risk and NO execution occurs', async () => {
    const ts = toolset();
    const out = JSON.parse(await ts.runTool({
      name: 'propose_github_pr',
      input: { project: 'accuratebids', repo: LINK.repoFullName, branch: 'hub/fix-1', title: 'Fix', files: validFiles },
    }));
    expect(out.prepared).toBe(true);
    const proposals = ts.getProposals();
    expect(proposals).toHaveLength(1);
    const p = proposals[0]!;
    expect(p.kind).toBe('github_pr');
    if (p.kind === 'github_pr') {
      expect(p.repo).toBe(LINK.repoFullName);
      expect(p.branch).toBe('hub/fix-1');
      expect(p.baseBranch).toBe('main'); // resolved default branch
      expect(p.riskClass).toBe('external_reversible');
      expect(p.files).toEqual(validFiles);
    }
    // No write/execute path exists in the tool layer: listRepoLinks is the only DB touch, and it READS.
    expect(h.getGitHubClient).not.toHaveBeenCalled();
  });

  it('refuses a non-admin workspace', async () => {
    const out = JSON.parse(await call('propose_github_pr', { project: 'stressprobe', repo: LINK.repoFullName, branch: 'hub/x', title: 'T', files: validFiles }));
    expect(out.error).toContain('admin');
  });

  it('refuses an unlinked repository', async () => {
    const out = JSON.parse(await call('propose_github_pr', { project: 'accuratebids', repo: 'someone/else', branch: 'hub/x', title: 'T', files: validFiles }));
    expect(out.error).toContain('not linked');
  });

  it('refuses writing to the default/protected branch', async () => {
    for (const branch of ['main', 'master']) {
      const out = JSON.parse(await call('propose_github_pr', { project: 'accuratebids', repo: LINK.repoFullName, branch, title: 'T', files: validFiles }));
      expect(out.error).toMatch(/default|protected/i);
    }
  });

  it('refuses placeholder file content', async () => {
    const out = JSON.parse(await call('propose_github_pr', {
      project: 'accuratebids', repo: LINK.repoFullName, branch: 'hub/x', title: 'T',
      files: [{ path: 'a.ts', content: '<COMPLETE FILE CONTENT NEEDED>' }],
    }));
    expect(out.error).toContain('placeholder');
  });

  it('refuses a malformed payload (no files)', async () => {
    const out = JSON.parse(await call('propose_github_pr', { project: 'accuratebids', repo: LINK.repoFullName, branch: 'hub/x', title: 'T', files: [] }));
    expect(out.error).toMatch(/not valid|files/i);
  });
});

describe('CENTRAL SECURITY PROMISE — "create a PR" reaches a confirm card, mutates NOTHING until Confirm', () => {
  it('a propose_github_pr call produces a confirmation card but performs ZERO GitHub mutation', async () => {
    // Wire a GitHub client whose MUTATING methods fail the test if ever touched.
    const writeCalled: string[] = [];
    h.getGitHubClient.mockReturnValue({
      listTree: async () => [],
      readBlob: async () => '',
      listPullRequests: async () => [],
      getPullRequest: async () => ({}),
      getRefChecks: async () => ({ ref: '', state: 'unknown', checks: [] }),
      createBranch: async () => { writeCalled.push('createBranch'); },
      commitToBranch: async () => { writeCalled.push('commitToBranch'); },
      openPullRequest: async () => { writeCalled.push('openPullRequest'); return { prNumber: 1 }; },
    });

    const ts = toolset();
    const out = JSON.parse(await ts.runTool({
      name: 'propose_github_pr',
      input: { project: 'accuratebids', repo: LINK.repoFullName, branch: 'hub/fix-1', title: 'Fix', files: validFiles },
    }));

    // A confirmation card is prepared …
    expect(out.prepared).toBe(true);
    expect(ts.getProposals()).toHaveLength(1);
    expect(ts.getProposals()[0]!.kind).toBe('github_pr');
    // … and NOTHING was mutated on GitHub: no branch, no commit, no PR. The client was not even obtained
    // during propose (the propose path only validates + records; the executor behind confirm does the write).
    expect(writeCalled).toEqual([]);
    expect(h.getGitHubClient).not.toHaveBeenCalled();
  });
});
