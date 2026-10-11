import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { validateExecutorResult, type ExecutorAction } from '@/domain/execution/executor-contract';
import { VercelMutationExecutor, type VercelProjectLink } from '@/domain/vercel/mutation-executor';
import { type VercelMutationClient, type VercelDeploymentState, type VercelProjectState } from '@/domain/vercel/client';
import { VercelApiError } from '@/domain/vercel/live-client';

/**
 * Phase 2D — the vercel_mutation executor. redeploy/promote/rollback on a LINKED project, bound to exact
 * deployment ids + expected SHAs. Fully mocked (no network): tenant/link boundary, READY + SHA gates,
 * stale-production refusal, and the 4xx/5xx failure/ambiguity contract.
 */

const LINK: VercelProjectLink = { vercelProjectId: 'prj_accuratebids0001xyz', vercelTeamId: 'team_abc12345' };
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const TARGET = 'dpl_target00000001';
const CURRENT = 'dpl_current0000002';
const SOURCE = 'dpl_source0000003';
const NEWID = 'dpl_new00000004';

function action(payload: Record<string, unknown>, mode: 'dry_run' | 'live' = 'live'): ExecutorAction {
  const payloadSha256 = sha256Hex(canonicalJson(payload));
  return {
    contractVersion: '1', actionType: 'vercel_mutation', payload, payloadSha256,
    riskClass: 'external_reversible', orgId: 'org', projectId: 'project', approvalId: 'approval', taskId: 'task',
    runId: null, correlationId: 'corr', idempotencyKey: '1234567890123456', mode,
    authorization: { actorId: 'actor', orgId: 'org', projectId: 'project', projectRole: 'admin', resolvedAt: '2026-10-11T12:00:00.000Z', source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: 'actor', confirmedAt: '2026-10-11T11:59:00.000Z', expiresAt: '2026-10-11T12:05:00.000Z', payloadSha256 },
  };
}

interface Opts {
  deployments?: Record<string, VercelDeploymentState | null | Error>;
  project?: VercelProjectState;
  promoteError?: unknown;
  rollbackError?: unknown;
  redeployError?: unknown;
  getDeploymentError?: unknown;
  projectAfter?: VercelProjectState;
  /** When true, the SECOND getProjectState call (the post-mutation verification read) throws. */
  verifyProjectThrows?: boolean;
  links?: readonly VercelProjectLink[];
}

function build(opts: Opts = {}) {
  const calls: string[] = [];
  const deployments: Record<string, VercelDeploymentState | null | Error> = opts.deployments ?? {
    [TARGET]: { id: TARGET, readyState: 'READY', target: 'production', sourceSha: SHA },
    [SOURCE]: { id: SOURCE, readyState: 'READY', target: 'preview', sourceSha: SHA },
    [NEWID]: { id: NEWID, readyState: 'READY', target: 'preview', sourceSha: SHA },
  };
  let getProjectCount = 0;
  const client: VercelMutationClient = {
    getDeployment: async (_ref, id) => { calls.push(`getDeployment:${id}`); if (opts.getDeploymentError) throw opts.getDeploymentError; const d = deployments[id]; if (d instanceof Error) throw d; return d ?? null; },
    getProjectState: async () => {
      calls.push('getProjectState'); getProjectCount += 1;
      if (opts.verifyProjectThrows && getProjectCount >= 2) throw new Error('verification read failed');
      return getProjectCount >= 2 && opts.projectAfter ? opts.projectAfter : (opts.project ?? { name: 'accuratebids', productionDeploymentId: CURRENT, productionSha: OTHER_SHA });
    },
    redeploy: async () => { calls.push('redeploy'); if (opts.redeployError) throw opts.redeployError; return { deploymentId: NEWID, readyState: 'QUEUED' }; },
    promote: async () => { calls.push('promote'); if (opts.promoteError) throw opts.promoteError; },
    rollback: async () => { calls.push('rollback'); if (opts.rollbackError) throw opts.rollbackError; },
  };
  const executor = new VercelMutationExecutor({ vercel: client, loadProjectLinks: async () => opts.links ?? [LINK] });
  return { executor, calls };
}

