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
import {
  createPrPayloadSchema,
  mergePrPayloadSchema,
  rerunFailedWorkflowPayloadSchema,
  findGitPrPlaceholder,
  type CreatePrPayload,
  type MergePrPayload,
  type RerunFailedWorkflowPayload,
  type GitPrPayload,
} from '@/domain/execution/git-pr-executor';

/**
 * Ops Chat → GitHub bridge (Phase 2A/2B), the CONFIRM side. This is the ONLY place the GitHub bridge writes, and
 * every operation — create_pr, merge_pr, rerun_failed_workflow — goes through the SAME governed-execution path:
 *
 *   validate payload → create an anchor task → insert a `git_pr` approval → decideApproval(admin) →
 *   executeApprovedIfEligible → the dispatch choke point → the git_pr executor → the real GitHub side effect.
 *
 * No new executor, dispatch, or confirmation machinery is introduced: the approval carries the exact git_pr
 * payload (operation-discriminated) + its sha256, and the dispatch choke point re-verifies admin authority,
 * payload integrity, executor enablement, a fresh payload-bound confirmation, and idempotency (one key per
 * approval). The model never reaches this module — it only PROPOSES; the admin's confirm in the Ops Chat confirm
 * route is what calls here. There is no model-side write and nothing executes before that confirm.
 */

/** The approval's decision window. executeApprovedIfEligible mints its own short execution confirmation inside it. */
const APPROVAL_WINDOW_MS = 10 * 60 * 1000;

// ── Inputs / results ───────────────────────────────────────────────────────

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

export interface OpsChatGitMergeInput {
  readonly repo: string;
  readonly prNumber: number;
  readonly expectedHeadSha: string;
  readonly expectedBaseBranch: string;
  readonly mergeMethod?: 'squash' | 'merge' | 'rebase';
}
export interface OpsChatGitMergeResult {
  readonly approvalId: string;
  readonly attempted: boolean;
  readonly outcome: ApprovalExecutionOutcome['outcome'];
  readonly message: string | null;
  readonly prUrl: string | null;
  readonly mergeCommitSha: string | null;
}

export interface OpsChatGitRerunInput {
  readonly repo: string;
  readonly runId: number;
  readonly expectedHeadSha: string;
  readonly expectedRunAttempt: number;
}
export interface OpsChatGitRerunResult {
  readonly approvalId: string;
  readonly attempted: boolean;
  readonly outcome: ApprovalExecutionOutcome['outcome'];
  readonly message: string | null;
  readonly runId: number;
  readonly attempt: number | null;
  readonly state: string | null;
  readonly runUrl: string | null;
}

// ── Payload validation (refusal, never repair) ───────────────────────────────

