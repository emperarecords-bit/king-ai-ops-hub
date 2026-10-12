// Static import is safe: live-client imports only TYPES from this module, so there is no runtime cycle.
import { LiveGitHubClient } from './live-client';

/**
 * GitHub repository access contract (Phase 6). The owner created the GitHub App and authorized live activation
 * (2026-08-13): with both credentials present, `getGitHubClient()` returns the policy-gated live client
 * (./live-client.ts); without them everything fails CLOSED — absent credentials produce a typed refusal, never
 * a fallback (docs/architecture/github-integration-decision.md).
 *
 * The interface is deliberately narrow: read tree/blob, and the three write primitives the branch+PR-only policy
 * permits. There is NO "push to branch X" free-form call and NO default-branch write — the shape of the contract
 * makes the forbidden operation unrepresentable (the same design idea as ACTION_TYPES).
 */

export interface RepoRef {
  /** GitHub App installation id bound to the project (from github_repo_links). */
  readonly installationId: bigint;
  /** Canonical `owner/repo`. */
  readonly repoFullName: string;
}

export interface RepoTreeEntry {
  readonly path: string;
  readonly type: 'blob' | 'tree';
  readonly size: number | null;
}

/**
 * A single commit's safe summary (Git Data API) — used by the governed revert to read a commit's first parent
 * (the revert baseline), its tree, and its subject. `ref` may be a SHA or a branch name; GitHub resolves it and
 * `sha` is the resolved commit. No secrets.
 */
export interface RepoCommitSummary {
  readonly sha: string;
  /** First line of the commit message (UNTRUSTED repo content; carried only into a revert message/PR body). */
  readonly subject: string;
  /** The commit's tree SHA. */
  readonly treeSha: string;
  /** Parent commit SHAs in order; `parents[0]` is the first-parent / mainline. */
  readonly parents: readonly string[];
}

/** One recursive tree entry with FULL identity — path + object SHA + mode + type. Reads carry a non-null sha. */
export interface RepoFullTreeEntry {
  readonly path: string;
  /** Git file mode, e.g. '100644' (file), '100755' (exec), '120000' (symlink), '160000' (submodule), '040000' (dir). */
  readonly mode: string;
  readonly type: 'blob' | 'tree' | 'commit';
  readonly sha: string;
}

/** The full recursive tree plus GitHub's `truncated` flag — a truncated tree is unusable for an exact diff. */
export interface RepoFlatTree {
  readonly entries: readonly RepoFullTreeEntry[];
  /** GitHub returns `truncated: true` when the tree exceeds its response cap; the diff then cannot be trusted. */
  readonly truncated: boolean;
}

/** `git compare` status between two commits — used to prove the revert target is an ancestor of the base head. */
export interface RepoCompareResult {
  readonly status: 'ahead' | 'behind' | 'identical' | 'diverged' | 'unknown';
  readonly aheadBy: number;
  readonly behindBy: number;
}

/** One tree override for `createTree`: restore a path to a blob (sha set) or delete it (sha null). */
export interface RepoTreeOverride {
  readonly path: string;
  readonly mode: string;
  readonly type: 'blob';
  /** The blob SHA to restore, or null to delete the path from the base tree. */
  readonly sha: string | null;
}

/** A pull request's safe, UNTRUSTED summary — carries no secrets (title/body are repo content). */
export interface PullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly state: 'open' | 'closed';
  readonly draft: boolean;
  readonly merged: boolean;
  readonly headRef: string;
  readonly headSha: string;
  readonly baseRef: string;
  readonly url: string;
  /** The squash/merge commit SHA once merged, else null — used to verify + report a governed merge. */
  readonly mergeCommitSha: string | null;
}

/** A GitHub Actions workflow run's safe, UNTRUSTED summary — carries no secrets. */
export interface WorkflowRunSummary {
  readonly id: number;
  readonly headSha: string;
  readonly runAttempt: number;
  /** queued | in_progress | completed | waiting | … */
  readonly status: string;
  /** success | failure | cancelled | … | null (null while not completed). */
  readonly conclusion: string | null;
  readonly url: string;
  readonly name: string;
}