const promoteP = (o: Record<string, unknown> = {}) => ({ operation: 'promote', vercelProjectId: LINK.vercelProjectId, targetDeploymentId: TARGET, expectedTargetSha: SHA, expectedCurrentProductionDeploymentId: CURRENT, ...o });
const rollbackP = (o: Record<string, unknown> = {}) => ({ operation: 'rollback', vercelProjectId: LINK.vercelProjectId, targetDeploymentId: TARGET, expectedTargetSha: SHA, expectedCurrentProductionDeploymentId: CURRENT, ...o });
const redeployP = (o: Record<string, unknown> = {}) => ({ operation: 'redeploy', vercelProjectId: LINK.vercelProjectId, sourceDeploymentId: SOURCE, expectedSourceSha: SHA, ...o });

describe('VercelMutationExecutor — boundary refusals (no side effect)', () => {
  it('blocks when the project is not linked', async () => {
    const { executor, calls } = build({ links: [] });
    const r = await executor.execute(action(promoteP()));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/not linked/i);
    expect(calls).not.toContain('promote');
  });

  it('blocks a payload-hash mismatch', async () => {
    const { executor } = build();
    const act = action(promoteP());
    const r = await executor.execute({ ...act, payload: { ...act.payload, targetDeploymentId: 'dpl_evil00000009' } });
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/integrity/i);
  });

  it('promote blocks a non-READY target', async () => {
    const { executor, calls } = build({ deployments: { [TARGET]: { id: TARGET, readyState: 'BUILDING', target: 'production', sourceSha: SHA } } });
    const r = await executor.execute(action(promoteP()));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/not READY/i);
    expect(calls).not.toContain('promote');
  });

  it('promote blocks a SHA mismatch', async () => {
    const { executor } = build({ deployments: { [TARGET]: { id: TARGET, readyState: 'READY', target: 'production', sourceSha: OTHER_SHA } } });
    const r = await executor.execute(action(promoteP()));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/SHA/i);
  });

  it('promote blocks when production has MOVED since review (stale)', async () => {
    const { executor, calls } = build({ project: { name: 'x', productionDeploymentId: 'dpl_moved00000008', productionSha: OTHER_SHA } });
    const r = await executor.execute(action(promoteP()));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/moved|stale/i);
    expect(calls).not.toContain('promote');
  });

  it('rollback blocks when the target was not a production deployment', async () => {
    const { executor } = build({ deployments: { [TARGET]: { id: TARGET, readyState: 'READY', target: 'preview', sourceSha: SHA } } });
    const r = await executor.execute(action(rollbackP()));
    expect(r.outcome).toBe('blocked');
    expect(r.message).toMatch(/previous production/i);
  });

  it('redeploy fails (retryable) when the source deployment cannot be read', async () => {
    const { executor } = build({ getDeploymentError: new Error('boom') });
    const r = await executor.execute(action(redeployP()));
    expect(r.outcome).toBe('failed');
    expect(r.retryAllowed).toBe(true);
  });
});

