import { z } from 'zod';
import { sha256Hex } from '@/lib/crypto';
import { canonicalJson } from '@/orchestration/actions';
import {
  type VercelMutationClient,
  type VercelProjectRef,
} from './client';
import { VercelApiError } from './live-client';
import {
  type Executor,
  type ExecutorAction,
  type ExecutorCapability,
  type ExecutorProvenance,
  type ExecutorResult,
} from '@/domain/execution/executor-contract';

export const VERCEL_MUTATION_EXECUTOR_ID = 'vercel_mutation';
export const VERCEL_MUTATION_EXECUTOR_VERSION = '1';

const projectIdSchema = z.string().regex(/^prj_[A-Za-z0-9]{8,64}$/);
const teamIdSchema = z.string().regex(/^team_[A-Za-z0-9]{8,64}$/);
const deploymentIdSchema = z.string().regex(/^dpl_[A-Za-z0-9]{8,64}$/);
const shaSchema = z.string().regex(/^[0-9a-f]{7,40}$/); // lowercased by the caller before parse

/**
 * `redeploy` — create a NEW deployment from an exact known source deployment. Never targets production (a separate
 * promote moves traffic). Binds the exact source id + its expected SHA.
 */
export const redeployPayloadSchema = z
  .object({
    operation: z.literal('redeploy'),
    vercelProjectId: projectIdSchema,
    teamId: teamIdSchema.optional(),
    sourceDeploymentId: deploymentIdSchema,
    expectedSourceSha: shaSchema,
  })
  .strict();

/**
 * `promote` — move production traffic to one exact READY deployment. Binds the target id + expected SHA AND the
 * expected CURRENT production deployment id (stale-production refusal).
 */
export const promotePayloadSchema = z
  .object({
    operation: z.literal('promote'),
    vercelProjectId: projectIdSchema,
    teamId: teamIdSchema.optional(),
    targetDeploymentId: deploymentIdSchema,
    expectedTargetSha: shaSchema,
    expectedCurrentProductionDeploymentId: deploymentIdSchema,
  })
  .strict();

/**
 * `rollback` — move production back to one exact previously-verified READY production deployment. Same exact-id +
 * SHA binding + the expected current production deployment id (stale-production refusal).
 */
export const rollbackPayloadSchema = z
  .object({
    operation: z.literal('rollback'),
    vercelProjectId: projectIdSchema,
    teamId: teamIdSchema.optional(),
    targetDeploymentId: deploymentIdSchema,
    expectedTargetSha: shaSchema,
    expectedCurrentProductionDeploymentId: deploymentIdSchema,
    description: z.string().max(500).optional(),
  })
  .strict();

export const vercelMutationPayloadSchema = z.discriminatedUnion('operation', [
  redeployPayloadSchema,
  promotePayloadSchema,
  rollbackPayloadSchema,
]);
export type VercelMutationPayload = z.infer<typeof vercelMutationPayloadSchema>;
export type RedeployPayload = z.infer<typeof redeployPayloadSchema>;
export type PromotePayload = z.infer<typeof promotePayloadSchema>;
export type RollbackPayload = z.infer<typeof rollbackPayloadSchema>;

export interface VercelProjectLink {
  readonly vercelProjectId: string;
  readonly vercelTeamId: string | null;
}

export interface VercelMutationExecutorDeps {
  readonly vercel: VercelMutationClient;
  readonly loadProjectLinks: () => Promise<readonly VercelProjectLink[]>;
  readonly now?: () => Date;
}

const CAPABILITY: ExecutorCapability = Object.freeze({
  executorId: VERCEL_MUTATION_EXECUTOR_ID,
  contractVersion: '1',
  actionTypes: ['vercel_mutation'] as const,
  riskClasses: ['external_reversible'] as const,
  supportedModes: ['dry_run', 'live'] as const,
  enabledByDefault: false,
  externalSideEffects: true,
});

type ResultFn = (
  outcome: ExecutorResult['outcome'],
  message: string,
  preview: Record<string, unknown> | null,
  opts?: { reconciliation?: ExecutorResult['reconciliation']; retryAllowed?: boolean },
) => ExecutorResult;

/** A 4xx is a definite non-mutation; anything else after a possible mutation (5xx/timeout/transport) is ambiguous. */
function isDefinite(err: unknown): boolean {
  return err instanceof VercelApiError && err.status >= 400 && err.status < 500;
}