/** Rolled-up CI/check state for a ref (GitHub Actions check-runs). */
export interface RefCheckStatus {
  readonly ref: string;
  readonly state: 'success' | 'failure' | 'pending' | 'neutral' | 'unknown';
  readonly checks: ReadonlyArray<{ name: string; status: string; conclusion: string | null }>;
}

export interface GitHubRepoClient {
  /** List the file tree at a ref. Read-only. */
  listTree(repo: RepoRef, ref: string): Promise<RepoTreeEntry[]>;
  /** Fetch one blob's UTF-8 content at a ref. Read-only. The caller treats the result as UNTRUSTED data. */
  readBlob(repo: RepoRef, ref: string, path: string): Promise<string>;
  /** List pull requests (read-only). Default state 'open'. */
  listPullRequests(repo: RepoRef, opts?: { state?: 'open' | 'closed' | 'all' }): Promise<PullRequestSummary[]>;
  /** One pull request's detail (read-only). */
  getPullRequest(repo: RepoRef, prNumber: number): Promise<PullRequestSummary>;
  /** Rolled-up CI/check state for a ref — a commit SHA or branch (read-only). */
  getRefChecks(repo: RepoRef, ref: string): Promise<RefCheckStatus>;
  /** Create a work branch from a base ref. Never the default branch (enforced by write-policy before any call). */
  createBranch(repo: RepoRef, baseRef: string, newBranch: string): Promise<void>;
  /** Commit file changes to an existing NON-default work branch. */
  commitToBranch(
    repo: RepoRef,
    branch: string,
    changes: ReadonlyArray<{ path: string; content: string }>,
    message: string,
  ): Promise<void>;
  /** Open a pull request from a work branch into a base branch. The ONLY way changes reach a default branch. */
  openPullRequest(
    repo: RepoRef,
    args: { fromBranch: string; intoBranch: string; title: string; body: string },
  ): Promise<{ prNumber: number }>;
  /**
   * Merge an existing pull request (Phase 2B). Unlike the create-PR primitives this intentionally lands into
   * the (usually default) base branch — a merge is the sanctioned way a reviewed PR becomes the default branch,
   * and is reversible by reverting the merge commit. Scoping is by the linked RepoRef; `sha` binds the merge to
   * the exact reviewed head (GitHub rejects a stale head); GitHub branch protection stays authoritative.
   */
  mergePullRequest(
    repo: RepoRef,
    args: { prNumber: number; mergeMethod: 'squash' | 'merge' | 'rebase'; sha: string },
  ): Promise<{ merged: boolean; mergeCommitSha: string | null }>;
  /** One GitHub Actions workflow run's detail (read-only). */
  getWorkflowRun(repo: RepoRef, runId: number): Promise<WorkflowRunSummary>;
  /**
   * Re-run only the FAILED jobs of a completed workflow run (Phase 2B) — the `rerun-failed-jobs` endpoint,
   * never workflow_dispatch. No repo-content side effect; it starts a fresh CI attempt of the same run.
   */
  rerunFailedWorkflowJobs(repo: RepoRef, runId: number): Promise<void>;

  // --- Git Data API (Phase 2E revert_commit) -------------------------------
  // Read primitives + the three object/ref writes a governed revert needs to construct an exact inverse commit
  // WITHOUT a local clone and WITHOUT ever writing the default branch (the ref write is policy-gated to a work
  // branch, same as createBranch). createTree/createCommit only mint content-addressed objects (no visible
  // side effect until a ref points at them); createRefAtSha is the first visible side effect.

