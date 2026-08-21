import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { validateExecutorResult, type ExecutorAction } from '@/domain/execution/executor-contract';
import {
  GIT_PR_SHRINK_GUARD,
  GitPrExecutor,
  findGitPrPlaceholder,
  type GitPrRepoLink,
} from '@/domain/execution/git-pr-executor';
import { type GitHubRepoClient, type RepoTreeEntry } from '@/domain/github/client';

/**
 * Placeholder-disease guards (incident 2026-08-20): an agent proposed replacing the entire 631-line
 * qa-agent/qa_agent.py with the literal text "<COMPLETE FILE CONTENT NEEDED>". These tests pin the
 * two executor-side refusals: placeholder markers in proposed content, and >90% shrinks of existing
 * files. Both are `blocked` — an unexecutable proposal, not an execution failure.
 */

const LINK: GitPrRepoLink = { installationId: 153529449n, repoFullName: 'emperarecords-bit/StressProbe-Product', defaultBranch: 'main' };

const PAYLOAD = {
  repo: 'emperarecords-bit/StressProbe-Product',
  branch: 'hub/qa-agent-fix',
  title: 'Fix QA agent retry logic',
  body: 'Proposed by the hub.',
  files: [{ path: 'qa-agent/qa_agent.py', content: 'def run():\n    return True\n' }],
};

function action(payload: Record<string, unknown>, mode: 'dry_run' | 'live' = 'live'): ExecutorAction {
  return {
    contractVersion: '1', actionType: 'git_pr', payload, payloadSha256: sha256Hex(canonicalJson(payload)),
    riskClass: 'external_reversible', orgId: 'org', projectId: 'project', approvalId: 'approval', taskId: 'task',
    runId: null, correlationId: 'corr', idempotencyKey: '1234567890123456', mode,
    authorization: { actorId: 'actor', orgId: 'org', projectId: 'project', projectRole: 'admin', resolvedAt: '2026-08-20T12:00:00.000Z', source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: 'actor', confirmedAt: '2026-08-20T11:59:00.000Z', expiresAt: '2026-08-20T12:05:00.000Z', payloadSha256: sha256Hex(canonicalJson(payload)) },
  };
}

interface Call { method: string; args: unknown[] }

function fakeClient(tree: RepoTreeEntry[] = [], overrides: Partial<GitHubRepoClient> = {}): { client: GitHubRepoClient; calls: Call[] } {
  const calls: Call[] = [];
  const client: GitHubRepoClient = {
    listTree: async (...args: unknown[]) => { calls.push({ method: 'listTree', args }); return tree; },
    readBlob: async () => '',
    createBranch: async (...args: unknown[]) => { calls.push({ method: 'createBranch', args }); },
    commitToBranch: async (...args: unknown[]) => { calls.push({ method: 'commitToBranch', args }); },
    openPullRequest: async (...args: unknown[]) => { calls.push({ method: 'openPullRequest', args }); return { prNumber: 7 }; },
    ...overrides,
  } as GitHubRepoClient;
  return { client, calls };
}

function executor(client: GitHubRepoClient): GitPrExecutor {
  return new GitPrExecutor({ client, loadLinks: async () => [LINK] });
}

function mutating(calls: Call[]): string[] {
  return calls.map((c) => c.method).filter((m) => m !== 'listTree');
}

describe('findGitPrPlaceholder', () => {
  it('matches the incident marker and its common variants', () => {
    for (const text of [
      '<COMPLETE FILE CONTENT NEEDED>',
      '<FILE CONTENT HERE>',
      '<full file contents goes here>',
      'COMPLETE FILE CONTENT NEEDED',
      'full file content goes here',
      '# rest of file unchanged',
      '// rest of the file remains unchanged',
      '/* ... existing code ... */',
      '# existing code ...',
      'TODO: full content',
      'TODO: add the full file content',
    ]) {
      expect(findGitPrPlaceholder(text), text).not.toBeNull();
    }
  });

  it('leaves real code alone', () => {
    for (const text of [
      'def run():\n    return True\n',
      'const fileContent = await readFile(path);\n',
      '# This module keeps the retry state for existing jobs.\n',
      'print("done")\n',
    ]) {
      expect(findGitPrPlaceholder(text), text).toBeNull();
    }
  });
});

