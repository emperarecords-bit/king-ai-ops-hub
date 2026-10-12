import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { validateExecutorResult, type ExecutorAction } from '@/domain/execution/executor-contract';
import { GitPrExecutor, type GitPrRepoLink } from '@/domain/execution/git-pr-executor';
import {
  type GitHubRepoClient,
  type RepoRef,
  type RepoCommitSummary,
  type RepoFullTreeEntry,
  type RepoCompareResult,
  type RepoTreeOverride,
} from '@/domain/github/client';
import { GitHubApiError } from '@/domain/github/live-client';

/**
 * Phase 2E — revert_commit executor governance. The revert rides the git_pr executor (no new DB action type), so
 * the shared invariants (payload hash, admin, confirmation, enablement, idempotency) are covered by the dispatch
 * tests. Here we prove the v1 contract: first-parent baseline, exact-identity tree-delta classification, the
 * staleness / reachability / conflict / no-op / unsupported BLOCK boundaries, the branch-collision guard, and the
 * partial-outcome ambiguity contract — all WITHOUT a local clone and WITHOUT writing the default branch.
 */

const LINK: GitPrRepoLink = { installationId: 153529449n, repoFullName: 'emperarecords-bit/accuratebids', defaultBranch: 'main' };
const TARGET = 'd'.repeat(40); // the commit to revert
const BASELINE = 'b'.repeat(40); // target's first parent
const BASE_HEAD = 'e'.repeat(40); // current head of main
const REVERT_COMMIT = 'f'.repeat(40);
const REVERT_BRANCH = 'hub/revert-dddddd';

function action(payload: Record<string, unknown>, mode: 'dry_run' | 'live' = 'live'): ExecutorAction {
  return {
    contractVersion: '1', actionType: 'git_pr', payload, payloadSha256: sha256Hex(canonicalJson(payload)),
    riskClass: 'external_reversible', orgId: 'org', projectId: 'project', approvalId: 'approval', taskId: 'task',
    runId: null, correlationId: 'corr', idempotencyKey: '1234567890123456', mode,
    authorization: { actorId: 'actor', orgId: 'org', projectId: 'project', projectRole: 'admin', resolvedAt: '2026-10-12T12:00:00.000Z', source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: 'actor', confirmedAt: '2026-10-12T11:59:00.000Z', expiresAt: '2026-10-12T12:05:00.000Z', payloadSha256: sha256Hex(canonicalJson(payload)) },
  };
}

const revertPayload = (o: Record<string, unknown> = {}) => ({
  operation: 'revert_commit', repo: LINK.repoFullName, targetSha: TARGET,
  expectedBaseBranch: 'main', expectedBaseHeadSha: BASE_HEAD, revertBranch: REVERT_BRANCH, ...o,
});

// A blob entry helper: by default distinct sha per (path, tag).
const blob = (path: string, sha: string, mode = '100644'): RepoFullTreeEntry => ({ path, mode, type: 'blob', sha });

interface BuildOpts {
  /** commit sha → summary. Branch names also resolve here via `branches`. */
  commits?: Record<string, RepoCommitSummary>;
  branches?: Record<string, string>; // branch name → head sha
  trees?: Record<string, { entries: RepoFullTreeEntry[]; truncated?: boolean }>; // treeSha → entries
  compare?: RepoCompareResult;
  branchExists?: boolean; // getCommit(revertBranch) resolves (collision) when true
  createTreeError?: unknown;
  createCommitError?: unknown;
  createRefError?: unknown;
  openPrError?: unknown;
  getCommitError?: unknown;
  compareError?: unknown;
  treeError?: unknown;
}

/**
 * Default scenario: target changed fileA v1→v2; base head still carries v2 (cleanly revertible back to v1),
 * and also has an unrelated fileB the revert never touches.
 */
