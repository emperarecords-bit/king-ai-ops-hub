import 'server-only';
import { AppError } from '@/lib/errors';
import { withTenant } from '@/db/tenant';
import { approvals } from '@/db/schema';
import { type TenantContext } from '@/types/domain';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { listVercelProjectLinks } from '@/domain/vercel/links';
import { listAgents } from '@/domain/agents/agents';
import { createTask, setTaskStatus } from '@/domain/tasks/tasks';
import { decideApproval } from '@/domain/approvals/approvals';
import { executeApprovedIfEligible, type ApprovalExecutionOutcome } from '@/domain/execution/execute-on-approval';
import { vercelMutationPayloadSchema, type VercelMutationPayload } from '@/domain/vercel/mutation-executor';

/**
 * Ops Chat → Vercel bridge (Phase 2D mutation slice), the CONFIRM side. The ONLY place the Vercel mutation bridge
 * writes, through the SAME governed path as the GitHub/Supabase bridges: validate payload → anchor task → insert a
 * `vercel_mutation` approval → decideApproval(admin) → executeApprovedIfEligible → dispatch choke point → the
 * vercel_mutation executor → the real Vercel mutation. No new executor/dispatch/confirmation machinery; the model
 * only PROPOSES, and nothing executes before the owner's confirm.
 */

const APPROVAL_WINDOW_MS = 10 * 60 * 1000;

/** The confirm route passes the raw (string-lowercased-SHA) fields; this is the discriminated input. */
export type OpsChatVercelMutationInput =
  | { operation: 'redeploy'; vercelProjectId: string; teamId?: string; sourceDeploymentId: string; expectedSourceSha: string }
  | { operation: 'promote'; vercelProjectId: string; teamId?: string; targetDeploymentId: string; expectedTargetSha: string; expectedCurrentProductionDeploymentId: string }
  | { operation: 'rollback'; vercelProjectId: string; teamId?: string; targetDeploymentId: string; expectedTargetSha: string; expectedCurrentProductionDeploymentId: string; description?: string };

export interface OpsChatVercelMutationResult {
  readonly approvalId: string;
  readonly attempted: boolean;
  readonly outcome: ApprovalExecutionOutcome['outcome'];
  readonly message: string | null;
  readonly operation: VercelMutationPayload['operation'];
  readonly newDeploymentId: string | null;
  readonly productionDeploymentId: string | null;
  readonly productionChanged: boolean | null;
}

function issuesOf(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}

function summarize(p: VercelMutationPayload): string {
  if (p.operation === 'redeploy') {
    return `Redeploy a NEW (non-production) deployment from ${p.sourceDeploymentId} (${p.expectedSourceSha.slice(0, 7)}) in ${p.vercelProjectId}. Reversible; production traffic is unchanged.`;
  }
  const verb = p.operation === 'promote' ? 'Promote' : 'Roll production back to';
  return `${verb} deployment ${p.targetDeploymentId} (${p.expectedTargetSha.slice(0, 7)}) in ${p.vercelProjectId}, replacing current production ${p.expectedCurrentProductionDeploymentId} — requires READY target + unchanged production. Reversible by repointing.`;
}

export async function executeVercelMutationFromOpsChat(
  ctx: TenantContext,
  input: OpsChatVercelMutationInput,
): Promise<OpsChatVercelMutationResult> {
  const parsed = vercelMutationPayloadSchema.safeParse(input);
  if (!parsed.success) throw new AppError('validation', `The Vercel mutation is not executable: ${issuesOf(parsed.error)}`);
  const payload = parsed.data;

  const { approvalId, taskId } = await withTenant(ctx, async (tx) => {
    const links = await listVercelProjectLinks(tx, ctx);
    if (!links.some((l) => l.vercelProjectId === payload.vercelProjectId)) {
      throw new AppError('not_found', `Vercel project "${payload.vercelProjectId}" is not linked to this workspace.`);
    }
    const agent = (await listAgents(tx, ctx)).find((a) => a.enabled);
    if (!agent) throw new AppError('conflict', 'This workspace has no enabled employee to anchor the action.');

    const anchorTaskId = await createTask(tx, ctx, {
      title: `Vercel ${payload.operation}: ${payload.vercelProjectId}`.slice(0, 200),
      input: `Owner-initiated Vercel ${payload.operation} prepared via Ops Chat.\n${summarize(payload)}`,
      providerSelection: agent.provider,
      reviewEnabled: false,
      primaryAgentId: agent.id,
    });

    const payloadSha256 = sha256Hex(canonicalJson(payload));
    const inserted = await tx
      .insert(approvals)
      .values({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        taskId: anchorTaskId,
        actionType: 'vercel_mutation',
        payload,
        payloadSha256,
        summary: summarize(payload),
        status: 'pending',
        expiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS),
      })
      .returning({ id: approvals.id });

    const id = inserted[0]!.id;
    await decideApproval(tx, ctx, id, 'approved', 'Confirmed via Ops Chat Vercel bridge');
    return { approvalId: id, taskId: anchorTaskId };
  });

  const out = await executeApprovedIfEligible(ctx, approvalId);

  await withTenant(ctx, (tx) =>
    setTaskStatus(tx, ctx, taskId, out.outcome === 'succeeded' ? 'completed' : 'failed'),
  ).catch(() => {
    /* finalization is best-effort; the execution result + audit are the source of truth */
  });

  const preview = out.preview as { newDeploymentId?: unknown; productionDeploymentId?: unknown; productionChanged?: unknown } | null;
  return {
    approvalId,
    attempted: out.attempted,
    outcome: out.outcome,
    message: out.message,
    operation: payload.operation,
    newDeploymentId: preview && typeof preview.newDeploymentId === 'string' ? preview.newDeploymentId : null,
    productionDeploymentId: preview && typeof preview.productionDeploymentId === 'string' ? preview.productionDeploymentId : null,
    productionChanged: preview && typeof preview.productionChanged === 'boolean' ? preview.productionChanged : null,
  };
}
