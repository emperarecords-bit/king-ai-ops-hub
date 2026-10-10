import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Ops Chat validate_supabase_sql tool (Phase 2C, Option B). It DRY-RUN validates a single DML against a linked
 * project: admin-gated, read-only, records NO proposal and performs NO write, and always reports that live
 * execution is unavailable. Fully mocked — no DB, no network.
 */

const h = vi.hoisted(() => {
  class SqlNotLinked extends Error {}
  return { withTenant: vi.fn(), validateWorkspaceApprovedSql: vi.fn(), SqlNotLinked };
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
vi.mock('@/domain/supabase/approved-sql', () => ({
  validateWorkspaceApprovedSql: h.validateWorkspaceApprovedSql,
  SupabaseProjectNotLinkedError: h.SqlNotLinked,
}));

import { createOpsChatToolset } from '@/domain/opschat/tools';

const REF = 'bblnywrcdsfdasytkzps';
const ADMIN = { projectId: 'p-ab', orgId: 'o1', key: 'accuratebids', name: 'AccurateBids', description: '', projectRole: 'admin' as const };
const MEMBER = { ...ADMIN, projectRole: 'member' as const };
const toolset = (role: 'admin' | 'member' = 'admin') =>
  createOpsChatToolset({ userId: 'u1', projects: [role === 'admin' ? ADMIN : MEMBER], orgRoles: new Map([['o1', 'owner' as const]]) });
const INPUT = { project: 'accuratebids', project_ref: REF, sql: 'update public.quotes set status = $1 where id = $2', params: ['approved', 1], max_rows: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenant.mockImplementation((_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}));
  h.validateWorkspaceApprovedSql.mockResolvedValue({
    projectRef: REF, accepted: true, violations: [], maxRows: 1, paramCount: 2,
    riskClass: 'destructive_irreversible', liveExecutionAvailable: false,
    liveExecutionUnavailableReason: 'not provably reversible', rollbackEvidence: 'no generic rollback',
    policy: { ok: true, operation: 'update', schema: 'public', table: 'quotes', hasWhere: true, referencedParameters: ['$1', '$2'], normalizedSql: 'UPDATE public.quotes …', violations: [] },
  });
});

describe('validate_supabase_sql', () => {
  it('returns the validation report, records NO proposal, and reports live execution unavailable', async () => {
    const ts = toolset('admin');
    const out = JSON.parse(await ts.runTool({ name: 'validate_supabase_sql', input: INPUT }));
    expect(out.accepted).toBe(true);
    expect(out.liveExecutionAvailable).toBe(false);
    expect(out.riskClass).toBe('destructive_irreversible');
    expect(ts.getProposals()).toHaveLength(0); // never prepares an executable proposal
    expect(h.validateWorkspaceApprovedSql).toHaveBeenCalledTimes(1);
  });

  it('refuses a non-admin and never calls the validator', async () => {
    const ts = toolset('member');
    const out = JSON.parse(await ts.runTool({ name: 'validate_supabase_sql', input: INPUT }));
    expect(out.error).toMatch(/admin/i);
    expect(h.validateWorkspaceApprovedSql).not.toHaveBeenCalled();
    expect(ts.getProposals()).toHaveLength(0);
  });

  it('surfaces a not-linked project as an error, not a crash', async () => {
    h.validateWorkspaceApprovedSql.mockRejectedValue(new h.SqlNotLinked('Supabase project "x" is not linked to this workspace.'));
    const ts = toolset('admin');
    const out = JSON.parse(await ts.runTool({ name: 'validate_supabase_sql', input: { ...INPUT, project_ref: 'x' } }));
    expect(out.error).toMatch(/not linked/i);
    expect(ts.getProposals()).toHaveLength(0);
  });
});