/**
 * The Vercel mutation executor (Phase 2D). An approved `vercel_mutation` action performs exactly one
 * redeploy / promote / rollback on a LINKED project, bound to exact deployment ids + expected SHAs. Reversible by
 * construction (immutable artifacts + a production pointer) → external_reversible. Every precondition that can
 * fail before a side effect is `blocked` (unlinked, not found, not READY, SHA mismatch, stale production) or a
 * retryable `failed` (could not read state). The mutation call fails closed: a 4xx is definite `failed`; a
 * 5xx/timeout is `ambiguous` + reconciliation required and is NEVER auto-retried. Reads/returns no secret.
 */
export class VercelMutationExecutor implements Executor {
  readonly capability = CAPABILITY;

  constructor(private readonly deps: VercelMutationExecutorDeps) {}

  async execute(action: ExecutorAction): Promise<ExecutorResult> {
    const attemptedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const result: ResultFn = (outcome, message, preview, opts = {}) =>
      Object.freeze({
        outcome,
        reconciliation: opts.reconciliation ?? 'not_required',
        retryAllowed: opts.retryAllowed ?? false,
        message,
        preview: preview ? Object.freeze(preview) : null,
        provenance: this.provenance(action, attemptedAt),
      });

    if (action.actionType !== 'vercel_mutation') {
      return result('blocked', 'VercelMutationExecutor only executes vercel_mutation actions.', null);
    }
    if (sha256Hex(canonicalJson(action.payload)) !== action.payloadSha256) {
      return result('blocked', 'Payload integrity re-verification failed at the executor.', null);
    }
    const parsed = vercelMutationPayloadSchema.safeParse(action.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return result('blocked', `vercel_mutation payload is not executable: ${issues}`, null);
    }
    const payload = parsed.data;

    const links = await this.deps.loadProjectLinks();
    const link = links.find((l) => l.vercelProjectId === payload.vercelProjectId);
    if (!link) return result('blocked', `Vercel project "${payload.vercelProjectId}" is not linked to this workspace.`, null);
    const ref: VercelProjectRef = { projectId: link.vercelProjectId, teamId: link.vercelTeamId };

    if (payload.operation === 'redeploy') return this.executeRedeploy(action, payload, ref, result);
    if (payload.operation === 'promote') return this.executePromote(action, payload, ref, result);
    return this.executeRollback(action, payload, ref, result);
  }