function build(opts: BuildOpts = {}) {
  const calls: string[] = [];
  let createdTree: RepoTreeOverride[] | null = null;
  let committedParent: string | null = null;
  let createdRef: { branch: string; sha: string } | null = null;

  const T_BASELINE = 'tree-baseline';
  const T_TARGET = 'tree-target';
  const T_BASE = 'tree-base';
  const defaultCommits: Record<string, RepoCommitSummary> = {
    [TARGET]: { sha: TARGET, subject: 'Merge PR #1: ship the thing', treeSha: T_TARGET, parents: [BASELINE] },
    [BASELINE]: { sha: BASELINE, subject: 'baseline', treeSha: T_BASELINE, parents: ['a'.repeat(40)] },
    [BASE_HEAD]: { sha: BASE_HEAD, subject: 'latest main', treeSha: T_BASE, parents: [TARGET] },
    [REVERT_COMMIT]: { sha: REVERT_COMMIT, subject: 'Revert', treeSha: 'tree-revert', parents: [BASE_HEAD] },
  };
  const defaultTrees: Record<string, { entries: RepoFullTreeEntry[]; truncated?: boolean }> = {
    [T_BASELINE]: { entries: [blob('fileA', 'A1'), blob('fileB', 'B1')] },
    [T_TARGET]: { entries: [blob('fileA', 'A2'), blob('fileB', 'B1')] },
    [T_BASE]: { entries: [blob('fileA', 'A2'), blob('fileB', 'B1')] },
    'tree-revert': { entries: [] },
  };
  const commits = { ...defaultCommits, ...opts.commits };
  const trees = { ...defaultTrees, ...opts.trees };
  const branches: Record<string, string> = { main: BASE_HEAD, ...opts.branches };

  const client: GitHubRepoClient = {
    listTree: async () => [],
    readBlob: async () => '',
    listPullRequests: async () => [],
    getPullRequest: async () => { calls.push('getPullRequest'); return { number: 8, title: 'Revert', state: 'open', draft: false, merged: false, headRef: REVERT_BRANCH, headSha: REVERT_COMMIT, baseRef: 'main', url: `https://github.com/${LINK.repoFullName}/pull/8`, mergeCommitSha: null }; },
    getRefChecks: async () => ({ ref: '', state: 'unknown', checks: [] }),
    createBranch: async () => {},
    commitToBranch: async () => {},
    openPullRequest: async () => { calls.push('openPullRequest'); if (opts.openPrError) throw opts.openPrError; return { prNumber: 8 }; },
    mergePullRequest: async () => ({ merged: true, mergeCommitSha: null }),
    getWorkflowRun: async () => ({ id: 0, headSha: '', runAttempt: 1, status: 'completed', conclusion: 'failure', url: '', name: '' }),
    rerunFailedWorkflowJobs: async () => {},
    getCommit: async (_repo: RepoRef, ref: string) => {
      calls.push(`getCommit:${ref}`);
      if (opts.getCommitError) throw opts.getCommitError;
      if (ref === REVERT_BRANCH) {
        // After the ref is created, the branch resolves to the revert commit (post-action verification path).
        if (createdRef) return commits[REVERT_COMMIT]!;
        if (opts.branchExists) return commits[BASE_HEAD]!; // branch already exists → collision
        throw new GitHubApiError('get commit', 404);
      }
      const sha = branches[ref] ?? ref;
      const c = commits[sha];
      if (!c) throw new GitHubApiError('get commit', 404);
      return c;
    },
    compareCommits: async () => { calls.push('compareCommits'); if (opts.compareError) throw opts.compareError; return opts.compare ?? { status: 'ahead', aheadBy: 1, behindBy: 0 }; },
    getFlatTree: async (_repo: RepoRef, treeSha: string) => {
      calls.push(`getFlatTree:${treeSha}`);
      if (opts.treeError) throw opts.treeError;
      const t = trees[treeSha];
      if (!t) throw new GitHubApiError('get flat tree', 404);
      return { entries: t.entries, truncated: t.truncated === true };
    },
    createTree: async (_repo: RepoRef, _baseTreeSha: string, overrides: ReadonlyArray<RepoTreeOverride>) => { calls.push('createTree'); if (opts.createTreeError) throw opts.createTreeError; createdTree = [...overrides]; return { treeSha: 'tree-revert' }; },
    createCommit: async (_repo: RepoRef, args: { parentSha: string }) => { calls.push('createCommit'); if (opts.createCommitError) throw opts.createCommitError; committedParent = args.parentSha; return { commitSha: REVERT_COMMIT }; },
    createRefAtSha: async (_repo: RepoRef, branch: string, sha: string) => { calls.push('createRefAtSha'); if (opts.createRefError) throw opts.createRefError; createdRef = { branch, sha }; },
  } as GitHubRepoClient;

  return { client, calls, getCreatedTree: () => createdTree, getCommittedParent: () => committedParent, getCreatedRef: () => createdRef };
}

