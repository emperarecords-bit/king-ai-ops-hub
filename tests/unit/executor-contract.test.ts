import { describe, expect, it } from 'vitest';
import { sha256Hex } from '@/lib/crypto';
import { canonicalJson } from '@/orchestration/actions';
import { executorActionSchema, EXECUTOR_RISK_CLASSES, type ExecutorAction } from '@/domain/execution/executor-contract';
import { NoopDryRunExecutor, NOOP_EXECUTOR_CAPABILITY } from '@/domain/execution/noop-executor';

function action(overrides: Partial<ExecutorAction> = {}): ExecutorAction {
  const payload = { path: 'drafts/plan.md', content: 'preview only' };
  return {
    contractVersion: '1',
    actionType: 'file_write',
    payload,
    payloadSha256: sha256Hex(canonicalJson(payload)),
    riskClass: 'reversible_internal_write',
    orgId: 'org-1',
    projectId: 'project-1',
    approvalId: 'approval-1',
    taskId: 'task-1',
    runId: 'run-1',
    correlationId: 'correlation-1',
    idempotencyKey: 'project-1:approval-1:file-write',
    mode: 'dry_run',
    authorization: {
      actorId: 'actor-1',
      orgId: 'org-1',
      projectId: 'project-1',
      projectRole: 'admin',
      resolvedAt: '2026-08-08T12:00:00.000Z',
      source: 'trusted_server',
    },
    confirmation: { required: true, confirmedBy: 'actor-1', confirmedAt: '2026-08-08T11:59:00.000Z', expiresAt: '2026-08-08T12:05:00.000Z', payloadSha256: sha256Hex(canonicalJson(payload)) },
    ...overrides,
  };
}

describe('executor contract and no-op reference', () => {
  it('defines a closed risk vocabulary and an explicitly off-by-default capability', () => {
    expect(EXECUTOR_RISK_CLASSES).toEqual(['read_only', 'reversible_internal_write', 'external_reversible', 'financial_regulated', 'destructive_irreversible']);
    expect(NOOP_EXECUTOR_CAPABILITY).toMatchObject({ enabledByDefault: false, externalSideEffects: false, supportedModes: ['dry_run'] });
  });

  it('rejects malformed and unknown contract fields', () => {
    expect(() => executorActionSchema.parse({ ...action(), riskClass: 'invented' })).toThrow();
    expect(() => executorActionSchema.parse({ ...action(), browserAuthorized: true })).toThrow();
  });

  it('returns a deterministic not-executed preview without echoing payload content', async () => {
    const executor = new NoopDryRunExecutor();
    const first = await executor.execute(action());
    const second = await executor.execute(action());
    expect(first).toEqual(second);
    expect(first).toMatchObject({ outcome: 'not_executed', reconciliation: 'not_required', retryAllowed: false });
    expect(JSON.stringify(first)).not.toContain('preview only');
    expect(first.provenance.mode).toBe('dry_run');
  });

  it('rejects live mode and undeclared action/risk combinations', async () => {
    const executor = new NoopDryRunExecutor();
    await expect(executor.execute(action({ mode: 'live' }))).rejects.toThrow(/rejects live/i);
    await expect(executor.execute(action({ actionType: 'git_pr' }))).rejects.toThrow(/action type/i);
    await expect(executor.execute(action({ riskClass: 'read_only' }))).rejects.toThrow(/risk class/i);
  });
});
