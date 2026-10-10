import { ForbiddenError } from '@/lib/errors';
import { InstallationTokenSource, type FetchLike } from './app-auth';
import {
  type GitHubRepoClient,
  type PullRequestSummary,
  type RefCheckStatus,
  type RepoRef,
  type RepoTreeEntry,
  type WorkflowRunSummary,
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

/** Shape the untrusted PR payload into the safe summary. Title/body are repo content; no secrets. */
function toPrSummary(repoFullName: string, pr: Record<string, unknown>): PullRequestSummary {
  const head = (pr.head ?? {}) as { ref?: unknown; sha?: unknown };
  const base = (pr.base ?? {}) as { ref?: unknown };
  const number = typeof pr.number === 'number' ? pr.number : 0;
  return {
    number,
    title: typeof pr.title === 'string' ? pr.title : '',
    state: pr.state === 'closed' ? 'closed' : 'open',
    draft: pr.draft === true,
    merged: pr.merged === true || typeof pr.merged_at === 'string',
    headRef: typeof head.ref === 'string' ? head.ref : '',
    headSha: typeof head.sha === 'string' ? head.sha : '',
    baseRef: typeof base.ref === 'string' ? base.ref : '',
    url: typeof pr.html_url === 'string' ? pr.html_url : `https://github.com/${repoFullName}/pull/${number}`,
    mergeCommitSha: typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null,
  };
}

/** Shape the untrusted workflow-run payload into the safe summary. No secrets. */
function toWorkflowRunSummary(repoFullName: string, run: Record<string, unknown>): WorkflowRunSummary {
  const id = typeof run.id === 'number' ? run.id : 0;
  return {
    id,
    headSha: typeof run.head_sha === 'string' ? run.head_sha : '',
    runAttempt: typeof run.run_attempt === 'number' ? run.run_attempt : 1,
    status: typeof run.status === 'string' ? run.status : 'unknown',
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
    url: typeof run.html_url === 'string' ? run.html_url : `https://github.com/${repoFullName}/actions/runs/${id}`,
    name: typeof run.name === 'string' ? run.name : '',
  };
}

/** Roll up GitHub Actions check-runs into one CI state. */
function rollUpCheckState(
  checks: ReadonlyArray<{ status: string; conclusion: string | null }>,
): RefCheckStatus['state'] {
  if (checks.length === 0) return 'unknown';
  if (checks.some((c) => c.status !== 'completed')) return 'pending';
  const bad = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'stale', 'startup_failure']);
  if (checks.some((c) => c.conclusion && bad.has(c.conclusion))) return 'failure';
  if (checks.every((c) => c.conclusion === 'success' || c.conclusion === 'neutral' || c.conclusion === 'skipped')) return 'success';
  return 'neutral';
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

  async listPullRequests(repo: RepoRef, opts?: { state?: 'open' | 'closed' | 'all' }): Promise<PullRequestSummary[]> {
    const state = opts?.state ?? 'open';
    const out = (await this.request(
      repo,
      'list pull requests',
      'GET',
      `/repos/${repo.repoFullName}/pulls?state=${state}&per_page=30&sort=updated&direction=desc`,
    )) as Array<Record<string, unknown>>;
    return (Array.isArray(out) ? out : []).map((pr) => toPrSummary(repo.repoFullName, pr));
  }

  async getPullRequest(repo: RepoRef, prNumber: number): Promise<PullRequestSummary> {
    const out = (await this.request(
      repo,
      'get pull request',
      'GET',
      `/repos/${repo.repoFullName}/pulls/${prNumber}`,
    )) as Record<string, unknown>;
    return toPrSummary(repo.repoFullName, out);
  }

  async getRefChecks(repo: RepoRef, ref: string): Promise<RefCheckStatus> {
    const out = (await this.request(
      repo,
      'get ref check-runs',
      'GET',
      `/repos/${repo.repoFullName}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    )) as { check_runs?: Array<{ name?: unknown; status?: unknown; conclusion?: unknown }> };
    const checks = (out.check_runs ?? []).map((c) => ({
      name: typeof c.name === 'string' ? c.name : '(unnamed)',
      status: typeof c.status === 'string' ? c.status : 'unknown',
      conclusion: typeof c.conclusion === 'string' ? c.conclusion : null,
    }));
    return { ref, state: rollUpCheckState(checks), checks };
  }

  async getWorkflowRun(repo: RepoRef, runId: number): Promise<WorkflowRunSummary> {
    const out = (await this.request(
      repo,
      'get workflow run',
      'GET',
      `/repos/${repo.repoFullName}/actions/runs/${runId}`,
    )) as Record<string, unknown>;
    return toWorkflowRunSummary(repo.repoFullName, out);
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

  /**
   * Merge a PR. Deliberately NOT routed through `assertWriteAllowed`: the branch+PR-only write policy forbids
   * every default-branch write, but a merge's whole purpose is to land a reviewed PR into (usually) the default
   * branch. Scoping instead comes from the linked RepoRef the caller resolved, and `sha` binds the merge to the
   * exact reviewed head — GitHub returns 409 if the head moved. GitHub branch protection remains authoritative
   * (a protected-branch refusal surfaces here as a 4xx).
   */
  async mergePullRequest(
    repo: RepoRef,
    args: { prNumber: number; mergeMethod: 'squash' | 'merge' | 'rebase'; sha: string },
  ): Promise<{ merged: boolean; mergeCommitSha: string | null }> {
    const out = (await this.request(
      repo,
      'merge pull request',
      'PUT',
      `/repos/${repo.repoFullName}/pulls/${args.prNumber}/merge`,
      { merge_method: args.mergeMethod, sha: args.sha },
      [200],
    )) as { merged?: unknown; sha?: unknown };
    return { merged: out.merged === true, mergeCommitSha: typeof out.sha === 'string' ? out.sha : null };
  }

  /**
   * Re-run only the FAILED jobs of a completed run — the dedicated `rerun-failed-jobs` endpoint, never
   * workflow_dispatch. No repo-content mutation, so no branch write policy applies; it starts a fresh CI attempt.
   */
  async rerunFailedWorkflowJobs(repo: RepoRef, runId: number): Promise<void> {
    await this.request(
      repo,
      'rerun failed workflow jobs',
      'POST',
      `/repos/${repo.repoFullName}/actions/runs/${runId}/rerun-failed-jobs`,
      undefined,
      [201],
    );
  }
}
