import 'server-only';
import { AppError } from '@/lib/errors';
import { withTenant } from '@/db/tenant';
import { approvals } from '@/db/schema';
import { type TenantContext } from '@/types/domain';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { listRepoLinks } from '@/domain/github/links';
import { listSupabaseProjectLinks } from '@/domain/supabase/links';
import { listAgents } from '@/domain/agents/agents';
import { createTask, setTaskStatus } from '@/domain/tasks/tasks';
import { decideApproval } from '@/domain/approvals/approvals';
import { executeApprovedIfEligible, type ApprovalExecutionOutcome } from '@/domain/execution/execute-on-approval';
import { deployEdgeFunctionPayloadSchema, type DeployEdgeFunctionPayload } from '@/domain/supabase/deploy-executor';

/**
 * Ops Chat → Supabase bridge (Phase 2C write slice), the CONFIRM side. The ONLY place the Supabase write bridge
 * writes, and it goes through the SAME governed-execution path as the GitHub bridge:
 *
 *   validate payload → create an anchor task → insert a `supabase_deploy` approval → decideApproval(admin) →
 *   executeApprovedIfEligible → the dispatch choke point → the supabase_deploy executor → the real deploy.
 *
 * No new executor, dispatch, or confirmation machinery: the approval carries the exact deploy payload + its
 * sha256, and the dispatch choke point re-verifies admin authority, payload integrity, executor enablement, a
 * fresh payload-bound confirmation, and idempotency (one key per approval). The model never reaches this module —
 * it only PROPOSES; the admin's confirm in the Ops Chat confirm route is what calls here, and nothing executes
 * before that confirm.
 */

/** The approval's decision window. executeApprovedIfEligible mints its own short execution confirmation inside it. */
const APPROVAL_WINDOW_MS = 10 * 60 * 1000;

export interface OpsChatSupabaseDeployInput {
  readonly projectRef: string;
  readonly functionSlug: string;
  readonly sourceRepo: string;
  readonly sourceSha: string;
  readonly sourcePath: string;
  readonly entrypointPath?: string;
  readonly importMapPath?: string;
  readonly verifyJwt: boolean;
}

export interface OpsChatSupabaseDeployResult {
  readonly approvalId: string;
  readonly attempted: boolean;
  readonly outcome: ApprovalExecutionOutcome['outcome'];
  readonly message: string | null;
  readonly projectRef: string;
  readonly functionSlug: string;
  readonly sourceSha: string;
  readonly version: number | null;
  readonly contentDigest: string | null;
}

function issuesOf(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}

function parseDeployPayload(input: OpsChatSupabaseDeployInput): DeployEdgeFunctionPayload {
  const parsed = deployEdgeFunctionPayloadSchema.safeParse({
    operation: 'deploy_edge_function',
    projectRef: input.projectRef,
    functionSlug: input.functionSlug,
    sourceRepo: input.sourceRepo,
    sourceSha: input.sourceSha,
    sourcePath: input.sourcePath,
    ...(input.entrypointPath ? { entrypointPath: input.entrypointPath } : {}),
    ...(input.importMapPath ? { importMapPath: input.importMapPath } : {}),
    verifyJwt: input.verifyJwt,
  });
  if (!parsed.success) throw new AppError('validation', `The Supabase deploy is not executable: ${issuesOf(parsed.error)}`);
  return parsed.data;
}

export async function executeSupabaseDeployFromOpsChat(
  ctx: TenantContext,
  input: OpsChatSupabaseDeployInput,
): Promise<OpsChatSupabaseDeployResult> {
  const payload = parseDeployPayload(input);

  // 1) Create the anchor task + the approved supabase_deploy approval, in one tenant transaction.
  const { approvalId, taskId } = await withTenant(ctx, async (tx) => {
    const projectLinks = await listSupabaseProjectLinks(tx, ctx);
    if (!projectLinks.some((l) => l.projectRef === payload.projectRef)) {
      throw new AppError('not_found', `Supabase project "${payload.projectRef}" is not linked to this workspace.`);
    }
    const repoLinks = await listRepoLinks(tx, ctx);
    if (!repoLinks.some((l) => l.repoFullName === payload.sourceRepo)) {
      throw new AppError('not_found', `Source repository "${payload.sourceRepo}" is not linked to this workspace.`);
    }
    const agent = (await listAgents(tx, ctx)).find((a) => a.enabled);
    if (!agent) throw new AppError('conflict', 'This workspace has no enabled employee to anchor the action.');

    const anchorTaskId = await createTask(tx, ctx, {
      title: `Supabase deploy: ${payload.functionSlug}`.slice(0, 200),
      input:
        `Owner-initiated Supabase edge-function deploy prepared via Ops Chat.\n` +
        `Project: ${payload.projectRef}\nFunction: ${payload.functionSlug}\n` +
        `Source: ${payload.sourceRepo}@${payload.sourceSha}\nPath: ${payload.sourcePath}\n` +
        `Entrypoint: ${payload.entrypointPath}\nverify_jwt: ${payload.verifyJwt}`,
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
        actionType: 'supabase_deploy',
        payload,
        payloadSha256,
        summary:
          `Deploy edge function "${payload.functionSlug}" to Supabase project ${payload.projectRef} from ` +
          `${payload.sourceRepo}@${payload.sourceSha.slice(0, 7)} (verify_jwt=${payload.verifyJwt}). ` +
          `Reversible by redeploying the prior source SHA.`,
        status: 'pending',
        expiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS),
      })
      .returning({ id: approvals.id });

    const id = inserted[0]!.id;
    await decideApproval(tx, ctx, id, 'approved', 'Confirmed via Ops Chat Supabase bridge');
    return { approvalId: id, taskId: anchorTaskId };
  });

  // 2) Execute through the EXISTING dispatch choke point (re-verifies everything; mints a fresh confirmation).
  const out = await executeApprovedIfEligible(ctx, approvalId);

  // 3) Finalize the anchor task so it never lingers as pending work.
  await withTenant(ctx, (tx) =>
    setTaskStatus(tx, ctx, taskId, out.outcome === 'succeeded' ? 'completed' : 'failed'),
  ).catch(() => {
    /* finalization is best-effort; the execution result + audit are the source of truth */
  });

  const preview = out.preview as { version?: unknown; contentDigest?: unknown } | null;
  return {
    approvalId,
    attempted: out.attempted,
    outcome: out.outcome,
    message: out.message,
    projectRef: payload.projectRef,
    functionSlug: payload.functionSlug,
    sourceSha: payload.sourceSha,
    version: preview && typeof preview.version === 'number' ? preview.version : null,
    contentDigest: preview && typeof preview.contentDigest === 'string' ? preview.contentDigest : null,
  };
}
