import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * GitHub Ops-Chat bridge structural invariants (Phase 2A). The model-facing tool layer can READ GitHub and
 * RECORD a proposal, but it can NEVER execute: execution lives only behind the confirm boundary, through the
 * EXISTING governed path. This guard fails if the model layer gains an execution/mutation path, if Council
 * can reach the executor, or if the bridge stops routing through executeApprovedIfEligible.
 */

const root = process.cwd();
const read = (p: string): string => readFileSync(join(root, p), 'utf8');

const TOOLS = 'src/domain/opschat/tools.ts';
const CHAT_ROUTE = 'src/app/api/ops-chat/route.ts';
const CLIENT = 'src/app/ops/ops-chat-client.tsx';
const CONFIRM_ROUTE = 'src/app/api/ops-chat/confirm/route.ts';
const BRIDGE = 'src/domain/opschat/github-action.ts';

// The model/tool loop + the UI: READ + PROPOSE only. None may reach the governed execution entry points.
const MODEL_FACING = [TOOLS, CHAT_ROUTE, CLIENT];
const EXECUTION_MARKERS = [
  'executeApprovedIfEligible',
  'executeApprovedAction',
  '@/domain/opschat/github-action',
  '@/domain/execution/dispatch',
  '@/domain/execution/execute-on-approval',
];
const DB_WRITE_MARKERS = ['.insert(', '.update(', '.delete('];

describe('GitHub bridge — the model/tool layer cannot execute', () => {
  it.each(MODEL_FACING)('%s reaches no governed-execution entry point', (file) => {
    const src = read(file);
    for (const marker of EXECUTION_MARKERS) {
      expect(src, `${file} must not reference ${marker} — GitHub execution lives behind confirm only`).not.toContain(marker);
    }
  });

  it('the tool layer performs no direct DB write', () => {
    const src = read(TOOLS);
    for (const marker of DB_WRITE_MARKERS) {
      expect(src, `${TOOLS} must not perform ${marker}`).not.toContain(marker);
    }
  });

  it('the GitHub client in the tool layer is only for READS (no mutating executor import, no write calls)', () => {
    const src = read(TOOLS);
    // The tool layer may import the git_pr PAYLOAD SCHEMA (validation) and the read client, but never the
    // executor class or the dispatch choke point.
    expect(src).not.toContain('GitPrExecutor');
    expect(src).toContain('getGitHubClient'); // read client, used only inside read-tool cases
    // And it must never call the client's MUTATING methods — those belong to the executor behind dispatch.
    for (const writeCall of ['.createBranch(', '.commitToBranch(', '.openPullRequest(', '.mergePullRequest(', '.rerunFailedWorkflowJobs(']) {
      expect(src, `${TOOLS} must not call the GitHub client write method ${writeCall}`).not.toContain(writeCall);
    }
  });
});

describe('GitHub bridge — execution lives only behind the confirm boundary', () => {
  it('the confirm route is the sole caller of the bridge', () => {
    const src = read(CONFIRM_ROUTE);
    expect(src).toContain('executeGitHubPrFromOpsChat');
    expect(src).toContain('execute_github_pr');
    expect(src).toContain('executeGitHubMergeFromOpsChat');
    expect(src).toContain('execute_github_merge');
    expect(src).toContain('executeGitHubRerunFromOpsChat');
    expect(src).toContain('execute_github_rerun');
  });

  it('the bridge routes through the EXISTING dispatch path, not a new executor', () => {
    const src = read(BRIDGE);
    expect(src).toContain('executeApprovedIfEligible');
    expect(src).toContain('decideApproval');
    // It must NOT construct or call an executor / the dispatch choke point directly.
    expect(src).not.toContain('GitPrExecutor');
    expect(src).not.toContain('executeApprovedAction');
    expect(src).not.toContain('resolveExecutor');
  });

  it('the anchor task enqueues NO AI run and makes NO provider call (no run/spend)', () => {
    const src = read(BRIDGE);
    // No run-enqueue, no job dispatch, no provider — the anchor task is a governed-operation placeholder only.
    expect(src).not.toContain('enqueueRun');
    expect(src).not.toContain('@/domain/jobs/jobs');
    expect(src).not.toContain('@/providers/registry');
  });
});

describe('GitHub bridge — Council stays review-only and cannot execute', () => {
  const COUNCIL = ['src/domain/opschat/council.ts', 'src/app/api/ops-chat/council/route.ts'];
  it.each(COUNCIL)('%s reaches no GitHub execution/bridge/executor', (file) => {
    const src = read(file);
    for (const marker of [...EXECUTION_MARKERS, 'GitPrExecutor', 'propose_github_pr', 'propose_github_merge', 'propose_github_rerun', '@/domain/github/']) {
      expect(src, `${file} (Council is review-only) must not reference ${marker}`).not.toContain(marker);
    }
  });
});
