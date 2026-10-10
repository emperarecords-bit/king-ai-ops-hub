import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { validateExecutorResult, type ExecutorAction } from '@/domain/execution/executor-contract';
import { GitPrExecutor, type GitPrRepoLink } from '@/domain/execution/git-pr-executor';
import { type GitHubRepoClient, type PullRequestSummary, type RefCheckStatus, type WorkflowRunSummary } from '@/domain/github/client';
import { GitHubApiError } from '@/domain/github/live-client';

/**
 * Phase 2B — merge_pr / rerun_failed_workflow executor governance. These ride the git_pr executor, so the shared
 * invariants (payload hash, admin, confirmation, enablement, idempotency) are covered by the dispatch tests; here
 * we prove the operation-specific preconditions and the failure/ambiguity contract.
 */

const LINK: GitPrRepoLink = { installationId: 153529449n, repoFullName: 'emperarecords-bit/accuratebids', defaultBranch: 'main' };
const HEAD = 'a'.repeat(40);
const MERGE_SHA = 'c'.repeat(40);
const PR_URL = 'https://github.com/emperarecords-bit/accuratebids/pull/7';
const RUN_URL = 'https://github.com/emperarecords-bit/accuratebids/actions/runs/99';

function action(payload: Record<string, unknown>, mode: 'dry_run' | 'live' = 'live'): ExecutorAction {
  return {
    contractVersion: '1', actionType: 'git_pr', payload, payloadSha256: sha256Hex(canonicalJson(payload)),
    riskClass: 'external_reversible', orgId: 'org', projectId: 'project', approvalId: 'approval', taskId: 'task',
    runId: null, correlationId: 'corr', idempotencyKey: '1234567890123456', mode,
    authorization: { actorId: 'actor', orgId: 'org', projectId: 'project', projectRole: 'admin', resolvedAt: '2026-10-10T12:00:00.000Z', source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: 'actor', confirmedAt: '2026-10-10T11:59:00.000Z', expiresAt: '2026-10-10T12:05:00.000Z', payloadSha256: sha256Hex(canonicalJson(payload)) },
  };
}

interface BuildOpts {
  pr?: Partial<PullRequestSummary>;
  checksState?: RefCheckStatus['state'];
  run?: Partial<WorkflowRunSummary>;
  afterRun?: Partial<WorkflowRunSummary>;
  mergeResult?: { merged: boolean; mergeCommitSha: string | null };
  mergeError?: unknown;
  rerunError?: unknown;
  getPrError?: unknown;
  getRunError?: unknown;
}

function build(opts: BuildOpts = {}) {
  const calls: string[] = [];
  const pr: PullRequestSummary = { number: 7, title: 't', state: 'open', draft: false, merged: false, headRef: 'feature', headSha: HEAD, baseRef: 'main', url: PR_URL, mergeCommitSha: null, ...opts.pr };
  const run: WorkflowRunSummary = { id: 99, headSha: HEAD, runAttempt: 1, status: 'completed', conclusion: 'failure', url: RUN_URL, name: 'CI', ...opts.run };
  let getRunCount = 0;
  let didMerge = false;
  const mergeArgs: unknown[] = [];
  const client: GitHubRepoClient = {
    listTree: async () => [],
    readBlob: async () => '',
    listPullRequests: async () => [],
    getPullRequest: async () => { calls.push('getPullRequest'); if (opts.getPrError) throw opts.getPrError; return didMerge ? { ...pr, merged: true, mergeCommitSha: MERGE_SHA } : pr; },
    getRefChecks: async () => { calls.push('getRefChecks'); return { ref: HEAD, state: opts.checksState ?? 'success', checks: [] }; },
    createBranch: async () => { calls.push('createBranch'); },
    commitToBranch: async () => { calls.push('commitToBranch'); },
    openPullRequest: async () => { calls.push('openPullRequest'); return { prNumber: 7 }; },
    mergePullRequest: async (...a: unknown[]) => { calls.push('mergePullRequest'); mergeArgs.push(a[1]); if (opts.mergeError) throw opts.mergeError; didMerge = true; return opts.mergeResult ?? { merged: true, mergeCommitSha: MERGE_SHA }; },
    getWorkflowRun: async () => { calls.push('getWorkflowRun'); if (opts.getRunError) throw opts.getRunError; getRunCount += 1; return getRunCount >= 2 && opts.afterRun ? { ...run, ...opts.afterRun } : run; },
    rerunFailedWorkflowJobs: async () => { calls.push('rerunFailedWorkflowJobs'); if (opts.rerunError) throw opts.rerunError; },
  } as GitHubRepoClient;
  return { client, calls, mergeArgs };
}