  private async executeRedeploy(action: ExecutorAction, payload: RedeployPayload, ref: VercelProjectRef, result: ResultFn): Promise<ExecutorResult> {
    const target = { operation: 'redeploy', vercelProjectId: payload.vercelProjectId, sourceDeploymentId: payload.sourceDeploymentId, expectedSourceSha: payload.expectedSourceSha };

    let source;
    try {
      source = await this.deps.vercel.getDeployment(ref, payload.sourceDeploymentId);
    } catch (err) {
      return result('failed', `No side effect occurred: could not read source deployment ${payload.sourceDeploymentId}: ${msg(err)}`, target, { retryAllowed: true });
    }
    if (!source) return result('blocked', `Source deployment ${payload.sourceDeploymentId} was not found.`, target);
    if (source.readyState !== 'READY') return result('blocked', `Source deployment ${payload.sourceDeploymentId} is "${source.readyState}", not READY — refusing to redeploy.`, target);
    if (source.sourceSha !== payload.expectedSourceSha) return result('blocked', `Source deployment SHA is ${source.sourceSha ?? 'unknown'}, expected ${payload.expectedSourceSha} — stale, refusing to redeploy.`, target);

    let name: string;
    try {
      name = (await this.deps.vercel.getProjectState(ref)).name;
    } catch (err) {
      return result('failed', `No side effect occurred: could not read the project: ${msg(err)}`, target, { retryAllowed: true });
    }

    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would create a new (non-production) deployment from ${payload.sourceDeploymentId} (${payload.expectedSourceSha}).`, { ...target, wouldExecute: true });
    }

    let created: { deploymentId: string; readyState: string };
    try {
      created = await this.deps.vercel.redeploy(ref, { name, sourceDeploymentId: payload.sourceDeploymentId });
    } catch (err) {
      if (isDefinite(err)) return result('failed', `Vercel rejected the redeploy before creating it (no side effect): ${msg(err)}.`, target, { retryAllowed: false });
      return result('ambiguous', `Redeploy outcome is unknown after a transport/server error — a new deployment may or may not have been created: ${msg(err)}. Reconcile before any retry.`, target, { reconciliation: 'required', retryAllowed: false });
    }

    // A new deployment HAS been created. Do not trust the create response — re-read it by exact id and verify it
    // exists and carries the expected source SHA before claiming success. A failed read-back, a missing
    // deployment, or a SHA that contradicts the binding is `ambiguous` + manual reconciliation, never success.
    const created_target = { ...target, newDeploymentId: created.deploymentId };
    let verified;
    try {
      verified = await this.deps.vercel.getDeployment(ref, created.deploymentId);
    } catch (err) {
      return result('ambiguous', `Redeploy created ${created.deploymentId} but it could not be re-read to verify: ${msg(err)}. Reconcile before any retry.`, created_target, { reconciliation: 'required', retryAllowed: false });
    }
    if (!verified) {
      return result('ambiguous', `Redeploy reported ${created.deploymentId} but that deployment was not found on read-back. Reconcile before any retry.`, created_target, { reconciliation: 'required', retryAllowed: false });
    }
    if (verified.sourceSha !== payload.expectedSourceSha) {
      return result('ambiguous', `Redeploy created ${created.deploymentId}, but its source SHA is ${verified.sourceSha ?? 'unknown'}, not the expected ${payload.expectedSourceSha}. Reconcile manually before any retry.`, { ...created_target, newDeploymentSha: verified.sourceSha }, { reconciliation: 'required', retryAllowed: false });
    }
    return result('succeeded', `Created a new deployment ${created.deploymentId} (state "${verified.readyState}") from ${payload.sourceDeploymentId}. Production traffic is unchanged.`, {
      ...created_target,
      newDeploymentState: verified.readyState,
      newDeploymentSha: verified.sourceSha,
      productionChanged: false,
    });
  }

  private async executePromote(action: ExecutorAction, payload: PromotePayload, ref: VercelProjectRef, result: ResultFn): Promise<ExecutorResult> {
    const target = { operation: 'promote', vercelProjectId: payload.vercelProjectId, targetDeploymentId: payload.targetDeploymentId, expectedTargetSha: payload.expectedTargetSha, expectedCurrentProductionDeploymentId: payload.expectedCurrentProductionDeploymentId };
    const pre = await this.verifyPointerPreconditions(payload.targetDeploymentId, payload.expectedTargetSha, payload.expectedCurrentProductionDeploymentId, ref, target, result, { requireProductionTarget: false });
    if (pre.blocked) return pre.blocked;

    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would promote ${payload.targetDeploymentId} (${payload.expectedTargetSha}) to production, replacing ${payload.expectedCurrentProductionDeploymentId}.`, { ...target, wouldExecute: true });
    }
    try {
      await this.deps.vercel.promote(ref, payload.targetDeploymentId);
    } catch (err) {
      if (isDefinite(err)) return result('failed', `Vercel rejected the promote before applying it (no side effect): ${msg(err)}.`, target, { retryAllowed: false });
      return result('ambiguous', `Promote outcome is unknown after a transport/server error — production may or may not have moved: ${msg(err)}. Reconcile before any retry.`, target, { reconciliation: 'required', retryAllowed: false });
    }
    return this.verifyPointerMoved('promote', payload.targetDeploymentId, ref, target, result);
  }

  private async executeRollback(action: ExecutorAction, payload: RollbackPayload, ref: VercelProjectRef, result: ResultFn): Promise<ExecutorResult> {
    const target = { operation: 'rollback', vercelProjectId: payload.vercelProjectId, targetDeploymentId: payload.targetDeploymentId, expectedTargetSha: payload.expectedTargetSha, expectedCurrentProductionDeploymentId: payload.expectedCurrentProductionDeploymentId };
    const pre = await this.verifyPointerPreconditions(payload.targetDeploymentId, payload.expectedTargetSha, payload.expectedCurrentProductionDeploymentId, ref, target, result, { requireProductionTarget: true });
    if (pre.blocked) return pre.blocked;

    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would roll production back to ${payload.targetDeploymentId} (${payload.expectedTargetSha}), replacing ${payload.expectedCurrentProductionDeploymentId}.`, { ...target, wouldExecute: true });
    }
    try {
      await this.deps.vercel.rollback(ref, payload.targetDeploymentId, payload.description);
    } catch (err) {
      if (isDefinite(err)) return result('failed', `Vercel rejected the rollback before applying it (no side effect): ${msg(err)}.`, target, { retryAllowed: false });
      return result('ambiguous', `Rollback outcome is unknown after a transport/server error — production may or may not have moved: ${msg(err)}. Reconcile before any retry.`, target, { reconciliation: 'required', retryAllowed: false });
    }
    return this.verifyPointerMoved('rollback', payload.targetDeploymentId, ref, target, result);
  }

  /** Shared promote/rollback pre-write gates: target READY + SHA match + stale-production refusal. */
  private async verifyPointerPreconditions(
    targetId: string,
    expectedSha: string,
    expectedProdId: string,
    ref: VercelProjectRef,
    target: Record<string, unknown>,
    result: ResultFn,
    opts: { requireProductionTarget: boolean },
  ): Promise<{ blocked: ExecutorResult | null }> {
    let dep;
    try {
      dep = await this.deps.vercel.getDeployment(ref, targetId);
    } catch (err) {
      return { blocked: result('failed', `No side effect occurred: could not read deployment ${targetId}: ${msg(err)}`, target, { retryAllowed: true }) };
    }
    if (!dep) return { blocked: result('blocked', `Deployment ${targetId} was not found.`, target) };
    if (dep.readyState !== 'READY') return { blocked: result('blocked', `Deployment ${targetId} is "${dep.readyState}", not READY — refusing.`, target) };
    if (dep.sourceSha !== expectedSha) return { blocked: result('blocked', `Deployment ${targetId} SHA is ${dep.sourceSha ?? 'unknown'}, expected ${expectedSha} — stale, refusing.`, target) };
    if (opts.requireProductionTarget && dep.target !== 'production') {
      return { blocked: result('blocked', `Deployment ${targetId} was not a production deployment — a rollback target must be a previous production deployment.`, target) };
    }

    let state;
    try {
      state = await this.deps.vercel.getProjectState(ref);
    } catch (err) {
      return { blocked: result('failed', `No side effect occurred: could not read the project's current production deployment: ${msg(err)}`, target, { retryAllowed: true }) };
    }
    if (state.productionDeploymentId !== expectedProdId) {
      return { blocked: result('blocked', `Production has moved (current ${state.productionDeploymentId ?? 'unknown'}, expected ${expectedProdId}) — refusing a stale operation; re-inspect and propose again.`, target) };
    }
    if (state.productionDeploymentId === targetId) {
      return { blocked: result('blocked', `Deployment ${targetId} is already the production deployment — nothing to do.`, target) };
    }
    return { blocked: null };
  }

  /**
   * Shared promote/rollback post-write verification: production now points at the target. A mutation HAS been
   * attempted, so inability to re-read — or any result that does not positively confirm the target — is
   * `ambiguous` + reconciliation required, NEVER success. (A failed verification read must not fall through to
   * success.)
   */
  private async verifyPointerMoved(op: string, targetId: string, ref: VercelProjectRef, target: Record<string, unknown>, result: ResultFn): Promise<ExecutorResult> {
    let after;
    try {
      after = await this.deps.vercel.getProjectState(ref);
    } catch (err) {
      return result('ambiguous', `The ${op} call returned success but production could not be re-read to verify (the mutation may have taken effect): ${msg(err)}. Reconcile before any retry.`, target, { reconciliation: 'required', retryAllowed: false });
    }
    if (after.productionDeploymentId !== targetId) {
      return result('ambiguous', `The ${op} call returned success but production points to ${after.productionDeploymentId ?? 'unknown'}, not ${targetId}. Reconcile before any retry.`, target, { reconciliation: 'required', retryAllowed: false });
    }
    return result('succeeded', `Production now points to ${targetId} (${op}).`, { ...target, productionDeploymentId: targetId, productionChanged: true });
  }

  private provenance(action: ExecutorAction, attemptedAt: string): Readonly<ExecutorProvenance> {
    return Object.freeze({
      contractVersion: '1' as const,
      executorId: this.capability.executorId,
      executorVersion: VERCEL_MUTATION_EXECUTOR_VERSION,
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
      completedAt: (this.deps.now?.() ?? new Date()).toISOString(),
    });
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}
