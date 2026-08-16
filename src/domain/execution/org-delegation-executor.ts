import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agents, projectMembers, projects, runJobs } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { sha256Hex } from '@/lib/crypto';
import { canonicalJson } from '@/orchestration/actions';
import { writeAudit } from '@/domain/audit/audit';
import { createTask } from '@/domain/tasks/tasks';
import { type TenantContext } from '@/types/domain';
import {
  type Executor,
  type ExecutorAction,
  type ExecutorCapability,
  type ExecutorProvenance,
  type ExecutorResult,
} from './executor-contract';

export const ORG_DELEGATION_EXECUTOR_ID = 'org_delegation';
export const ORG_DELEGATION_EXECUTOR_VERSION = '1';

/**
 * The payload the trusted runner mints from the Chief of Staff's cross-workspace delegation.
 * Models never propose this action type (extraction refuses it) — but the executor still treats
 * the payload as hostile until it survives this parse.
 */
export const orgDelegationPayloadSchema = z
  .object({
    /** Key of the workspace whose General Manager receives the task. */
    targetProjectKey: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(200),
    /** Complete instructions addressed to the target General Manager. */
    instructions: z.string().trim().min(1).max(8_000),
  })
  .strict();

export type OrgDelegationPayload = z.infer<typeof orgDelegationPayloadSchema>;

const CAPABILITY: ExecutorCapability = Object.freeze({
  executorId: ORG_DELEGATION_EXECUTOR_ID,
  contractVersion: '1',
  actionTypes: ['org_delegation'] as const,
  riskClasses: ['reversible_internal_write'] as const,
  supportedModes: ['dry_run', 'live'] as const,
  enabledByDefault: false,
  externalSideEffects: false,
});

export interface OrgDelegationExecutorDeps {
  readonly tx: DbTx;
  /** The approving admin's tenant context — headquarters, where the approval lives. */
  readonly ctx: TenantContext;
  readonly now?: () => Date;
}

/**
 * Cross-workspace delegation v2: an approved `org_delegation` becomes a REAL task on the target
 * workspace's General Manager's desk, queued to run. Internal and reversible — the created task can
 * be cancelled like any other, and everything consequential the target team then proposes still
 * flows through the owner's approvals queue.
 *
 * Tenancy: the dispatcher's transaction is stamped to headquarters. Target-workspace reads and
 * writes happen inside a SAVEPOINT with the project GUC re-stamped to the target (the sanctioned
 * org-crossing pattern) — a failure rolls the savepoint back, so a non-succeeded outcome means NO
 * partial writes. The GUC is restored to headquarters before returning, so the dispatcher's own
 * audit writes land under the correct scope.
 */
export class OrgDelegationExecutor implements Executor {
  readonly capability = CAPABILITY;

  constructor(private readonly deps: OrgDelegationExecutorDeps) {}