function executor(client: GitHubRepoClient, links: readonly GitPrRepoLink[] = [LINK]): GitPrExecutor {
  return new GitPrExecutor({ client, loadLinks: async () => links });
}

const mergePayload = (o: Record<string, unknown> = {}) => ({ operation: 'merge_pr', repo: LINK.repoFullName, prNumber: 7, expectedHeadSha: HEAD, expectedBaseBranch: 'main', ...o });
const rerunPayload = (o: Record<string, unknown> = {}) => ({ operation: 'rerun_failed_workflow', repo: LINK.repoFullName, runId: 99, expectedHeadSha: HEAD, expectedRunAttempt: 1, ...o });

describe('GitPrExecutor — merge_pr', () => {
  it('merges a green, open, non-draft PR at the exact head and verifies the merge commit SHA', async () => {
    const { client, calls, mergeArgs } = build();
    const ex = executor(client);
    const act = action(mergePayload());
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('succeeded');
    expect(result.preview).toMatchObject({ operation: 'merge_pr', merged: true, prUrl: PR_URL, mergeCommitSha: MERGE_SHA });
    expect(calls).toContain('mergePullRequest');
    // The merge is bound to the reviewed head (GitHub 409s a moved head).
    expect(mergeArgs[0]).toMatchObject({ prNumber: 7, mergeMethod: 'squash', sha: HEAD });
  });

  it('blocks a stale PR head (moved since review) and never calls merge', async () => {
    const { client, calls } = build({ pr: { headSha: 'b'.repeat(40) } });
    const result = await executor(client).execute(action(mergePayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/stale|moved/i);
    expect(calls).not.toContain('mergePullRequest');
  });

  it('blocks a draft PR', async () => {
    const { client, calls } = build({ pr: { draft: true } });
    const result = await executor(client).execute(action(mergePayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/draft/i);
    expect(calls).not.toContain('mergePullRequest');
  });

  it('blocks a closed or already-merged PR', async () => {
    for (const pr of [{ merged: true }, { state: 'closed' as const }]) {
      const { client, calls } = build({ pr });
      const result = await executor(client).execute(action(mergePayload()));
      expect(result.outcome).toBe('blocked');
      expect(calls).not.toContain('mergePullRequest');
    }
  });

  it('blocks a base-branch mismatch', async () => {
    const { client, calls } = build({ pr: { baseRef: 'develop' } });
    const result = await executor(client).execute(action(mergePayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/target|base/i);
    expect(calls).not.toContain('mergePullRequest');
  });

  it('blocks when CI is not green', async () => {
    for (const checksState of ['failure', 'pending', 'unknown', 'neutral'] as const) {
      const { client, calls } = build({ checksState });
      const result = await executor(client).execute(action(mergePayload()));
      expect(result.outcome).toBe('blocked');
      expect(result.message).toMatch(/CI/i);
      expect(calls).not.toContain('mergePullRequest');
    }
  });

  it('blocks an unlinked repository', async () => {
    const { client, calls } = build();
    const result = await executor(client, []).execute(action(mergePayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/not linked/i);
    expect(calls).not.toContain('getPullRequest');
  });

  it('a 4xx on the merge call is a definite failure with no retry (GitHub rejected it)', async () => {
    const { client } = build({ mergeError: new GitHubApiError('merge pull request', 409) });
    const result = await executor(client).execute(action(mergePayload()));
    expect(result.outcome).toBe('failed');
    expect(result.retryAllowed).toBe(false);
    expect(result.reconciliation).toBe('not_required');
  });

  it('a 5xx on the merge call is AMBIGUOUS + reconciliation required + never auto-retried', async () => {
    const { client } = build({ mergeError: new GitHubApiError('merge pull request', 502) });
    const ex = executor(client);
    const act = action(mergePayload());
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('ambiguous');
    expect(result.reconciliation).toBe('required');
    expect(result.retryAllowed).toBe(false);
  });

  it('a transport error (timeout, no status) on the merge call is ambiguous, not a definite failure', async () => {
    const { client } = build({ mergeError: new Error('The operation was aborted due to timeout') });
    const ex = executor(client);
    const act = action(mergePayload());
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('ambiguous');
    expect(result.reconciliation).toBe('required');
  });

  it('dry run validates every precondition but never merges', async () => {
    const { client, calls } = build();
    const result = await executor(client).execute(action(mergePayload(), 'dry_run'));
    expect(result.outcome).toBe('not_executed');
    expect(calls).not.toContain('mergePullRequest');
  });
});

describe('GitPrExecutor — rerun_failed_workflow', () => {
  it('re-runs the failed jobs of a completed+failed run via the rerun-failed-jobs endpoint only', async () => {
    const { client, calls } = build({ afterRun: { runAttempt: 2, status: 'in_progress', conclusion: null } });
    const ex = executor(client);
    const act = action(rerunPayload());
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('succeeded');
    expect(calls).toContain('rerunFailedWorkflowJobs');
    // There is no workflow_dispatch primitive in the client at all — the only mutation is rerun-failed-jobs.
    expect(result.preview).toMatchObject({ operation: 'rerun_failed_workflow', runId: 99, attempt: 2, state: 'in_progress', advanced: true });
  });

  it('blocks a run that is not completed+failed (failed workflow only)', async () => {
    for (const run of [{ conclusion: 'success' as const }, { status: 'in_progress' as const, conclusion: null }, { status: 'queued' as const, conclusion: null }]) {
      const { client, calls } = build({ run });
      const result = await executor(client).execute(action(rerunPayload()));
      expect(result.outcome).toBe('blocked');
      expect(calls).not.toContain('rerunFailedWorkflowJobs');
    }
  });

  it('blocks a stale run attempt', async () => {
    const { client, calls } = build({ run: { runAttempt: 3 } });
    const result = await executor(client).execute(action(rerunPayload({ expectedRunAttempt: 1 })));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/attempt/i);
    expect(calls).not.toContain('rerunFailedWorkflowJobs');
  });

  it('blocks a mismatched run head SHA', async () => {
    const { client, calls } = build({ run: { headSha: 'b'.repeat(40) } });
    const result = await executor(client).execute(action(rerunPayload()));
    expect(result.outcome).toBe('blocked');
    expect(calls).not.toContain('rerunFailedWorkflowJobs');
  });

  it('blocks an unlinked repository', async () => {
    const { client, calls } = build();
    const result = await executor(client, []).execute(action(rerunPayload()));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/not linked/i);
    expect(calls).not.toContain('getWorkflowRun');
  });

  it('a 4xx on rerun is a definite failure with no retry', async () => {
    const { client } = build({ rerunError: new GitHubApiError('rerun failed workflow jobs', 403) });
    const result = await executor(client).execute(action(rerunPayload()));
    expect(result.outcome).toBe('failed');
    expect(result.retryAllowed).toBe(false);
  });

  it('a 5xx on rerun is AMBIGUOUS + reconciliation required + never auto-retried', async () => {
    const { client } = build({ rerunError: new GitHubApiError('rerun failed workflow jobs', 500) });
    const ex = executor(client);
    const act = action(rerunPayload());
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('ambiguous');
    expect(result.reconciliation).toBe('required');
    expect(result.retryAllowed).toBe(false);
  });

  it('dry run validates every precondition but never reruns', async () => {
    const { client, calls } = build();
    const result = await executor(client).execute(action(rerunPayload(), 'dry_run'));
    expect(result.outcome).toBe('not_executed');
    expect(calls).not.toContain('rerunFailedWorkflowJobs');
  });
});