  /** Read one commit (resolving a SHA or branch name) — its first-parent baseline, tree, and subject. Read-only. */
  getCommit(repo: RepoRef, ref: string): Promise<RepoCommitSummary>;
  /**
   * The head commit SHA of a branch via the Git Refs API (`GET /git/ref/heads/{branch}`), or null when the branch
   * does NOT exist. ONLY a 404 means "absent"; any other provider error throws (fail-closed read). This exists
   * because `getCommit` (the commits endpoint) returns 422 — not 404 — for a non-existent ref, which is unusable
   * as an existence check. Read-only.
   */
  branchHeadSha(repo: RepoRef, branch: string): Promise<string | null>;
  /** `git compare base...head` — proves ancestry (target is an ancestor of the base head). Read-only. */
  compareCommits(repo: RepoRef, base: string, head: string): Promise<RepoCompareResult>;
  /** The full recursive tree at a tree SHA, with GitHub's truncated flag. Read-only. */
  getFlatTree(repo: RepoRef, treeSha: string): Promise<RepoFlatTree>;
  /** Create a new tree from a base tree plus overrides (restore/delete paths). Mints an object; no ref moves. */
  createTree(repo: RepoRef, baseTreeSha: string, overrides: ReadonlyArray<RepoTreeOverride>): Promise<{ treeSha: string }>;
  /** Create a commit object with one parent. Mints an object; no ref moves. */
  createCommit(repo: RepoRef, args: { message: string; treeSha: string; parentSha: string }): Promise<{ commitSha: string }>;
  /** Create a NEW ref (work branch) at an exact commit SHA. Policy-gated: never the default branch. First visible side effect. */
  createRefAtSha(repo: RepoRef, newBranch: string, sha: string): Promise<void>;
}

/** Thrown for every operation while the owner-gated GitHub App credentials are absent. */
export class GitHubUnconfiguredError extends Error {
  constructor() {
    super(
      'GitHub access is not configured: the owner-gated GitHub App credentials (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY) are absent. All GitHub operations fail closed.',
    );
    this.name = 'GitHubUnconfiguredError';
  }
}

/** The fail-closed placeholder: every method refuses. It performs no I/O of any kind. */
class UnconfiguredGitHubClient implements GitHubRepoClient {
  listTree(): Promise<RepoTreeEntry[]> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  readBlob(): Promise<string> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  listPullRequests(): Promise<PullRequestSummary[]> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  getPullRequest(): Promise<PullRequestSummary> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  getRefChecks(): Promise<RefCheckStatus> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  createBranch(): Promise<void> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  commitToBranch(): Promise<void> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  openPullRequest(): Promise<{ prNumber: number }> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  mergePullRequest(): Promise<{ merged: boolean; mergeCommitSha: string | null }> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  getWorkflowRun(): Promise<WorkflowRunSummary> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  rerunFailedWorkflowJobs(): Promise<void> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  getCommit(): Promise<RepoCommitSummary> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  branchHeadSha(): Promise<string | null> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  compareCommits(): Promise<RepoCompareResult> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  getFlatTree(): Promise<RepoFlatTree> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  createTree(): Promise<{ treeSha: string }> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  createCommit(): Promise<{ commitSha: string }> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  createRefAtSha(): Promise<void> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
}

let testOverride: GitHubRepoClient | null = null;

/** Tests inject a fake here (mirrors setProviderOverrideForTests). Pass null to clear. */
export function setGitHubClientOverrideForTests(client: GitHubRepoClient | null): void {
  testOverride = client;
}

/** True only when BOTH owner-gated credentials are present in the environment. */
export function isGitHubConfigured(): boolean {
  return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY);
}

/** Hard ceiling on any single GitHub REST call. A hung mutation must become a bounded failure we can
 *  classify (timeout ⇒ ambiguous), never an indefinitely pending request. */
const GITHUB_FETCH_TIMEOUT_MS = 25_000;

let liveClient: GitHubRepoClient | null = null;

/**
 * Resolve the GitHub client. OWNER-AUTHORIZED live activation (2026-08-13): with BOTH credentials present
 * (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) this returns the live App-JWT/installation-token client
 * (./live-client.ts), whose every mutating method is gated by the branch+PR-only write policy BEFORE any
 * mutating request. Without them it remains the fail-closed placeholder — absence of credentials can never
 * degrade into a fallback. The import is lazy so the fail-closed path stays dependency-free.
 */
export function getGitHubClient(): GitHubRepoClient {
  if (testOverride) return testOverride;
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !privateKeyPem) return new UnconfiguredGitHubClient();
  if (!liveClient) {
    liveClient = new LiveGitHubClient({
      appId,
      privateKeyPem,
      fetchImpl: async (url, init) => {
        const res = await fetch(url, { ...init, signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS) });
        return { status: res.status, json: () => res.json() };
      },
    });
  }
  return liveClient;
}

/** Test hook: drop the cached live client so env changes take effect between tests. */
export function resetGitHubClientForTests(): void {
  liveClient = null;
}