function executor(client: GitHubRepoClient, links: readonly GitPrRepoLink[] = [LINK]): GitPrExecutor {
  return new GitPrExecutor({ client, loadLinks: async () => links });
}

const MUTATIONS = ['createTree', 'createCommit', 'createRefAtSha', 'openPullRequest'];
const noMutations = (calls: string[]) => expect(calls.filter((c) => MUTATIONS.includes(c))).toEqual([]);

describe('GitPrExecutor — revert_commit (happy path)', () => {
  it('builds the exact inverse of the target as a new branch + PR, verified, and never writes the default branch', async () => {
    const { client, calls, getCreatedTree, getCommittedParent, getCreatedRef } = build();
    const ex = executor(client);
    const act = action(revertPayload());
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('succeeded');
    expect(result.preview).toMatchObject({ operation: 'revert_commit', prNumber: 8, originalTargetSha: TARGET, baselineSha: BASELINE, revertCommitSha: REVERT_COMMIT, affectedPaths: 1 });
    // The inverse tree restores fileA to its baseline blob (A1); fileB is untouched.
    expect(getCreatedTree()).toEqual([{ path: 'fileA', mode: '100644', type: 'blob', sha: 'A1' }]);
    // The revert commit is parented on the exact base head (never a default-branch write).
    expect(getCommittedParent()).toBe(BASE_HEAD);
    expect(getCreatedRef()).toEqual({ branch: REVERT_BRANCH, sha: REVERT_COMMIT });
    // Order: branch ref is created before the PR is opened.
    expect(calls.indexOf('createRefAtSha')).toBeLessThan(calls.indexOf('openPullRequest'));
  });

  it('reverting a commit that ADDED a file deletes that file (sha:null) on revert', async () => {
    // Target added fileC (absent in baseline, present in target+base head).
    const { client, getCreatedTree } = build({
      trees: {
        'tree-baseline': { entries: [blob('fileA', 'A1')] },
        'tree-target': { entries: [blob('fileA', 'A1'), blob('fileC', 'C1')] },
        'tree-base': { entries: [blob('fileA', 'A1'), blob('fileC', 'C1')] },
      },
    });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('succeeded');
    expect(getCreatedTree()).toEqual([{ path: 'fileC', mode: '100644', type: 'blob', sha: null }]);
  });

  it('dry run performs every read + analysis but ZERO writes', async () => {
    const { client, calls } = build();
    const result = await executor(client).execute(action(revertPayload(), 'dry_run'));
    expect(result.outcome).toBe('not_executed');
    expect(result.preview).toMatchObject({ wouldExecute: true, affectedPaths: 1 });
    noMutations(calls);
  });
});