  async execute(action: ExecutorAction): Promise<ExecutorResult> {
    const attemptedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const result = (
      outcome: ExecutorResult['outcome'],
      message: string,
      preview: Record<string, unknown> | null,
    ): ExecutorResult =>
      Object.freeze({
        outcome,
        reconciliation: 'not_required' as const,
        retryAllowed: false,
        message,
        preview: preview ? Object.freeze(preview) : null,
        provenance: this.provenance(action, attemptedAt),
      });

    if (action.actionType !== 'org_delegation') {
      return result('blocked', 'OrgDelegationExecutor only executes org_delegation actions.', null);
    }
    // Defense in depth: the dispatcher already verified this, but the executor never trusts its caller.
    if (sha256Hex(canonicalJson(action.payload)) !== action.payloadSha256) {
      return result('blocked', 'Payload integrity re-verification failed at the executor.', null);
    }
    const parsed = orgDelegationPayloadSchema.safeParse(action.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return result('blocked', `org_delegation payload is not executable: ${issues}`, null);
    }
    const payload = parsed.data;
    const { tx, ctx } = this.deps;

    // Resolve the target inside the SAME org only (projects visibility is membership-based).
    const target = (
      await tx
        .select({ id: projects.id, key: projects.key, name: projects.name, archived: projects.archived, ownerAgentId: projects.ownerAgentId })
        .from(projects)
        .where(and(eq(projects.orgId, ctx.orgId), eq(projects.key, payload.targetProjectKey)))
        .limit(1)
    )[0];
    if (!target) return result('blocked', `Workspace "${payload.targetProjectKey}" was not found in this organization.`, null);
    if (target.archived) return result('blocked', `Workspace "${payload.targetProjectKey}" is archived.`, null);
    if (target.id === ctx.projectId) {
      return result('blocked', 'Cross-workspace delegation cannot target its own workspace.', null);
    }
    if (!target.ownerAgentId) {
      return result('blocked', `Workspace "${target.name}" has no installed General Manager.`, null);
    }
    // The approving admin must also administer the target workspace — authority is never widened here.
    const member = (
      await tx
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(and(eq(projectMembers.projectId, target.id), eq(projectMembers.userId, ctx.userId)))
        .limit(1)
    )[0];
    if (!member || member.role !== 'admin') {
      return result('blocked', 'The approving admin does not administer the target workspace.', null);
    }

    const preview = { targetProjectKey: target.key, targetWorkspaceName: target.name, taskTitle: payload.title };
    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run: would create task "${payload.title}" for the General Manager of ${target.name}.`, preview);
    }

    const targetCtx: TenantContext = { ...ctx, projectId: target.id, projectRole: 'admin' };
    try {
      const taskId = await tx.transaction(async (inner) => {
        // The sanctioned org-crossing re-stamp; savepoint-local, so a rollback also restores it.
        await inner.execute(sql`select set_config('app.project_id', ${target.id}, true)`);
        const gm = (
          await inner
            .select({ id: agents.id, name: agents.name, provider: agents.provider, enabled: agents.enabled, role: agents.role })
            .from(agents)
            .where(and(eq(agents.projectId, target.id), eq(agents.id, target.ownerAgentId!)))
            .limit(1)
        )[0];
        if (!gm || !gm.enabled || gm.role !== 'primary') {
          throw new Error(`The General Manager of ${target.name} is not an enabled primary employee.`);
        }
        const createdTaskId = await createTask(inner, targetCtx, {
          title: payload.title,
          input: `Directive from headquarters (Chief of Staff), approved by the owner:\n\n${payload.instructions}`,
          providerSelection: gm.provider,
          reviewEnabled: false,
          primaryAgentId: gm.id,
        });
        await inner
          .insert(runJobs)
          .values({ orgId: ctx.orgId, projectId: target.id, taskId: createdTaskId, status: 'queued', dispatchKind: 'standing' })
          .onConflictDoNothing();
        await writeAudit(inner, targetCtx, {
          action: 'run_job.enqueued',
          entityType: 'task',
          entityId: createdTaskId,
          detail: { dispatchKind: 'standing', delegated: true, crossWorkspace: true },
        });
        await writeAudit(inner, targetCtx, {
          action: 'task.delegated',
          entityType: 'task',
          entityId: createdTaskId,
          detail: {
            crossWorkspace: true,
            fromProjectId: ctx.projectId,
            approvalId: action.approvalId,
            toAgentId: gm.id,
            assignee: gm.name,
            title: payload.title,
          },
        });
        return createdTaskId;
      });
      return result('succeeded', `Created task "${payload.title}" in ${target.name} for its General Manager.`, { ...preview, taskId });
    } catch (err) {
      // The savepoint rolled back — no partial writes exist in the target workspace.
      const message = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `Delegation could not be created: ${message}`, null);
    } finally {
      // The dispatcher's remaining audit writes must land under headquarters scope.
      await tx.execute(sql`select set_config('app.project_id', ${ctx.projectId}, true)`);
    }
  }

  private provenance(action: ExecutorAction, attemptedAt: string): ExecutorProvenance {
    return Object.freeze({
      contractVersion: '1' as const,
      executorId: ORG_DELEGATION_EXECUTOR_ID,
      executorVersion: ORG_DELEGATION_EXECUTOR_VERSION,
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
