import { ForbiddenError } from '@/lib/errors';
import { InstallationTokenSource, type FetchLike } from './app-auth';
import {
  type GitHubRepoClient,
  type RepoRef,
  type RepoTreeEntry,
} from './client';
import { assessGitWrite } from './write-policy';

/**
 * The LIVE GitHub App client (Phase 6, owner-authorized follow-up to the fail-closed foundation). Speaks the
 * REST API with an installation token from `InstallationTokenSource`; `fetchImpl` is injected so every test runs
 * against a recorder with zero network.
 *
 * THE INVARIANT THIS CLASS EXISTS TO KEEP: every mutating method consults `assessGitWrite` against the
 * repository's REAL default branch (fetched live, not trusted from the caller) BEFORE issuing any mutating
 * request. A denied assessment throws `ForbiddenError` and no mutating request is ever sent — so a default-branch
 * write cannot happen even if a caller (or an approved payload) asks for one. Reads carry no policy check; they
 * are read-only by construction.
 */

export class GitHubApiError extends Error {
  readonly status: number;
  constructor(operation: string, status: number) {
    // Status + operation only — response bodies are never echoed into errors.
    super(`GitHub ${operation} failed with HTTP ${status}`);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

interface LiveClientArgs {
  readonly appId: string;
  readonly privateKeyPem: string;
  readonly fetchImpl: FetchLike;
  readonly apiBase?: string;
  readonly now?: () => number;
}

export class LiveGitHubClient implements GitHubRepoClient {
  private readonly apiBase: string;
  private readonly fetchImpl: FetchLike;
  private readonly tokenSources = new Map<string, InstallationTokenSource>();
  private readonly appId: string;
  private readonly privateKeyPem: string;
  private readonly now: () => number;

  constructor(args: LiveClientArgs) {
    this.appId = args.appId;
    this.privateKeyPem = args.privateKeyPem;
    this.fetchImpl = args.fetchImpl;
    this.apiBase = (args.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
    this.now = args.now ?? (() => Date.now());
  }

  private tokens(repo: RepoRef): InstallationTokenSource {
    const key = repo.installationId.toString();
    let source = this.tokenSources.get(key);
    if (!source) {
      source = new InstallationTokenSource(this.appId, this.privateKeyPem, repo.installationId, this.fetchImpl, this.apiBase, this.now);
      this.tokenSources.set(key, source);
    }
    return source;
  }

  private async request(
    repo: RepoRef,
    operation: string,
    method: string,
    path: string,
    body?: unknown,
    okStatuses: readonly number[] = [200],
  ): Promise<unknown> {
    const token = await this.tokens(repo).getToken();
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!okStatuses.includes(res.status)) throw new GitHubApiError(operation, res.status);
    return res.json();
  }

  /** The repository's REAL default branch — the policy's ground truth, never taken from the caller. */
  private async fetchDefaultBranch(repo: RepoRef): Promise<string> {
    const info = (await this.request(repo, 'get repository', 'GET', `/repos/${repo.repoFullName}`)) as {
      default_branch?: unknown;
    };
    if (typeof info.default_branch !== 'string' || info.default_branch.length === 0) {
      throw new GitHubApiError('get repository (default branch missing)', 500);
    }
    return info.default_branch;
  }

  /** Fail-closed gate every mutating method passes through BEFORE any mutating request is issued. */
  private async assertWriteAllowed(repo: RepoRef, actionType: 'git_commit' | 'git_push' | 'git_pr', targetBranch: string): Promise<void> {
    const defaultBranch = await this.fetchDefaultBranch(repo);
    const verdict = assessGitWrite({
      actionType,
      targetRepo: repo.repoFullName,
      targetBranch,
      linkedRepo: repo.repoFullName,
      defaultBranch,
    });
    if (!verdict.allowed) throw new ForbiddenError(`git write policy refused ${actionType}: ${verdict.reason}`);
  }

  // --- reads ---------------------------------------------------------------

  async listTree(repo: RepoRef, ref: string): Promise<RepoTreeEntry[]> {
    const out = (await this.request(
      repo,
      'list tree',
      'GET',
      `/repos/${repo.repoFullName}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    )) as { tree?: Array<{ path?: unknown; type?: unknown; size?: unknown }> };
    return (out.tree ?? [])
      .filter((e) => typeof e.path === 'string' && (e.type === 'blob' || e.type === 'tree'))
      .map((e) => ({ path: e.path as string, type: e.type as 'blob' | 'tree', size: typeof e.size === 'number' ? e.size : null }));
  }

  async readBlob(repo: RepoRef, ref: string, path: string): Promise<string> {
    const encodedPath = path.split('/').map(encodeURIComponent).join('/');
    const out = (await this.request(
      repo,
      'read blob',
      'GET',
      `/repos/${repo.repoFullName}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    )) as { content?: unknown; encoding?: unknown };
    if (typeof out.content !== 'string' || out.encoding !== 'base64') {
      throw new GitHubApiError('read blob (unexpected shape)', 500);
    }
    return Buffer.from(out.content, 'base64').toString('utf8');
  }

  // --- writes (each one policy-gated BEFORE any mutating request) ----------

  async createBranch(repo: RepoRef, baseRef: string, newBranch: string): Promise<void> {
    await this.assertWriteAllowed(repo, 'git_commit', newBranch);
    const base = (await this.request(
      repo,
      'resolve base ref',
      'GET',
      `/repos/${repo.repoFullName}/git/ref/heads/${encodeURIComponent(baseRef)}`,
    )) as { object?: { sha?: unknown } };
    const sha = base.object?.sha;
    if (typeof sha !== 'string') throw new GitHubApiError('resolve base ref (unexpected shape)', 500);
    await this.request(repo, 'create branch', 'POST', `/repos/${repo.repoFullName}/git/refs`, { ref: `refs/heads/${newBranch}`, sha }, [201]);
  }

  async commitToBranch(
    repo: RepoRef,
    branch: string,
    changes: ReadonlyArray<{ path: string; content: string }>,
    message: string,
  ): Promise<void> {
    await this.assertWriteAllowed(repo, 'git_commit', branch);
    for (const change of changes) {
      const encodedPath = change.path.split('/').map(encodeURIComponent).join('/');
      // Updating an existing file requires its current blob sha; a 404 means create-new.
      let existingSha: string | undefined;
      try {
        const existing = (await this.request(
          repo,
          'read existing file',
          'GET',
          `/repos/${repo.repoFullName}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
        )) as { sha?: unknown };
        if (typeof existing.sha === 'string') existingSha = existing.sha;
      } catch (err) {
        if (!(err instanceof GitHubApiError && err.status === 404)) throw err;
      }
      await this.request(
        repo,
        'commit file',
        'PUT',
        `/repos/${repo.repoFullName}/contents/${encodedPath}`,
        {
          message,
          branch,
          content: Buffer.from(change.content, 'utf8').toString('base64'),
          ...(existingSha ? { sha: existingSha } : {}),
        },
        [200, 201],
      );
    }
  }

  async openPullRequest(
    repo: RepoRef,
    args: { fromBranch: string; intoBranch: string; title: string; body: string },
  ): Promise<{ prNumber: number }> {
    // The policy's target for git_pr is the SOURCE branch: the PR itself may (and normally does) target the
    // default branch — that is the sanctioned route into it.
    await this.assertWriteAllowed(repo, 'git_pr', args.fromBranch);
    const out = (await this.request(
      repo,
      'open pull request',
      'POST',
      `/repos/${repo.repoFullName}/pulls`,
      { title: args.title, body: args.body, head: args.fromBranch, base: args.intoBranch },
      [201],
    )) as { number?: unknown };
    if (typeof out.number !== 'number') throw new GitHubApiError('open pull request (unexpected shape)', 500);
    return { prNumber: out.number };
  }
}