describe('VercelMutationExecutor — dry run + live', () => {
  it('promote dry run never calls promote', async () => {
    const { executor, calls } = build();
    const act = action(promoteP(), 'dry_run');
    const r = validateExecutorResult(act, executor.capability, await executor.execute(act));
    expect(r.outcome).toBe('not_executed');
    expect(calls).not.toContain('promote');
  });

  it('promote succeeds and verifies production now points to the target', async () => {
    const { executor, calls } = build({ projectAfter: { name: 'x', productionDeploymentId: TARGET, productionSha: SHA } });
    const act = action(promoteP());
    const r = validateExecutorResult(act, executor.capability, await executor.execute(act));
    expect(r.outcome).toBe('succeeded');
    expect(r.preview).toMatchObject({ productionDeploymentId: TARGET, productionChanged: true });
    expect(calls).toContain('promote');
  });

  it('redeploy succeeds only after re-reading the new deployment and confirming its SHA (honest state captured)', async () => {
    const { executor, calls } = build();
    const act = action(redeployP());
    const r = validateExecutorResult(act, executor.capability, await executor.execute(act));
    expect(r.outcome).toBe('succeeded');
    expect(r.preview).toMatchObject({ newDeploymentId: NEWID, newDeploymentState: 'READY', newDeploymentSha: SHA, productionChanged: false });
    // Verified by a read-back of the exact new id, not by trusting the create response.
    expect(calls).toContain(`getDeployment:${NEWID}`);
  });

  it('rollback succeeds on a READY previous production target', async () => {
    const { executor, calls } = build({ projectAfter: { name: 'x', productionDeploymentId: TARGET, productionSha: SHA } });
    const act = action(rollbackP());
    const r = validateExecutorResult(act, executor.capability, await executor.execute(act));
    expect(r.outcome).toBe('succeeded');
    expect(calls).toContain('rollback');
  });

  it('a 4xx on promote is a definite failure (no retry, no reconciliation)', async () => {
    const { executor } = build({ promoteError: new VercelApiError('promote', 403) });
    const r = await executor.execute(action(promoteP()));
    expect(r.outcome).toBe('failed');
    expect(r.retryAllowed).toBe(false);
    expect(r.reconciliation).toBe('not_required');
  });

  it('a 5xx on promote is ambiguous + reconciliation, never auto-retried', async () => {
    const { executor } = build({ promoteError: new VercelApiError('promote', 502) });
    const r = await executor.execute(action(promoteP()));
    expect(r.outcome).toBe('ambiguous');
    expect(r.reconciliation).toBe('required');
    expect(r.retryAllowed).toBe(false);
  });

  it('promote reports ambiguous when post-verify shows production did NOT move', async () => {
    const { executor } = build({ projectAfter: { name: 'x', productionDeploymentId: 'dpl_stillold0000', productionSha: OTHER_SHA } });
    const r = await executor.execute(action(promoteP()));
    expect(r.outcome).toBe('ambiguous');
    expect(r.reconciliation).toBe('required');
  });
});

describe('VercelMutationExecutor — post-action verification failures are ambiguous, never success', () => {
  it('promote success response + verification read throws → ambiguous (reconcile, no retry)', async () => {
    const { executor } = build({ verifyProjectThrows: true });
    const r = await executor.execute(action(promoteP()));
    expect(r.outcome).toBe('ambiguous');
    expect(r.reconciliation).toBe('required');
    expect(r.retryAllowed).toBe(false);
  });

  it('rollback success response + verification read throws → ambiguous (reconcile, no retry)', async () => {
    const { executor } = build({ verifyProjectThrows: true });
    const r = await executor.execute(action(rollbackP()));
    expect(r.outcome).toBe('ambiguous');
    expect(r.reconciliation).toBe('required');
    expect(r.retryAllowed).toBe(false);
  });

  it('redeploy success response + verification read throws → ambiguous (reconcile, no retry)', async () => {
    const { executor } = build({ deployments: { [SOURCE]: { id: SOURCE, readyState: 'READY', target: 'preview', sourceSha: SHA }, [NEWID]: new Error('read-back failed') } });
    const r = await executor.execute(action(redeployP()));
    expect(r.outcome).toBe('ambiguous');
    expect(r.reconciliation).toBe('required');
    expect(r.retryAllowed).toBe(false);
    expect((r.preview as { newDeploymentId?: string }).newDeploymentId).toBe(NEWID);
  });

  it('redeploy new deployment SHA mismatch → ambiguous (manual reconciliation, not success)', async () => {
    const { executor } = build({ deployments: { [SOURCE]: { id: SOURCE, readyState: 'READY', target: 'preview', sourceSha: SHA }, [NEWID]: { id: NEWID, readyState: 'READY', target: 'preview', sourceSha: OTHER_SHA } } });
    const r = await executor.execute(action(redeployP()));
    expect(r.outcome).toBe('ambiguous');
    expect(r.reconciliation).toBe('required');
    expect(r.message).toMatch(/source SHA/i);
  });

  it('redeploy with a verified new deployment (exists + SHA matches) → succeeded', async () => {
    const { executor } = build({ deployments: { [SOURCE]: { id: SOURCE, readyState: 'READY', target: 'preview', sourceSha: SHA }, [NEWID]: { id: NEWID, readyState: 'READY', target: 'preview', sourceSha: SHA } } });
    const r = await executor.execute(action(redeployP()));
    expect(r.outcome).toBe('succeeded');
    expect(r.preview).toMatchObject({ newDeploymentId: NEWID, newDeploymentSha: SHA });
  });
});