describe('GitPrExecutor — revert_commit (BLOCK boundaries, no side effect)', () => {
  it('blocks an unlinked repository', async () => {
    const { client, calls } = build();
    const result = await executor(client, []).execute(action(revertPayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/not linked/i);
    noMutations(calls);
  });

  it('blocks a revert branch that is the default/protected branch (write policy)', async () => {
    const { client, calls } = build();
    const result = await executor(client).execute(action(revertPayload({ revertBranch: 'main' })));
    expect(result.outcome).toBe('blocked');
    noMutations(calls);
  });

  it('blocks a stale base head (moved since the proposal)', async () => {
    const { client, calls } = build({ branches: { main: 'c'.repeat(40) }, commits: { ['c'.repeat(40)]: { sha: 'c'.repeat(40), subject: 'newer', treeSha: 'tree-base', parents: [BASE_HEAD] } } });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/moved|stale/i);
    noMutations(calls);
  });

  it('blocks when the target is not an ancestor of the base (unreachable)', async () => {
    const { client, calls } = build({ compare: { status: 'diverged', aheadBy: 1, behindBy: 1 } });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/ancestor|reachab/i);
    noMutations(calls);
  });

  it('blocks a no-op (already reverted): base head already matches the baseline', async () => {
    const { client, calls } = build({
      trees: {
        'tree-baseline': { entries: [blob('fileA', 'A1')] },
        'tree-target': { entries: [blob('fileA', 'A2')] },
        'tree-base': { entries: [blob('fileA', 'A1')] }, // already back at baseline
      },
    });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/no-op|already reverted/i);
    noMutations(calls);
  });

  it('blocks a conflict: base head differs from BOTH the target and the baseline', async () => {
    const { client, calls } = build({
      trees: {
        'tree-baseline': { entries: [blob('fileA', 'A1')] },
        'tree-target': { entries: [blob('fileA', 'A2')] },
        'tree-base': { entries: [blob('fileA', 'A3')] }, // diverged after the target
      },
    });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/conflict/i);
    noMutations(calls);
  });

  it('detects a conflict by FULL entry identity — a mode flip is not "same" even at the same blob sha', async () => {
    // Base head keeps the target's blob SHA (A2) but flipped the file mode to an executable — not cleanly revertible.
    const { client, calls } = build({
      trees: {
        'tree-baseline': { entries: [blob('fileA', 'A1', '100644')] },
        'tree-target': { entries: [blob('fileA', 'A2', '100644')] },
        'tree-base': { entries: [blob('fileA', 'A2', '100755')] },
      },
    });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/conflict/i);
    noMutations(calls);
  });

  it('blocks an unsupported (non-file) affected entry, e.g. a submodule', async () => {
    const { client, calls } = build({
      trees: {
        'tree-baseline': { entries: [{ path: 'vendor', mode: '160000', type: 'commit', sha: 'sub1' }] },
        'tree-target': { entries: [{ path: 'vendor', mode: '160000', type: 'commit', sha: 'sub2' }] },
        'tree-base': { entries: [{ path: 'vendor', mode: '160000', type: 'commit', sha: 'sub2' }] },
      },
    });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/unsupported|non-file/i);
    noMutations(calls);
  });

  it('blocks a root commit (no parent)', async () => {
    const { client, calls } = build({ commits: { [TARGET]: { sha: TARGET, subject: 'root', treeSha: 'tree-target', parents: [] } } });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/no parent|root/i);
    noMutations(calls);
  });

  it('fails closed (no write) when a tree is truncated — cannot compute an exact diff', async () => {
    const { client, calls } = build({ trees: { 'tree-base': { entries: [blob('fileA', 'A2'), blob('fileB', 'B1')], truncated: true } } });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('failed');
    expect(result.message).toMatch(/truncated/i);
    noMutations(calls);
  });

  it('blocks a pre-existing revert branch (collision / prior attempt) before any object or ref write', async () => {
    const { client, calls } = build({ branchExists: true });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/already exists|reconcile/i);
    noMutations(calls);
  });
});

describe('GitPrExecutor — revert_commit (failure / ambiguity contract)', () => {
  it('a 4xx while creating the branch is a definite failure with no side effect, no retry', async () => {
    const { client } = build({ createRefError: new GitHubApiError('create ref', 403) });
    const ex = executor(client);
    const act = action(revertPayload());
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('failed');
    expect(result.retryAllowed).toBe(false);
    expect(result.reconciliation).toBe('not_required');
  });

  it('a 422 (ref already exists) during the create is a reconcile-first BLOCK', async () => {
    const { client } = build({ createRefError: new GitHubApiError('create ref', 422) });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/already exists|reconcile/i);
  });

  it('a 5xx while creating the branch is AMBIGUOUS + reconciliation required + never auto-retried', async () => {
    const { client } = build({ createRefError: new GitHubApiError('create ref', 502) });
    const ex = executor(client);
    const act = action(revertPayload());
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('ambiguous');
    expect(result.reconciliation).toBe('required');
    expect(result.retryAllowed).toBe(false);
  });

  it('a PR failure AFTER the branch was created is a partial, ambiguous outcome needing reconciliation', async () => {
    const { client, calls, getCreatedRef } = build({ openPrError: new GitHubApiError('open pull request', 422) });
    const ex = executor(client);
    const act = action(revertPayload());
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('ambiguous');
    expect(result.reconciliation).toBe('required');
    expect(result.retryAllowed).toBe(false);
    expect(result.message).toMatch(/branch.*created|reconcile/i);
    // The branch WAS created — that is exactly the partial state to reconcile.
    expect(getCreatedRef()).toEqual({ branch: REVERT_BRANCH, sha: REVERT_COMMIT });
    expect(calls).toContain('createRefAtSha');
  });

  it('a transport error minting the revert objects is a definite failure (orphan objects are invisible)', async () => {
    const { client, getCreatedRef } = build({ createTreeError: new GitHubApiError('create tree', 500) });
    const result = await executor(client).execute(action(revertPayload()));
    expect(result.outcome).toBe('failed');
    // No ref was ever created → no visible side effect.
    expect(getCreatedRef()).toBeNull();
  });
});
