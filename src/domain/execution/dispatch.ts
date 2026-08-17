import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { approvals, auditLogs, tasks } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { acquireAuditWriteLock, writeAudit } from '@/domain/audit/audit';
import { getGitHubClient } from '@/domain/github/client';
import { listRepoLinks } from '@/domain/github/links';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { type TenantContext } from '@/types/domain';
import {
  EXECUTION_MODES,
  validateExecutorResult,
  type Executor,
  type ExecutorAction,
  type ExecutorResult,
} from './executor-contract';
import { AccurateBidsQuoteExecutor, accurateBidsDepsFromEnv } from './accuratebids-quote-executor';
import { GitPrExecutor } from './git-pr-executor';
import { NoopDryRunExecutor } from './noop-executor';
import { OrgDelegationExecutor } from './org-delegation-executor';
import { EXECUTOR_RISK_BY_ACTION } from './executor-policy';

const dispatchRequestSchema = z.object({
  approvalId: z.string().uuid(),
  correlationId: z.string().min(1).max(200),
  idempotencyKey: z.string().min(16).max(256),
  mode: z.enum(EXECUTION_MODES),
  confirmation: z.object({
    confirmedBy: z.string().min(1),
    confirmedAt: z.coerce.date(),
    expiresAt: z.coerce.date(),
    payloadSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().nullable(),
}).strict();

export type ExecuteApprovedActionRequest = z.input<typeof dispatchRequestSchema>;

export interface DispatchPolicy {
  /** Explicit server configuration. Omission means every executor is disabled. */
  readonly enabledExecutorIds?: readonly string[];
  readonly now?: Date;
}

/**
 * Server enablement from the environment: EXECUTORS_ENABLED is a comma-separated executor-id list
 * ("git_pr"); EXECUTORS_KILL_SWITCH=1 empties it instantly without a deploy. Unset means disabled —
 * absence of configuration can never enable execution.
 */
export function resolveDispatchPolicyFromEnv(env: Record<string, string | undefined> = process.env): DispatchPolicy {
  const stop = env.EXECUTORS_KILL_SWITCH === '1' || env.EXECUTORS_KILL_SWITCH === 'true';
  const ids = (env.EXECUTORS_ENABLED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return { enabledExecutorIds: stop ? [] : ids };
}

/** Risk classes any executor may act on. Everything above external_reversible stays prohibited. */
const ALLOWED_RISKS = new Set(['reversible_internal_write', 'external_reversible']);
const noop = new NoopDryRunExecutor();

/**
 * Resolve the executor for an action type. The registry is deliberately explicit — an action type
 * with no entry here can never execute, whatever the payload claims.
 */
function resolveExecutor(tx: DbTx, ctx: TenantContext, actionType: string): Executor | null {
  if (actionType === 'git_pr') {
    return new GitPrExecutor({ client: getGitHubClient(), loadLinks: () => listRepoLinks(tx, ctx) });
  }
  if (actionType === 'org_delegation') return new OrgDelegationExecutor({ tx, ctx });
  if (actionType === 'external_http') return new AccurateBidsQuoteExecutor(accurateBidsDepsFromEnv());
  if (actionType === 'file_write') return noop;
  return null;
}

function blocked(message: string, reconciliation: ExecutorResult['reconciliation'] = 'not_required'): ExecutorResult {
  const now = new Date(0).toISOString();
  return {
    outcome: 'blocked', reconciliation, retryAllowed: false, message, preview: null,
    provenance: {
      contractVersion: '1', executorId: 'dispatch_policy', executorVersion: '1', actionType: 'file_write',
      riskClass: 'reversible_internal_write', actorId: 'unresolved', orgId: 'unresolved', projectId: 'unresolved',
      approvalId: 'unresolved', taskId: 'unresolved', runId: null, correlationId: 'unresolved',
      idempotencyKey: 'unresolved', payloadSha256: 'unresolved', mode: 'dry_run', attemptedAt: now, completedAt: now,
    },
  };
}

function auditDetail(action: ExecutorAction, executorId: string, result?: ExecutorResult): Record<string, unknown> {
  return {
    actorId: action.authorization.actorId,
    orgId: action.orgId,
    projectId: action.projectId,
    taskId: action.taskId,
    runId: action.runId,
    correlationId: action.correlationId,
    proposedAction: action.actionType,
    executorId: result?.provenance.executorId ?? executorId,
    riskClass: action.riskClass,
    authorizationDecision: 'allowed',
    confirmationState: action.confirmation.required ? 'confirmed' : 'not_required',
    idempotencyKey: action.idempotencyKey,
    payloadSha256: action.payloadSha256,
    mode: action.mode,
    outcome: result?.outcome ?? 'intent_recorded',
    reconciliation: result?.reconciliation ?? 'not_required',
    ...(result?.preview ? { resultPreview: result.preview } : {}),
  };
}

async function writeBlocked(tx: DbTx, ctx: TenantContext, approvalId: string | null, reason: string, detail: Record<string, unknown> = {}): Promise<ExecutorResult> {
  await writeAudit(tx, ctx, { action: 'execution.blocked', entityType: 'approval', entityId: approvalId, detail: { authorizationDecision: 'denied', reason, ...detail } });
  return blocked(reason);
}

/**
 * The sole execution dispatch choke point. It re-reads trusted state, claims idempotency under the
 * append-only audit lock, and dispatches only to an explicitly registered AND explicitly enabled
 * executor. Live mode (Action Executors v1) additionally requires the executor to declare live
 * support and the risk class to be at most external_reversible; a fresh payload-bound confirmation
 * from the acting admin is required in every mode.
 */
export async function executeApprovedAction(
  tx: DbTx,
  ctx: TenantContext,
  untrustedRequest: unknown,
  policy: DispatchPolicy = {},
): Promise<ExecutorResult> {
  const parsed = dispatchRequestSchema.safeParse(untrustedRequest);
  if (!parsed.success) return writeBlocked(tx, ctx, null, 'Malformed execution request.', { issueCount: parsed.error.issues.length });
  const request = parsed.data;
  const now = policy.now ?? new Date();

  if (ctx.projectRole !== 'admin') return writeBlocked(tx, ctx, request.approvalId, 'Execution requires project-admin authority.');

  const rows = await tx
    .select({
      id: approvals.id, orgId: approvals.orgId, projectId: approvals.projectId, taskId: approvals.taskId,
      runId: approvals.runId, actionType: approvals.actionType, payload: approvals.payload,
      payloadSha256: approvals.payloadSha256, status: approvals.status, expiresAt: approvals.expiresAt,
      taskStatus: tasks.status,
    })
    .from(approvals)
    .innerJoin(tasks, eq(approvals.taskId, tasks.id))
    .where(and(eq(approvals.id, request.approvalId), eq(approvals.orgId, ctx.orgId), eq(approvals.projectId, ctx.projectId)))
    .limit(1);
  const row = rows[0];
  if (!row) return writeBlocked(tx, ctx, request.approvalId, 'Approval was not found in this workspace.');
  if (row.status !== 'approved') return writeBlocked(tx, ctx, row.id, 'Approval is not authorized.', { approvalStatus: row.status });
  if (row.expiresAt.getTime() <= now.getTime()) return writeBlocked(tx, ctx, row.id, 'Approval is expired.');
  if (row.taskStatus === 'cancelled') return writeBlocked(tx, ctx, row.id, 'The originating task is cancelled.');

  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload) ? row.payload as Record<string, unknown> : null;
  if (!payload || sha256Hex(canonicalJson(payload)) !== row.payloadSha256) return writeBlocked(tx, ctx, row.id, 'Approved payload integrity check failed.');

  const riskClass = EXECUTOR_RISK_BY_ACTION[row.actionType];
  if (!ALLOWED_RISKS.has(riskClass)) return writeBlocked(tx, ctx, row.id, 'This risk class is prohibited.', { actionType: row.actionType, riskClass });
  const executor = resolveExecutor(tx, ctx, row.actionType);
  if (!executor || !executor.capability.actionTypes.includes(row.actionType)) {
    return writeBlocked(tx, ctx, row.id, 'No executor declares this action type.', { actionType: row.actionType });
  }
  if (!(policy.enabledExecutorIds ?? []).includes(executor.capability.executorId)) return writeBlocked(tx, ctx, row.id, 'The executor is disabled.');
  if (!executor.capability.supportedModes.includes(request.mode)) {
    return writeBlocked(tx, ctx, row.id, `The executor does not support ${request.mode} mode.`, { mode: request.mode });
  }

  const confirmation = request.confirmation;
  if (!confirmation || confirmation.confirmedBy !== ctx.userId || confirmation.payloadSha256 !== row.payloadSha256 || confirmation.confirmedAt.getTime() > now.getTime() || confirmation.expiresAt.getTime() <= now.getTime()) {
    return writeBlocked(tx, ctx, row.id, 'A fresh payload-bound confirmation is required.');
  }

  const action: ExecutorAction = {
    contractVersion: '1', actionType: row.actionType, payload, payloadSha256: row.payloadSha256,
    riskClass, orgId: row.orgId, projectId: row.projectId, approvalId: row.id, taskId: row.taskId,
    runId: row.runId, correlationId: request.correlationId, idempotencyKey: request.idempotencyKey,
    mode: request.mode,
    authorization: { actorId: ctx.userId, orgId: ctx.orgId, projectId: ctx.projectId, projectRole: ctx.projectRole, resolvedAt: now.toISOString(), source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: confirmation.confirmedBy, confirmedAt: confirmation.confirmedAt.toISOString(), expiresAt: confirmation.expiresAt.toISOString(), payloadSha256: confirmation.payloadSha256 },
  };

  await acquireAuditWriteLock(tx, ctx.orgId);
  const prior = await tx.select({ id: auditLogs.id }).from(auditLogs).where(and(
    eq(auditLogs.orgId, ctx.orgId), eq(auditLogs.projectId, ctx.projectId), eq(auditLogs.action, 'execution.intent'),
    sql`${auditLogs.detail}->>'idempotencyKey' = ${request.idempotencyKey}`,
  )).limit(1);
  if (prior.length > 0) return writeBlocked(tx, ctx, row.id, 'Duplicate idempotency key.', { idempotencyKey: request.idempotencyKey });

  const executorId = executor.capability.executorId;
  await writeAudit(tx, ctx, { action: 'execution.intent', entityType: 'approval', entityId: row.id, detail: auditDetail(action, executorId) });
  try {
    const result = validateExecutorResult(action, executor.capability, await executor.execute(action));
    await writeAudit(tx, ctx, { action: 'execution.result', entityType: 'approval', entityId: row.id, detail: auditDetail(action, executorId, result) });
    return result;
  } catch {
    const result: ExecutorResult = { ...blocked('Executor failed before a side effect could occur.'), outcome: 'failed' };
    await writeAudit(tx, ctx, { action: 'execution.result', entityType: 'approval', entityId: row.id, detail: auditDetail(action, executorId, result) });
    return result;
  }
}