describe('GitPrExecutor placeholder guard', () => {
  it('blocks the exact 2026-08-20 incident payload with no client call at all', async () => {
    const { client, calls } = fakeClient();
    const bad = { ...PAYLOAD, files: [{ path: 'qa-agent/qa_agent.py', content: '<COMPLETE FILE CONTENT NEEDED>' }] };
    const ex = executor(client);
    const act = action(bad);
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('blocked');
    expect(result.retryAllowed).toBe(false);
    expect(result.reconciliation).toBe('not_required');
    expect(result.message).toContain('qa-agent/qa_agent.py');
    expect(result.message).toContain('placeholder');
    expect(calls).toHaveLength(0);
  });

  it('blocks a placeholder buried inside otherwise-real content, in any file of the batch', async () => {
    const { client, calls } = fakeClient();
    const bad = {
      ...PAYLOAD,
      files: [
        { path: 'README.md', content: '# StressProbe\nReal docs.\n' },
        { path: 'qa-agent/qa_agent.py', content: 'def run():\n    pass\n# ... existing code ...\n' },
      ],
    };
    const result = await executor(client).execute(action(bad));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toContain('qa-agent/qa_agent.py');
    expect(calls).toHaveLength(0);
  });

  it('blocks placeholders in dry_run too — a placeholder proposal is never "would execute"', async () => {
    const { client, calls } = fakeClient();
    const bad = { ...PAYLOAD, files: [{ path: 'a.py', content: 'rest of file unchanged' }] };
    const result = await executor(client).execute(action(bad, 'dry_run'));
    expect(result.outcome).toBe('blocked');
    expect(calls).toHaveLength(0);
  });
});

describe('GitPrExecutor shrink guard', () => {
  const bigFile: RepoTreeEntry = { path: 'qa-agent/qa_agent.py', type: 'blob', size: 20_000 };

  it('blocks replacing an existing file while keeping <10% of its bytes, before any side effect', async () => {
    const { client, calls } = fakeClient([bigFile]);
    const ex = executor(client);
    const act = action(PAYLOAD); // ~28 bytes vs 20,000 existing
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('blocked');
    expect(result.retryAllowed).toBe(false);
    expect(result.message).toContain('qa-agent/qa_agent.py');
    expect(result.message).toMatch(/shrink/i);
    expect(mutating(calls)).toEqual([]);
    // The tree was read at the PR target branch, read-only.
    expect(calls[0]).toMatchObject({ method: 'listTree', args: [{ installationId: LINK.installationId, repoFullName: LINK.repoFullName }, 'main'] });
  });

  it('allows a legitimate replacement that keeps most of the file', async () => {
    const { client, calls } = fakeClient([{ path: 'qa-agent/qa_agent.py', type: 'blob', size: 40 }]);
    const result = await executor(client).execute(action(PAYLOAD));
    expect(result.outcome).toBe('succeeded');
    expect(mutating(calls)).toEqual(['createBranch', 'commitToBranch', 'openPullRequest']);
  });

  it('does not apply to new files — small brand-new files are normal', async () => {
    const { client } = fakeClient([]); // file absent from the target tree
    const result = await executor(client).execute(action(PAYLOAD));
    expect(result.outcome).toBe('succeeded');
  });

  it('exempts existing files below the minimum size — shrinking a tiny file is a normal edit', async () => {
    const small: RepoTreeEntry = { path: 'VERSION', type: 'blob', size: GIT_PR_SHRINK_GUARD.minExistingBytes - 1 };
    const { client } = fakeClient([small]);
    const payload = { ...PAYLOAD, files: [{ path: 'VERSION', content: '2\n' }] };
    const result = await executor(client).execute(action(payload));
    expect(result.outcome).toBe('succeeded');
  });

  it('skips the tree read in dry_run: validation stays side-effect- and network-free', async () => {
    const { client, calls } = fakeClient([bigFile]);
    const result = await executor(client).execute(action(PAYLOAD, 'dry_run'));
    expect(result.outcome).toBe('not_executed');
    expect(calls).toHaveLength(0);
  });

  it('a tree read failure fails closed as retryable failed — never an unverified write', async () => {
    const { client, calls } = fakeClient([], { listTree: async () => { throw new Error('boom'); } });
    const result = await executor(client).execute(action(PAYLOAD));
    expect(result.outcome).toBe('failed');
    expect(result.retryAllowed).toBe(true);
    expect(result.reconciliation).toBe('not_required');
    expect(result.message).toContain('No side effect occurred');
    expect(mutating(calls)).toEqual([]);
  });
});
