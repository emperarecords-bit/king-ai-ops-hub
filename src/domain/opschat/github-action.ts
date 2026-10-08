import 'server-only';
import { AppError } from '@/lib/errors';
import { withTenant } from '@/db/tenant';
import { approvals } from '@/db/schema';
import { type TenantContext } from '@/types/domain';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { listRepoLinks } from '@/domain/github/links';
import { listAgents } from '@/domain/agents/agents';
import { createTask, setTaskStatus } from '@/domain/tasks/tasks';
import { decideApproval } from '@/domain/approvals/approvals';
import { executeApprovedIfEligible, type ApprovalExecutionOutcome } from '@/domain/execution/execute-on-approval';
import { gitPrPayloadSchema, findGitPrPlaceholder, type GitPrPayload } from '@/domain/execution/git-pr-executor';

/**
 * Ops Chat → GitHub create-PR bridge (Phase 2A), the CONFIRM side. This is the ONLY place the GitHub bridge
 * writes, and it does so exclusively through the existing governed-execution path:
 *
 *   validate payload → create an anchor task → insert a `git_pr` approval → decideApproval(admin) →
 *   executeApprovedIfEligible → the dispatch choke point → the git_pr executor → real branch+commit+PR.
 *
 * No new executor, dispatch, or confirmation machinery is introduced: the approval carries the exact
 * git_pr payload + its sha256, and the dispatch choke point re-verifies admin authority, payload integrity,
 * executor enablement, a fresh payload-bound confirmation, and idempotency (one key per approval). The model
 * never reaches this module — it only PROPOSES; the admin's confirm in the Ops Chat confirm route is what
 * calls here. There is no model-side write and nothing executes before that confirm.
 */

/** The approval's decision window. executeApprovedIfEligible mints its own short execution confirmation inside it. */
const APPROVAL_WINDOW_MS = 10 * 60 * 1000;

export interface OpsChatGitPrInput {
  readonly repo: string;
  readonly branch: string;
  readonly baseBranch?: string;
  readonly title: string;
  readonly body?: string;
  readonly files: ReadonlyArray<{ path: string; content: string }>;
}

export interface OpsChatGitPrResult {
  readonly approvalId: string;
  readonly attempted: boolean;
  readonly outcome: ApprovalExecutionOutcome['outcome'];
  readonly message: string | null;
  readonly prUrl: string | null;
}

/** Validate the proposed create-PR into the exact executor payload, or throw a clear AppError. */
function parsePayload(input: OpsChatGitPrInput): GitPrPayload {
  const parsed = gitPrPayloadSchema.safeParse({
    repo: input.repo,
    branch: input.branch,
    title: input.title,
    body: input.body ?? '',
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    files: input.files,
  });
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    throw new AppError('validation', `The GitHub action is not executable: ${issues}`);
  }
  // Defense in depth — the executor re-checks these too, but refuse early with a clear message.
  for (const file of parsed.data.files) {
    const marker = findGitPrPlaceholder(file.content);
    if (marker) {
      throw new AppError('validation', `File "${file.path}" contains placeholder text ("${marker}") instead of the real file content.`);
    }
  }
  return parsed.data;
}

export async function executeGitHubPrFromOpsChat(ctx: TenantContext, input: OpsChatGitPrInput): Promise<OpsChatGitPrResult> {
  const payload = parsePayload(input);

  // 1) Create the anchor task + the approved git_pr approval, in one tenant transaction.
  const { approvalId, taskId } = await withTenant(ctx, async (tx) => {
    const links = await listRepoLinks(tx, ctx);
    if (!links.some((l) => l.repoFullName === payload.repo)) {
      throw new AppError('not_found', `Repository "${payload.repo}" is not linked to this workspace.`);
    }

    // An approval must hang off a task (schema invariant). Anchor it to the workspace's first enabled
    // employee — the action is owner-initiated via Ops Chat; no AI run is enqueued.
    const agent = (await listAgents(tx, ctx)).find((a) => a.enabled);
    if (!agent) throw new AppError('conflict', 'This workspace has no enabled employee to anchor the action.');

    const paths = payload.files.map((f) => f.path).join(', ');
    const anchorTaskId = await createTask(tx, ctx, {
      title: `GitHub PR: ${payload.title}`.slice(0, 200),
      input:
        `Owner-initiated GitHub pull request prepared via Ops Chat.\n` +
        `Repository: ${payload.repo}\nBranch: ${payload.branch} → ${payload.baseBranch ?? '(default branch)'}\n` +
        `Title: ${payload.title}\nFiles (${payload.files.length}): ${paths}`,
      providerSelection: agent.provider,
      reviewEnabled: false,
      primaryAgentId: agent.id,
    });

    const payloadSha256 = sha256Hex(canonicalJson(payload));
    const summary =
      `Open a pull request in ${payload.repo} from ${payload.branch} into ${payload.baseBranch ?? 'the default branch'} — ` +
      `"${payload.title}" (${payload.files.length} file${payload.files.length === 1 ? '' : 's'}).`;

    const inserted = await tx
      .insert(approvals)
      .values({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        taskId: anchorTaskId,
        actionType: 'git_pr',
        payload,
        payloadSha256,
        summary,
        status: 'pending',
        expiresAt: new Date(Date.now() + APPROVAL_WINDOW_MS),
      })
      .returning({ id: approvals.id });

    const id = inserted[0]!.id;
    // The admin's Ops Chat confirm IS the approval decision — recorded through the sanctioned path.
    await decideApproval(tx, ctx, id, 'approved', 'Confirmed via Ops Chat GitHub bridge');
    return { approvalId: id, taskId: anchorTaskId };
  });

  // 2) Execute through the EXISTING dispatch choke point (re-verifies everything; mints a fresh confirmation).
  const result = await executeApprovedIfEligible(ctx, approvalId);

  // 3) Finalize the anchor task so it never lingers as pending work.
  await withTenant(ctx, (tx) =>
    setTaskStatus(tx, ctx, taskId, result.outcome === 'succeeded' ? 'completed' : 'failed'),
  ).catch(() => {
    /* finalization is best-effort; the execution result + audit are the source of truth */
  });

  return {
    approvalId,
    attempted: result.attempted,
    outcome: result.outcome,
    message: result.message,
    prUrl: result.prUrl,
  };
}
