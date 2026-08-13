/**
 * GitHub repository access contract (Phase 6). CONTRACT-ONLY in this phase: there is no live implementation, and
 * none can exist until the owner creates the GitHub App and stages its credentials in the approved secret store
 * (docs/architecture/github-integration-decision.md). Everything here fails CLOSED — absent credentials produce a
 * typed refusal, never a fallback, and no method ever performs network I/O in this phase.
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

export interface GitHubRepoClient {
  /** List the file tree at a ref. Read-only. */
  listTree(repo: RepoRef, ref: string): Promise<RepoTreeEntry[]>;
  /** Fetch one blob's UTF-8 content at a ref. Read-only. The caller treats the result as UNTRUSTED data. */
  readBlob(repo: RepoRef, ref: string, path: string): Promise<string>;
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
  createBranch(): Promise<void> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  commitToBranch(): Promise<void> {
    return Promise.reject(new GitHubUnconfiguredError());
  }
  openPullRequest(): Promise<{ prNumber: number }> {
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

/**
 * Resolve the GitHub client. Phase 6 foundation: even WITH credentials present this returns the fail-closed
 * placeholder — the live App-JWT/installation-token client is a separate, owner-approved follow-up. This keeps
 * "credentials staged" from silently activating network access before that implementation is reviewed.
 */
export function getGitHubClient(): GitHubRepoClient {
  if (testOverride) return testOverride;
  return new UnconfiguredGitHubClient();
}
