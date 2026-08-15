import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { validateExecutorResult, type ExecutorAction } from '@/domain/execution/executor-contract';
import { GitPrExecutor, type GitPrRepoLink } from '@/domain/execution/git-pr-executor';
import { resolveDispatchPolicyFromEnv } from '@/domain/execution/dispatch';
import { type GitHubRepoClient, type RepoRef } from '@/domain/github/client';
import { GitHubApiError } from '@/domain/github/live-client';

const LINK: GitPrRepoLink = { installationId: 153529449n, repoFullName: 'emperarecords-bit/accuratebids', defaultBranch: 'main' };

const PAYLOAD = {
  repo: 'emperarecords-bit/accuratebids',
  branch: 'hub/fix-header',
  title: 'Fix header copy',
  body: 'Proposed by the hub.',
  files: [{ path: 'README.md', content: '# AccurateBids\n' }],
};

function action(payload: Record<string, unknown>, mode: 'dry_run' | 'live' = 'live'): ExecutorAction {
  return {
    contractVersion: '1', actionType: 'git_pr', payload, payloadSha256: sha256Hex(canonicalJson(payload)),
    riskClass: 'external_reversible', orgId: 'org', projectId: 'project', approvalId: 'approval', taskId: 'task',
    runId: null, correlationId: 'corr', idempotencyKey: '1234567890123456', mode,
    authorization: { actorId: 'actor', orgId: 'org', projectId: 'project', projectRole: 'admin', resolvedAt: '2026-08-15T12:00:00.000Z', source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: 'actor', confirmedAt: '2026-08-15T11:59:00.000Z', expiresAt: '2026-08-15T12:05:00.000Z', payloadSha256: sha256Hex(canonicalJson(payload)) },
  };
}

interface Call { method: string; args: unknown[] }

function fakeClient(overrides: Partial<GitHubRepoClient> = {}): { client: GitHubRepoClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: GitHubRepoClient = {
    listTree: async () => [],
    readBlob: async () => '',
    createBranch: async (...args: unknown[]) => { calls.push({ method: 'createBranch', args }); },
    commitToBranch: async (...args: unknown[]) => { calls.push({ method: 'commitToBranch', args }); },
    openPullRequest: async (...args: unknown[]) => { calls.push({ method: 'openPullRequest', args }); return { prNumber: 42 }; },
    ...overrides,
  } as GitHubRepoClient;
  return { client, calls };
}

function executor(client: GitHubRepoClient, links: readonly GitPrRepoLink[] = [LINK]): GitPrExecutor {
  return new GitPrExecutor({ client, loadLinks: async () => links });
}

