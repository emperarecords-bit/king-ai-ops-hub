import { z } from 'zod';
import { ACTION_TYPES, PROJECT_ROLES, type ActionType, type ProjectRole } from '@/types/domain';

export const EXECUTOR_RISK_CLASSES = [
  'read_only',
  'reversible_internal_write',
  'external_reversible',
  'financial_regulated',
  'destructive_irreversible',
] as const;
export type ExecutorRiskClass = (typeof EXECUTOR_RISK_CLASSES)[number];

export const EXECUTION_MODES = ['dry_run', 'live'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const EXECUTION_OUTCOMES = ['not_executed', 'blocked', 'succeeded', 'failed', 'ambiguous'] as const;
export type ExecutionOutcome = (typeof EXECUTION_OUTCOMES)[number];

export const RECONCILIATION_STATES = ['not_required', 'required', 'resolved'] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

export const authorizationContextSchema = z.object({
  actorId: z.string().min(1),
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  projectRole: z.enum(PROJECT_ROLES),
  resolvedAt: z.string().datetime({ offset: true }),
  source: z.literal('trusted_server'),
}).strict();

export interface ExecutorAuthorizationContext {
  readonly actorId: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly projectRole: ProjectRole;
  readonly resolvedAt: string;
  readonly source: 'trusted_server';
}

export const executorActionSchema = z.object({
  contractVersion: z.literal('1'),
  actionType: z.enum(ACTION_TYPES),
  payload: z.record(z.string(), z.unknown()),
  payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  riskClass: z.enum(EXECUTOR_RISK_CLASSES),
  orgId: z.string().min(1),
  projectId: z.string().min(1),
  approvalId: z.string().min(1),
  taskId: z.string().min(1),
  runId: z.string().min(1).nullable(),
  correlationId: z.string().min(1),
  idempotencyKey: z.string().min(16).max(256),
  mode: z.enum(EXECUTION_MODES),
  authorization: authorizationContextSchema,
  confirmation: z.object({
    required: z.boolean(),
    confirmedBy: z.string().min(1).nullable(),
    confirmedAt: z.string().datetime({ offset: true }).nullable(),
    expiresAt: z.string().datetime({ offset: true }).nullable(),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  }).strict(),
}).strict();

export type ExecutorAction = z.infer<typeof executorActionSchema>;

export interface ExecutorCapability {
  readonly executorId: string;
  readonly contractVersion: '1';
  readonly actionTypes: readonly ActionType[];
  readonly riskClasses: readonly ExecutorRiskClass[];
  readonly supportedModes: readonly ExecutionMode[];
  readonly enabledByDefault: false;
  readonly externalSideEffects: false;
}

export interface ExecutorProvenance {
  readonly contractVersion: '1';
  readonly executorId: string;
  readonly executorVersion: string;
  readonly actionType: ActionType;
  readonly riskClass: ExecutorRiskClass;
  readonly actorId: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly approvalId: string;
  readonly taskId: string;
  readonly runId: string | null;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly payloadSha256: string;
  readonly mode: ExecutionMode;
  readonly attemptedAt: string;
  readonly completedAt: string;
}

export interface ExecutorResult {
  readonly outcome: ExecutionOutcome;
  readonly reconciliation: ReconciliationState;
  readonly retryAllowed: boolean;
  readonly message: string;
  readonly preview: Readonly<Record<string, unknown>> | null;
  readonly provenance: Readonly<ExecutorProvenance>;
}

export interface Executor {
  readonly capability: Readonly<ExecutorCapability>;
  execute(action: ExecutorAction): Promise<ExecutorResult>;
}

/** Validate a registered executor's result before the trusted path may audit or return it. */
export function validateExecutorResult(
  action: ExecutorAction,
  capability: ExecutorCapability,
  result: ExecutorResult,
): ExecutorResult {
  const p = result.provenance;
  const bound = p.executorId === capability.executorId && p.actionType === action.actionType &&
    p.actorId === action.authorization.actorId && p.orgId === action.orgId && p.projectId === action.projectId &&
    p.approvalId === action.approvalId && p.taskId === action.taskId && p.runId === action.runId &&
    p.correlationId === action.correlationId && p.idempotencyKey === action.idempotencyKey &&
    p.payloadSha256 === action.payloadSha256 && p.mode === action.mode && p.riskClass === action.riskClass;
  if (!bound) throw new Error('Executor result provenance does not match the trusted action.');
  if (result.outcome === 'ambiguous' && (result.reconciliation !== 'required' || result.retryAllowed)) {
    throw new Error('Ambiguous outcomes require reconciliation and prohibit retry.');
  }
  if (result.outcome === 'not_executed' && (action.mode !== 'dry_run' || capability.externalSideEffects)) {
    throw new Error('A not_executed result is valid only for a side-effect-free dry run.');
  }
  return result;
}

