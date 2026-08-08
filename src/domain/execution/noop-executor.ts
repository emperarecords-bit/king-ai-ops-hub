import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import {
  executorActionSchema,
  type Executor,
  type ExecutorAction,
  type ExecutorCapability,
  type ExecutorResult,
} from './executor-contract';

export const NOOP_EXECUTOR_CAPABILITY = Object.freeze({
  executorId: 'noop_dry_run',
  contractVersion: '1',
  actionTypes: ['file_write'],
  riskClasses: ['reversible_internal_write'],
  supportedModes: ['dry_run'],
  enabledByDefault: false,
  externalSideEffects: false,
} as const satisfies ExecutorCapability);

/**
 * Reference executor for contract and policy testing. It cannot perform an external or filesystem
 * action: the only successful outcome is a deterministic description of what would have happened.
 */
export class NoopDryRunExecutor implements Executor {
  readonly capability = NOOP_EXECUTOR_CAPABILITY;

  async execute(input: ExecutorAction): Promise<ExecutorResult> {
    const action = executorActionSchema.parse(input);
    if (action.mode !== 'dry_run') throw new Error('The no-op executor rejects live mode.');
    if (!this.capability.actionTypes.includes(action.actionType as 'file_write')) {
      throw new Error('The no-op executor does not declare this action type.');
    }
    if (!this.capability.riskClasses.includes(action.riskClass as 'reversible_internal_write')) {
      throw new Error('The no-op executor does not declare this risk class.');
    }

    const attemptedAt = action.authorization.resolvedAt;
    const preview = Object.freeze({
      wouldExecute: false,
      actionType: action.actionType,
      payloadSha256: action.payloadSha256,
      payloadShapeSha256: sha256Hex(canonicalJson(Object.keys(action.payload).sort())),
      reason: 'Phase 3 foundation is dry-run only.',
    });
    return Object.freeze({
      outcome: 'not_executed',
      reconciliation: 'not_required',
      retryAllowed: false,
      message: 'Validated only; no side effect was attempted.',
      preview,
      provenance: Object.freeze({
        contractVersion: '1',
        executorId: this.capability.executorId,
        executorVersion: '1',
        actionType: action.actionType,
        riskClass: action.riskClass,
        actorId: action.authorization.actorId,
        orgId: action.orgId,
        projectId: action.projectId,
        approvalId: action.approvalId,
        taskId: action.taskId,
        runId: action.runId,
        correlationId: action.correlationId,
        idempotencyKey: action.idempotencyKey,
        payloadSha256: action.payloadSha256,
        mode: action.mode,
        attemptedAt,
        completedAt: attemptedAt,
      }),
    } satisfies ExecutorResult);
  }
}