function issuesOf(error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> }): string {
  return error.issues.map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`).join('; ');
}

function parseCreatePrPayload(input: OpsChatGitPrInput): CreatePrPayload {
  const parsed = createPrPayloadSchema.safeParse({
    operation: 'create_pr',
    repo: input.repo,
    branch: input.branch,
    title: input.title,
    body: input.body ?? '',
    ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
    files: input.files,
  });
  if (!parsed.success) throw new AppError('validation', `The GitHub action is not executable: ${issuesOf(parsed.error)}`);
  // Defense in depth — the executor re-checks these too, but refuse early with a clear message.
  for (const file of parsed.data.files) {
    const marker = findGitPrPlaceholder(file.content);
    if (marker) {
      throw new AppError('validation', `File "${file.path}" contains placeholder text ("${marker}") instead of the real file content.`);
    }
  }
  return parsed.data;
}

function parseMergePayload(input: OpsChatGitMergeInput): MergePrPayload {
  const parsed = mergePrPayloadSchema.safeParse({
    operation: 'merge_pr',
    repo: input.repo,
    prNumber: input.prNumber,
    expectedHeadSha: input.expectedHeadSha,
    expectedBaseBranch: input.expectedBaseBranch,
    ...(input.mergeMethod ? { mergeMethod: input.mergeMethod } : {}),
  });
  if (!parsed.success) throw new AppError('validation', `The GitHub merge is not executable: ${issuesOf(parsed.error)}`);
  return parsed.data;
}

function parseRerunPayload(input: OpsChatGitRerunInput): RerunFailedWorkflowPayload {
  const parsed = rerunFailedWorkflowPayloadSchema.safeParse({
    operation: 'rerun_failed_workflow',
    repo: input.repo,
    runId: input.runId,
    expectedHeadSha: input.expectedHeadSha,
    expectedRunAttempt: input.expectedRunAttempt,
  });
  if (!parsed.success) throw new AppError('validation', `The GitHub rerun is not executable: ${issuesOf(parsed.error)}`);
  return parsed.data;
}

// ── The single governed path every operation runs through ────────────────────

interface GovernedActionMeta {
  readonly taskTitle: string;
  readonly taskInput: string;
  readonly summary: string;
}

async function runGovernedGitAction(
  ctx: TenantContext,
  payload: GitPrPayload,
  meta: GovernedActionMeta,
): Promise<ApprovalExecutionOutcome & { approvalId: string }> {
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

    const anchorTaskId = await createTask(tx, ctx, {
      title: meta.taskTitle.slice(0, 200),
      input: meta.taskInput,
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
        actionType: 'git_pr',
        payload,
        payloadSha256,
        summary: meta.summary,
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

  return { approvalId, ...result };
}

// ── Public bridges (one per operation) ───────────────────────────────────────

export async function executeGitHubPrFromOpsChat(ctx: TenantContext, input: OpsChatGitPrInput): Promise<OpsChatGitPrResult> {
  const payload = parseCreatePrPayload(input);
  const paths = payload.files.map((f) => f.path).join(', ');
  const out = await runGovernedGitAction(ctx, payload, {
    taskTitle: `GitHub PR: ${payload.title}`,
    taskInput:
      `Owner-initiated GitHub pull request prepared via Ops Chat.\n` +
      `Repository: ${payload.repo}\nBranch: ${payload.branch} → ${payload.baseBranch ?? '(default branch)'}\n` +
      `Title: ${payload.title}\nFiles (${payload.files.length}): ${paths}`,
    summary:
      `Open a pull request in ${payload.repo} from ${payload.branch} into ${payload.baseBranch ?? 'the default branch'} — ` +
      `"${payload.title}" (${payload.files.length} file${payload.files.length === 1 ? '' : 's'}).`,
  });
  return { approvalId: out.approvalId, attempted: out.attempted, outcome: out.outcome, message: out.message, prUrl: out.prUrl };
}

export async function executeGitHubMergeFromOpsChat(ctx: TenantContext, input: OpsChatGitMergeInput): Promise<OpsChatGitMergeResult> {
  const payload = parseMergePayload(input);
  const out = await runGovernedGitAction(ctx, payload, {
    taskTitle: `GitHub merge: PR #${payload.prNumber} in ${payload.repo}`,
    taskInput:
      `Owner-initiated GitHub PR merge prepared via Ops Chat.\n` +
      `Repository: ${payload.repo}\nPR: #${payload.prNumber}\nExpected head: ${payload.expectedHeadSha}\n` +
      `Into: ${payload.expectedBaseBranch}\nMethod: ${payload.mergeMethod}`,
    summary:
      `Merge PR #${payload.prNumber} in ${payload.repo} into ${payload.expectedBaseBranch} via ${payload.mergeMethod} ` +
      `at head ${payload.expectedHeadSha.slice(0, 7)} — requires the PR open, non-draft, matching head, and green CI.`,
  });
  const preview = out.preview as { mergeCommitSha?: unknown } | null;
  return {
    approvalId: out.approvalId,
    attempted: out.attempted,
    outcome: out.outcome,
    message: out.message,
    prUrl: out.prUrl,
    mergeCommitSha: preview && typeof preview.mergeCommitSha === 'string' ? preview.mergeCommitSha : null,
  };
}

export async function executeGitHubRerunFromOpsChat(ctx: TenantContext, input: OpsChatGitRerunInput): Promise<OpsChatGitRerunResult> {
  const payload = parseRerunPayload(input);
  const out = await runGovernedGitAction(ctx, payload, {
    taskTitle: `GitHub rerun: run ${payload.runId} in ${payload.repo}`,
    taskInput:
      `Owner-initiated GitHub workflow rerun prepared via Ops Chat.\n` +
      `Repository: ${payload.repo}\nRun: ${payload.runId}\nExpected head: ${payload.expectedHeadSha}\n` +
      `Expected attempt: ${payload.expectedRunAttempt}`,
    summary:
      `Re-run the FAILED jobs of workflow run ${payload.runId} in ${payload.repo} ` +
      `(attempt ${payload.expectedRunAttempt}, head ${payload.expectedHeadSha.slice(0, 7)}) — requires a completed, failed run.`,
  });
  const preview = out.preview as { attempt?: unknown; state?: unknown; runUrl?: unknown } | null;
  return {
    approvalId: out.approvalId,
    attempted: out.attempted,
    outcome: out.outcome,
    message: out.message,
    runId: payload.runId,
    attempt: preview && typeof preview.attempt === 'number' ? preview.attempt : null,
    state: preview && typeof preview.state === 'string' ? preview.state : null,
    runUrl: preview && typeof preview.runUrl === 'string' ? preview.runUrl : null,
  };
}