describe('GitPrExecutor', () => {
  it('executes an approved git_pr live: branch, commit, PR — and the result passes contract validation', async () => {
    const { client, calls } = fakeClient();
    const ex = executor(client);
    const act = action(PAYLOAD);
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('succeeded');
    expect(result.message).toContain('#42');
    expect(result.preview).toMatchObject({ prNumber: 42, prUrl: 'https://github.com/emperarecords-bit/accuratebids/pull/42', branch: 'hub/fix-header', intoBranch: 'main' });
    expect(calls.map((c) => c.method)).toEqual(['createBranch', 'commitToBranch', 'openPullRequest']);
    const [openArgs] = calls[2].args.slice(1) as [{ fromBranch: string; intoBranch: string }];
    expect(openArgs).toMatchObject({ fromBranch: 'hub/fix-header', intoBranch: 'main' });
    const repoRef = calls[0].args[0] as RepoRef;
    expect(repoRef).toEqual({ installationId: LINK.installationId, repoFullName: LINK.repoFullName });
  });

  it('dry run validates everything and touches nothing', async () => {
    const { client, calls } = fakeClient();
    const ex = executor(client);
    const act = action(PAYLOAD, 'dry_run');
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('not_executed');
    expect(calls).toHaveLength(0);
    expect(result.preview).toMatchObject({ wouldExecute: true, fileCount: 1 });
  });

  it('blocks a payload whose hash does not match (tamper between approval and execution)', async () => {
    const { client, calls } = fakeClient();
    const act = { ...action(PAYLOAD), payloadSha256: 'b'.repeat(64) };
    const result = await executor(client).execute(act);
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/integrity/i);
    expect(calls).toHaveLength(0);
  });

  it('blocks malformed payloads: extra keys, missing files, wrong shapes', async () => {
    const { client, calls } = fakeClient();
    const ex = executor(client);
    for (const bad of [
      { ...PAYLOAD, surprise: true },
      { ...PAYLOAD, files: [] },
      { repo: PAYLOAD.repo, branch: PAYLOAD.branch, title: PAYLOAD.title },
      { ...PAYLOAD, files: [{ path: 'a.txt', content: 'x', mode: '100755' }] },
    ]) {
      const result = await ex.execute(action(bad as Record<string, unknown>));
      expect(result.outcome).toBe('blocked');
      expect(result.message).toMatch(/not executable/i);
    }
    expect(calls).toHaveLength(0);
  });

  it('blocks a repo that is not linked to the workspace', async () => {
    const { client, calls } = fakeClient();
    const result = await executor(client).execute(action({ ...PAYLOAD, repo: 'attacker/evil-repo' }));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toContain('not linked');
    expect(calls).toHaveLength(0);
  });

  it('blocks writes to the default branch and to main/master even when approved', async () => {
    const { client, calls } = fakeClient();
    const ex = executor(client);
    for (const branch of ['main', 'master', 'refs/heads/main']) {
      const result = await ex.execute(action({ ...PAYLOAD, branch }));
      expect(result.outcome).toBe('blocked');
      expect(result.message).toMatch(/never permitted/i);
    }
    expect(calls).toHaveLength(0);
  });

  it('tolerates an already-existing work branch (422) and still opens the PR', async () => {
    const { client, calls } = fakeClient({
      createBranch: async () => { throw new GitHubApiError('create branch', 422); },
    });
    const result = await executor(client).execute(action(PAYLOAD));
    expect(result.outcome).toBe('succeeded');
    expect(calls.map((c) => c.method)).toEqual(['commitToBranch', 'openPullRequest']);
  });

  it('a failure before any side effect is retryable failed; after side effects it is ambiguous + reconciliation', async () => {
    const before = fakeClient({ createBranch: async () => { throw new GitHubApiError('create branch', 500); } });
    const r1 = await executor(before.client).execute(action(PAYLOAD));
    expect(r1.outcome).toBe('failed');
    expect(r1.retryAllowed).toBe(true);
    expect(r1.reconciliation).toBe('not_required');

    const after = fakeClient({ openPullRequest: async () => { throw new GitHubApiError('open pull request', 500); } });
    const ex = executor(after.client);
    const act = action(PAYLOAD);
    const r2 = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(r2.outcome).toBe('ambiguous');
    expect(r2.reconciliation).toBe('required');
    expect(r2.retryAllowed).toBe(false);
  });

  it('an unconfigured GitHub client (prod without the App key) fails closed with no side effect', async () => {
    const { client } = fakeClient({
      createBranch: async () => { throw new Error('GitHub access is not configured: the owner-gated GitHub App credentials are absent.'); },
    });
    const result = await executor(client).execute(action(PAYLOAD));
    expect(result.outcome).toBe('failed');
    expect(result.retryAllowed).toBe(true);
    expect(result.message).toContain('No side effect occurred');
  });
});

describe('resolveDispatchPolicyFromEnv', () => {
  it('is disabled by default, parses the list, and the kill switch empties it', () => {
    expect(resolveDispatchPolicyFromEnv({} as NodeJS.ProcessEnv).enabledExecutorIds).toEqual([]);
    expect(resolveDispatchPolicyFromEnv({ EXECUTORS_ENABLED: 'git_pr, noop_dry_run' } as NodeJS.ProcessEnv).enabledExecutorIds).toEqual(['git_pr', 'noop_dry_run']);
    expect(resolveDispatchPolicyFromEnv({ EXECUTORS_ENABLED: 'git_pr', EXECUTORS_KILL_SWITCH: '1' } as NodeJS.ProcessEnv).enabledExecutorIds).toEqual([]);
    expect(resolveDispatchPolicyFromEnv({ EXECUTORS_ENABLED: 'git_pr', EXECUTORS_KILL_SWITCH: 'true' } as NodeJS.ProcessEnv).enabledExecutorIds).toEqual([]);
  });
});
