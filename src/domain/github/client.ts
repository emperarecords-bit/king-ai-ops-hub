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
        const res = await fetch(url, init);
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
