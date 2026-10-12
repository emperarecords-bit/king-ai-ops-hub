import { z } from 'zod';
import { sha256Hex } from '@/lib/crypto';
import { canonicalJson } from '@/orchestration/actions';
import { type GitHubRepoClient, type RepoRef, type RepoFullTreeEntry, type RepoTreeOverride } from '@/domain/github/client';
import { GitHubApiError } from '@/domain/github/live-client';
import { classifyGitHubMutationError } from '@/domain/github/error-classify';
import { assessGitWrite } from '@/domain/github/write-policy';
import {
  type Executor,
  type ExecutorAction,
  type ExecutorCapability,
  type ExecutorProvenance,
  type ExecutorResult,
} from './executor-contract';

export const GIT_PR_EXECUTOR_ID = 'git_pr';
export const GIT_PR_EXECUTOR_VERSION = '2';

/**
 * Placeholder-disease guard (incident 2026-08-20): an agent proposed replacing a 631-line file with
 * the literal text "<COMPLETE FILE CONTENT NEEDED>", which would have destroyed it on merge. Any
 * proposed file whose content matches one of these markers is a refusal — the payload is a summary
 * of an edit, not the edit itself, and committing it destroys whatever it claims to preserve.
 */
export const GIT_PR_PLACEHOLDER_PATTERNS: readonly RegExp[] = Object.freeze([
  // Angle-bracketed content tokens, e.g. "<COMPLETE FILE CONTENT NEEDED>", "<FILE CONTENT HERE>".
  /<[^>\n]*FILE\s+CONTENTS?[^>\n]*>/i,
  // Unbracketed variants, e.g. "COMPLETE FILE CONTENT NEEDED", "full file content goes here".
  /\b(?:COMPLETE|FULL|ENTIRE)\s+FILE\s+CONTENTS?\s+(?:NEEDED|HERE|GOES\s+HERE)\b/i,
  // Elision markers that promise the rest of the file without carrying it.
  /\brest\s+of\s+(?:the\s+)?file\s+(?:remains\s+|is\s+)?unchanged\b/i,
  /(?:\.\.\.|…)\s*existing\s+code|existing\s+code\s*(?:\.\.\.|…)/i,
  /\bTODO:?\s*(?:add\s+|insert\s+|fill\s+in\s+)?(?:the\s+)?full\s+(?:file\s+)?content\b/i,
]);

/** First placeholder marker found in proposed file content, or null when the content is clean. */
export function findGitPrPlaceholder(content: string): string | null {
  for (const pattern of GIT_PR_PLACEHOLDER_PATTERNS) {
    const match = pattern.exec(content);
    if (match) return match[0].trim();
  }
  return null;
}

/**
 * Shrink guard: replacing an existing file while discarding more than ~90% of it is the signature
 * of a truncated/placeholder proposal, not a real edit. Only meaningful for files already big
 * enough that the loss is destructive — tiny files shrink legitimately all the time.
 */
export const GIT_PR_SHRINK_GUARD = Object.freeze({
  /** Existing files smaller than this are exempt (a 90% shrink of a 100-byte file is a normal edit). */
  minExistingBytes: 256,
  /** Proposed content must keep at least this fraction of the existing file's bytes. */
  minSurvivingFraction: 0.1,
});

/** Canonical `owner/repo`; must be a repository linked to this workspace. Shared by every operation. */
const repoSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/);
/** A git SHA, abbreviated (7) to full (40). */
const shaSchema = z.string().regex(/^[0-9a-fA-F]{7,40}$/);

/**
 * `create_pr` — the original git_pr payload (unchanged except the explicit `operation` discriminator). Anything
 * the model emits is hostile until it survives this parse — extra keys, wrong shapes, and oversized content are
 * all refusals, never best-effort repairs.
 */
export const createPrPayloadSchema = z.object({
  operation: z.literal('create_pr'),
  repo: repoSchema,
  /** The NEW work branch the changes land on. Never a default branch (write policy re-verifies). */
  branch: z.string().min(1).max(200),
  title: z.string().min(1).max(300),
  body: z.string().max(20_000).default(''),
  /** PR target; defaults to the linked repository's default branch — the sanctioned route into it. */
  baseBranch: z.string().min(1).max(200).optional(),
  files: z
    .array(z.object({ path: z.string().min(1).max(500), content: z.string().max(100_000) }).strict())
    .min(1)
    .max(20),
}).strict();

/**
 * `merge_pr` — land an EXISTING reviewed PR. Every gate the spec requires is an explicit, bound field: the exact
 * PR number, the expected head SHA (stale heads are refused — and the SHA also binds the merge request itself),
 * the expected base branch, and a fixed merge method (squash by default). CI-green / not-draft / not-closed are
 * verified live by the executor against GitHub.
 */
export const mergePrPayloadSchema = z.object({
  operation: z.literal('merge_pr'),
  repo: repoSchema,
  prNumber: z.number().int().positive(),
  expectedHeadSha: shaSchema,
  expectedBaseBranch: z.string().min(1).max(200),
  mergeMethod: z.enum(['squash', 'merge', 'rebase']).default('squash'),
}).strict();

/**
 * `rerun_failed_workflow` — re-run only the FAILED jobs of a completed, failed run. Bound to the exact run id,
 * expected head SHA, and expected run attempt (stale attempts are refused). Uses the rerun-failed-jobs endpoint,
 * never workflow_dispatch.
 */
export const rerunFailedWorkflowPayloadSchema = z.object({
  operation: z.literal('rerun_failed_workflow'),
  repo: repoSchema,
  runId: z.number().int().positive(),
  expectedHeadSha: shaSchema,
  expectedRunAttempt: z.number().int().positive(),
}).strict();

/**
 * `revert_commit` (Phase 2E) — construct the exact inverse of ONE already-landed commit as a NEW work branch + PR
 * back into its base, WITHOUT a local clone and WITHOUT ever writing the default branch. Every field is an exact,
 * bound input: the repo, the target commit SHA, the base branch and its expected current head (a moved head is
 * refused — staleness guard), and the dedicated revert branch to create. The baseline is the target's FIRST parent
 * (works for squash/normal single-parent commits and, for a true merge, the mainline). The executor computes the
 * baseline→target tree delta and, for every affected path, requires the current base to equal the target entry
 * EXACTLY (path + object SHA + mode + type) — else it is already-reverted (skip) or a conflict (BLOCK). It never
 * does a 3-way merge. Reversible by construction (the inverse is itself a PR you can close).
 */
export const revertCommitPayloadSchema = z.object({
  operation: z.literal('revert_commit'),
  repo: repoSchema,
  /** The commit to revert (the merge/squash commit for a landed PR). */
  targetSha: shaSchema,
  /** The branch the revert PR targets AND whose current head is verified (never written directly). */
  expectedBaseBranch: z.string().min(1).max(200),
  /** The base branch's expected current head — a moved head is refused (stale). */
  expectedBaseHeadSha: shaSchema,
  /** The NEW dedicated work branch the inverse commit lands on (never a default branch; write policy re-verifies). */
  revertBranch: z.string().min(1).max(200),
}).strict();

/**
 * The git_pr payload is an operation-discriminated union. BACKWARD COMPATIBILITY: a create-PR payload stored
 * before Phase 2B has no `operation` key — the preprocess defaults it to 'create_pr' so it still routes. This is
 * safe because the payload HASH is verified over the stored RAW payload BEFORE this parse runs (at the choke
 * point and again in the executor), so defaulting here never changes the integrity binding.
 */
export const gitPrPayloadSchema = z.preprocess(
  (v) =>
    v && typeof v === 'object' && !Array.isArray(v) && (v as { operation?: unknown }).operation === undefined
      ? { operation: 'create_pr', ...(v as Record<string, unknown>) }
      : v,
  z.discriminatedUnion('operation', [createPrPayloadSchema, mergePrPayloadSchema, rerunFailedWorkflowPayloadSchema, revertCommitPayloadSchema]),
);

export type GitPrPayload = z.infer<typeof gitPrPayloadSchema>;
export type CreatePrPayload = z.infer<typeof createPrPayloadSchema>;
export type MergePrPayload = z.infer<typeof mergePrPayloadSchema>;
export type RerunFailedWorkflowPayload = z.infer<typeof rerunFailedWorkflowPayloadSchema>;
export type RevertCommitPayload = z.infer<typeof revertCommitPayloadSchema>;

export interface GitPrRepoLink {
  readonly installationId: bigint;
  readonly repoFullName: string;
  readonly defaultBranch: string;
}

/** The frozen result builder `execute()` creates and shares with the per-operation handlers. */
type ResultFn = (
  outcome: ExecutorResult['outcome'],
  message: string,
  preview: Record<string, unknown> | null,
  opts?: { reconciliation?: ExecutorResult['reconciliation']; retryAllowed?: boolean },
) => ExecutorResult;

export interface GitPrExecutorDeps {
  readonly client: GitHubRepoClient;
  /** The workspace's linked repositories (github_repo_links), loaded by the trusted dispatcher. */
  readonly loadLinks: () => Promise<readonly GitPrRepoLink[]>;
  readonly now?: () => Date;
}

const CAPABILITY: ExecutorCapability = Object.freeze({
  executorId: GIT_PR_EXECUTOR_ID,
  contractVersion: '1',
  actionTypes: ['git_pr'] as const,
  riskClasses: ['external_reversible'] as const,
  supportedModes: ['dry_run', 'live'] as const,
  enabledByDefault: false,
  externalSideEffects: true,
});

/**
 * The first live executor: an approved `git_pr` action becomes a real branch + commit + pull
 * request through the policy-gated GitHub client. Reversible by construction — a PR can be closed,
 * a work branch deleted; the default branch is untouchable (write policy, enforced twice: here and
 * inside every mutating client method). Failure AFTER the first side effect is reported `ambiguous`
 * with reconciliation required, never silently retried. Since v2 (incident 2026-08-20) proposed
 * content is itself distrusted: placeholder markers and >90% shrinks of existing files are
 * `blocked` before any write.
 */
export class GitPrExecutor implements Executor {
  readonly capability = CAPABILITY;

  constructor(private readonly deps: GitPrExecutorDeps) {}

  async execute(action: ExecutorAction): Promise<ExecutorResult> {
    const attemptedAt = (this.deps.now?.() ?? new Date()).toISOString();
    const result = (
      outcome: ExecutorResult['outcome'],
      message: string,
      preview: Record<string, unknown> | null,
      opts: { reconciliation?: ExecutorResult['reconciliation']; retryAllowed?: boolean } = {},
    ): ExecutorResult =>
      Object.freeze({
        outcome,
        reconciliation: opts.reconciliation ?? 'not_required',
        retryAllowed: opts.retryAllowed ?? false,
        message,
        preview: preview ? Object.freeze(preview) : null,
        provenance: this.provenance(action, attemptedAt),
      });

    if (action.actionType !== 'git_pr') {
      return result('blocked', 'GitPrExecutor only executes git_pr actions.', null);
    }
    // Defense in depth: the dispatcher already verified this, but the executor never trusts its caller.
    if (sha256Hex(canonicalJson(action.payload)) !== action.payloadSha256) {
      return result('blocked', 'Payload integrity re-verification failed at the executor.', null);
    }
    const parsed = gitPrPayloadSchema.safeParse(action.payload);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      return result('blocked', `git_pr payload is not executable: ${issues}`, null);
    }
    const payload = parsed.data;

    // Phase 2B operations ride the git_pr action but diverge here — they operate on an existing PR / workflow
    // run, not on a new work branch, so they take their own governed path (NOT assessGitWrite, which forbids
    // every default-branch write). The shared choke-point invariants (admin, confirmation, enablement,
    // idempotency, payload hash — already enforced before this executor runs) still bind them.
    if (payload.operation === 'merge_pr') return this.executeMerge(action, payload, result);
    if (payload.operation === 'rerun_failed_workflow') return this.executeRerun(action, payload, result);
    if (payload.operation === 'revert_commit') return this.executeRevert(action, payload, result);
    // Below here `payload` is narrowed to the create_pr shape — the original flow, unchanged.

    // Placeholder-disease guard: pure content check, enforced in every mode before anything else.
    for (const file of payload.files) {
      const marker = findGitPrPlaceholder(file.content);
      if (marker) {
        return result(
          'blocked',
          `git_pr file "${file.path}" contains placeholder text ("${marker}") where real file content is required. Committing a placeholder destroys the file it claims to preserve — the proposal must carry the complete intended content.`,
          null,
        );
      }
    }

    const links = await this.deps.loadLinks();
    const link = links.find((l) => l.repoFullName === payload.repo);
    if (!link) {
      return result('blocked', `Repository "${payload.repo}" is not linked to this workspace.`, null);
    }

    const assessment = assessGitWrite({
      actionType: 'git_pr',
      targetRepo: payload.repo,
      targetBranch: payload.branch,
      linkedRepo: link.repoFullName,
      defaultBranch: link.defaultBranch,
    });
    if (!assessment.allowed) return result('blocked', assessment.reason, null);

    const intoBranch = (payload.baseBranch ?? link.defaultBranch).replace(/^refs\/heads\//, '');
    const plan = {
      repo: payload.repo,
      branch: payload.branch,
      intoBranch,
      title: payload.title,
      fileCount: payload.files.length,
      paths: payload.files.map((f) => f.path),
    };

    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would open a pull request "${payload.title}" from ${payload.branch} into ${intoBranch}.`, { ...plan, wouldExecute: true });
    }

    const repo: RepoRef = { installationId: link.installationId, repoFullName: link.repoFullName };

    // Shrink guard: read the PR target's tree (read-only) BEFORE any side effect. A proposed file
    // that replaces an existing one while keeping <10% of its bytes is placeholder disease with the
    // markers stripped — blocked, never committed. Failure to read the tree is a retryable failure:
    // the guard fails closed rather than writing unverified.
    let existingSizes: ReadonlyMap<string, number>;
    try {
      const tree = await this.deps.client.listTree(repo, intoBranch);
      existingSizes = new Map(
        tree.filter((e) => e.type === 'blob' && e.size !== null).map((e) => [e.path, e.size as number]),
      );
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `No side effect occurred: could not read ${intoBranch} to verify existing file sizes: ${detail}`, plan, { retryAllowed: true });
    }
    for (const file of payload.files) {
      const existingBytes = existingSizes.get(file.path);
      if (existingBytes === undefined || existingBytes < GIT_PR_SHRINK_GUARD.minExistingBytes) continue;
      const proposedBytes = Buffer.byteLength(file.content, 'utf8');
      if (proposedBytes < existingBytes * GIT_PR_SHRINK_GUARD.minSurvivingFraction) {
        return result(
          'blocked',
          `git_pr file "${file.path}" would shrink an existing ${existingBytes}-byte file on ${intoBranch} to ${proposedBytes} bytes (over ${Math.round((1 - GIT_PR_SHRINK_GUARD.minSurvivingFraction) * 100)}% loss). That is the signature of a truncated or placeholder proposal — a real replacement must carry the complete intended content.`,
          plan,
        );
      }
    }

    let sideEffectStarted = false;
    try {
      try {
        await this.deps.client.createBranch(repo, intoBranch, payload.branch);
        sideEffectStarted = true;
      } catch (err) {
        // 422 = ref already exists: an earlier attempt (or the agent) created the work branch. Committing
        // onto it is safe — it is still a non-default branch by policy.
        if (err instanceof GitHubApiError && err.status === 422) sideEffectStarted = true;
        else throw err;
      }
      await this.deps.client.commitToBranch(repo, payload.branch, payload.files, payload.title);
      const { prNumber } = await this.deps.client.openPullRequest(repo, {
        fromBranch: payload.branch,
        intoBranch,
        title: payload.title,
        body: payload.body,
      });
      const prUrl = `https://github.com/${link.repoFullName}/pull/${prNumber}`;
      return result('succeeded', `Opened pull request #${prNumber} in ${link.repoFullName}.`, { ...plan, prNumber, prUrl });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      if (!sideEffectStarted) {
        return result('failed', `No side effect occurred: ${detail}`, plan, { retryAllowed: true });
      }
      return result(
        'ambiguous',
        `Execution failed after side effects began (branch "${payload.branch}" may exist in ${link.repoFullName}): ${detail}. Check the repository before retrying.`,
        plan,
        { reconciliation: 'required', retryAllowed: false },
      );
    }
  }

  /**
   * merge_pr — land a reviewed PR. All preconditions (linked repo, exact PR open+not-draft+not-merged, head SHA
   * matches the reviewed head, base branch matches, CI green) are DEFINITE pre-write gates → `blocked`, no side
   * effect. The merge itself binds `sha` to the expected head (GitHub 409s a moved head). A 4xx on the merge call
   * is a definite non-merge → `failed`; a 5xx/timeout is `ambiguous` + reconciliation required, never retried.
   * On success the merged state is verified and the merge commit SHA returned.
   */
  private async executeMerge(
    action: ExecutorAction,
    payload: MergePrPayload,
    result: ResultFn,
  ): Promise<ExecutorResult> {
    const links = await this.deps.loadLinks();
    const link = links.find((l) => l.repoFullName === payload.repo);
    if (!link) return result('blocked', `Repository "${payload.repo}" is not linked to this workspace.`, null);
    const repo: RepoRef = { installationId: link.installationId, repoFullName: link.repoFullName };
    const target = {
      operation: 'merge_pr',
      repo: payload.repo,
      prNumber: payload.prNumber,
      expectedHeadSha: payload.expectedHeadSha,
      expectedBaseBranch: payload.expectedBaseBranch,
      mergeMethod: payload.mergeMethod,
    };

    let pr;
    try {
      pr = await this.deps.client.getPullRequest(repo, payload.prNumber);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `No side effect occurred: could not read PR #${payload.prNumber}: ${detail}`, target, { retryAllowed: true });
    }
    if (pr.merged) return result('blocked', `PR #${payload.prNumber} is already merged — refusing to merge again.`, target);
    if (pr.state !== 'open') return result('blocked', `PR #${payload.prNumber} is not open (state "${pr.state}") — refusing to merge.`, target);
    if (pr.draft) return result('blocked', `PR #${payload.prNumber} is a draft — refusing to merge.`, target);
    if (pr.headSha !== payload.expectedHeadSha) {
      return result('blocked', `PR #${payload.prNumber} head has moved (expected ${payload.expectedHeadSha}, found ${pr.headSha}) — stale, refusing to merge.`, target);
    }
    if (pr.baseRef !== payload.expectedBaseBranch) {
      return result('blocked', `PR #${payload.prNumber} targets "${pr.baseRef}", not the expected "${payload.expectedBaseBranch}" — refusing to merge.`, target);
    }
    let checks;
    try {
      checks = await this.deps.client.getRefChecks(repo, pr.headSha);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `No side effect occurred: could not read CI state for ${pr.headSha}: ${detail}`, target, { retryAllowed: true });
    }
    if (checks.state !== 'success') {
      return result('blocked', `CI for PR #${payload.prNumber} is "${checks.state}", not success — refusing to merge.`, target);
    }

    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would ${payload.mergeMethod}-merge PR #${payload.prNumber} at ${payload.expectedHeadSha} into ${payload.expectedBaseBranch}.`, { ...target, wouldExecute: true });
    }

    let mergeRes: { merged: boolean; mergeCommitSha: string | null };
    try {
      mergeRes = await this.deps.client.mergePullRequest(repo, {
        prNumber: payload.prNumber,
        mergeMethod: payload.mergeMethod,
        sha: payload.expectedHeadSha,
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      if (classifyGitHubMutationError(err) === 'definite') {
        return result('failed', `GitHub rejected the merge before applying it (no side effect): ${detail}.`, target, { retryAllowed: false });
      }
      return result('ambiguous', `Merge outcome is unknown after a transport/server error — PR #${payload.prNumber} may or may not have merged: ${detail}. Reconcile before any retry.`, target, { reconciliation: 'required', retryAllowed: false });
    }
    if (!mergeRes.merged) {
      return result('ambiguous', `GitHub did not confirm the merge of PR #${payload.prNumber}. Reconcile before any retry.`, target, { reconciliation: 'required', retryAllowed: false });
    }

    // Verify merged state afterward (best effort; failure to RE-READ does not un-merge a confirmed merge).
    let verified: typeof pr | null = null;
    try {
      verified = await this.deps.client.getPullRequest(repo, payload.prNumber);
    } catch {
      verified = null;
    }
    if (verified && !verified.merged) {
      return result('ambiguous', `The merge call reported success but post-merge verification shows PR #${payload.prNumber} not merged. Reconcile before any retry.`, target, { reconciliation: 'required', retryAllowed: false });
    }
    const mergeCommitSha = mergeRes.mergeCommitSha ?? verified?.mergeCommitSha ?? null;
    return result('succeeded', `Merged PR #${payload.prNumber} into ${payload.expectedBaseBranch} via ${payload.mergeMethod}.`, {
      ...target,
      merged: true,
      prUrl: pr.url,
      mergeCommitSha,
    });
  }

  /**
   * rerun_failed_workflow — re-run the failed jobs of a completed, failed run. Preconditions (linked repo, exact
   * run, head SHA matches, attempt matches, status completed + conclusion failure) are DEFINITE pre-write gates →
   * `blocked`. The write is the dedicated rerun-failed-jobs endpoint (never workflow_dispatch). A 4xx is a
   * definite non-start → `failed`; a 5xx/timeout is `ambiguous` + reconciliation required. On GitHub's 201 accept
   * we verify the attempt advanced / the run re-entered queued|in_progress and report the new state.
   */
  private async executeRerun(
    action: ExecutorAction,
    payload: RerunFailedWorkflowPayload,
    result: ResultFn,
  ): Promise<ExecutorResult> {
    const links = await this.deps.loadLinks();
    const link = links.find((l) => l.repoFullName === payload.repo);
    if (!link) return result('blocked', `Repository "${payload.repo}" is not linked to this workspace.`, null);
    const repo: RepoRef = { installationId: link.installationId, repoFullName: link.repoFullName };
    const target = {
      operation: 'rerun_failed_workflow',
      repo: payload.repo,
      runId: payload.runId,
      expectedHeadSha: payload.expectedHeadSha,
      expectedRunAttempt: payload.expectedRunAttempt,
    };

    let run;
    try {
      run = await this.deps.client.getWorkflowRun(repo, payload.runId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `No side effect occurred: could not read workflow run ${payload.runId}: ${detail}`, target, { retryAllowed: true });
    }
    if (run.headSha !== payload.expectedHeadSha) {
      return result('blocked', `Workflow run ${payload.runId} head is ${run.headSha}, expected ${payload.expectedHeadSha} — stale, refusing to rerun.`, target);
    }
    if (run.runAttempt !== payload.expectedRunAttempt) {
      return result('blocked', `Workflow run ${payload.runId} is on attempt ${run.runAttempt}, expected ${payload.expectedRunAttempt} — stale, refusing to rerun.`, target);
    }
    if (run.status !== 'completed' || run.conclusion !== 'failure') {
      return result('blocked', `Workflow run ${payload.runId} is status "${run.status}" / conclusion "${run.conclusion ?? 'none'}" — only a completed, failed run may be rerun.`, target);
    }

    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would re-run the failed jobs of run ${payload.runId} (attempt ${payload.expectedRunAttempt}).`, { ...target, wouldExecute: true });
    }

    try {
      await this.deps.client.rerunFailedWorkflowJobs(repo, payload.runId);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      if (classifyGitHubMutationError(err) === 'definite') {
        return result('failed', `GitHub rejected the rerun (no side effect): ${detail}.`, target, { retryAllowed: false });
      }
      return result('ambiguous', `Rerun outcome is unknown after a transport/server error — the rerun of run ${payload.runId} may or may not have started: ${detail}. Reconcile before any retry.`, target, { reconciliation: 'required', retryAllowed: false });
    }

    // Verify the write took effect: a new attempt, or the run re-entered a non-terminal state.
    let after: typeof run | null = null;
    try {
      after = await this.deps.client.getWorkflowRun(repo, payload.runId);
    } catch {
      after = null;
    }
    const advanced = !!after && (after.runAttempt > payload.expectedRunAttempt || after.status === 'queued' || after.status === 'in_progress');
    return result(
      'succeeded',
      advanced
        ? `Re-ran the failed jobs of run ${payload.runId} (now attempt ${after?.runAttempt ?? payload.expectedRunAttempt}, status "${after?.status ?? 'queued'}").`
        : `GitHub accepted the re-run of the failed jobs of run ${payload.runId}.`,
      {
        ...target,
        runUrl: run.url,
        attempt: after?.runAttempt ?? payload.expectedRunAttempt,
        state: after?.status ?? 'requested',
        advanced,
      },
    );
  }

  /**
   * revert_commit — construct the exact inverse of ONE landed commit as a NEW work branch + PR back into its base.
   *
   * All pre-write analysis is DEFINITE gates → `blocked`, no side effect: linked repo; revert branch is a safe
   * non-default work branch (assessGitWrite); target has ≥1 parent (baseline = parents[0]); the base head matches
   * the expected head (stale → blocked); the target is an ancestor of the base head (unreachable → blocked). Then
   * the exact baseline→target tree delta is computed and every affected leaf path is classified against the CURRENT
   * base entry by FULL identity (path + object SHA + mode + type): equal-to-target ⇒ cleanly revertible; equal-to-
   * baseline ⇒ already reverted (skipped); anything else ⇒ conflict ⇒ blocked (no 3-way merge). Any non-blob
   * affected entry (e.g. a submodule) ⇒ blocked (unsupported in v1). All-already-baseline ⇒ no-op ⇒ blocked.
   *
   * Writes: createTree + createCommit mint content-addressed objects (no ref, no visible side effect). The FIRST
   * visible side effect is createRefAtSha (the work branch). A pre-existing revert branch ⇒ blocked (reconcile). A
   * 4xx before the ref is a definite non-start → `failed`; a 5xx/transport before the ref is `ambiguous`. Once the
   * branch exists, a PR failure is `ambiguous` + reconciliation (branch created, PR not) — never a blind retry. On
   * success the branch head, revert commit, and PR head/base are verified.
   */
  private async executeRevert(
    action: ExecutorAction,
    payload: RevertCommitPayload,
    result: ResultFn,
  ): Promise<ExecutorResult> {
    const links = await this.deps.loadLinks();
    const link = links.find((l) => l.repoFullName === payload.repo);
    if (!link) return result('blocked', `Repository "${payload.repo}" is not linked to this workspace.`, null);
    const repo: RepoRef = { installationId: link.installationId, repoFullName: link.repoFullName };
    const baseBranch = payload.expectedBaseBranch.replace(/^refs\/heads\//, '');
    const revertBranch = payload.revertBranch.replace(/^refs\/heads\//, '');
    const target = {
      operation: 'revert_commit',
      repo: payload.repo,
      targetSha: payload.targetSha,
      expectedBaseBranch: baseBranch,
      expectedBaseHeadSha: payload.expectedBaseHeadSha,
      revertBranch,
    };

    // The revert branch must be a safe NON-default work branch — same gate as create_pr (fail closed, pre-write).
    const assessment = assessGitWrite({
      actionType: 'git_pr',
      targetRepo: payload.repo,
      targetBranch: revertBranch,
      linkedRepo: link.repoFullName,
      defaultBranch: link.defaultBranch,
    });
    if (!assessment.allowed) return result('blocked', assessment.reason, target);

    // 1) Read the target commit → first-parent baseline + subject.
    let targetCommit;
    try {
      targetCommit = await this.deps.client.getCommit(repo, payload.targetSha);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `No side effect occurred: could not read target commit ${payload.targetSha}: ${detail}`, target, { retryAllowed: true });
    }
    if (targetCommit.parents.length < 1) {
      return result('blocked', `Target commit ${payload.targetSha} has no parent (a root commit cannot be reverted in v1).`, target);
    }
    const baselineSha = targetCommit.parents[0]!;

    // 2) Read the base branch head and enforce the staleness guard.
    let baseHead;
    try {
      baseHead = await this.deps.client.getCommit(repo, baseBranch);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `No side effect occurred: could not read base branch "${baseBranch}": ${detail}`, target, { retryAllowed: true });
    }
    if (baseHead.sha !== payload.expectedBaseHeadSha) {
      return result('blocked', `Base branch "${baseBranch}" head has moved (expected ${payload.expectedBaseHeadSha}, found ${baseHead.sha}) — stale, refusing to revert.`, target);
    }

    // 3) The target must be an ancestor of the base head (reachability) — else the revert is meaningless.
    let cmp;
    try {
      cmp = await this.deps.client.compareCommits(repo, payload.targetSha, baseHead.sha);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `No side effect occurred: could not compare ${payload.targetSha}...${baseHead.sha}: ${detail}`, target, { retryAllowed: true });
    }
    if (cmp.status !== 'ahead' && cmp.status !== 'identical') {
      return result('blocked', `Target commit ${payload.targetSha} is not an ancestor of "${baseBranch}" (compare status "${cmp.status}") — refusing to revert.`, target);
    }

    // 4) Read the three trees: baseline (target's first parent), target, and the current base head.
    let baselineTree, targetTree, baseTree;
    try {
      const baselineCommit = await this.deps.client.getCommit(repo, baselineSha);
      [baselineTree, targetTree, baseTree] = await Promise.all([
        this.deps.client.getFlatTree(repo, baselineCommit.treeSha),
        this.deps.client.getFlatTree(repo, targetCommit.treeSha),
        this.deps.client.getFlatTree(repo, baseHead.treeSha),
      ]);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `No side effect occurred: could not read trees to compute the revert: ${detail}`, target, { retryAllowed: true });
    }
    // A truncated tree cannot yield an exact diff — fail closed rather than reverting on partial data.
    if (baselineTree.truncated || targetTree.truncated || baseTree.truncated) {
      return result('failed', `No side effect occurred: a tree was too large for GitHub to return fully (truncated) — cannot compute an exact revert.`, target, { retryAllowed: false });
    }

    // Leaf-entry maps (blobs + submodules; directory 'tree' markers are implied by blob paths and ignored).
    const leaves = (t: { entries: readonly RepoFullTreeEntry[] }) =>
      new Map(t.entries.filter((e) => e.type !== 'tree').map((e) => [e.path, e] as const));
    const baselineMap = leaves(baselineTree);
    const targetMap = leaves(targetTree);
    const baseMap = leaves(baseTree);
    const sameEntry = (a?: RepoFullTreeEntry, b?: RepoFullTreeEntry): boolean =>
      !!a && !!b && a.sha === b.sha && a.mode === b.mode && a.type === b.type;

    // Affected = every leaf path where the baseline→target identity differs.
    const affected = new Set<string>();
    for (const path of new Set([...baselineMap.keys(), ...targetMap.keys()])) {
      if (!sameEntry(baselineMap.get(path), targetMap.get(path))) affected.add(path);
    }

    const overrides: RepoTreeOverride[] = [];
    const conflicts: string[] = [];
    const unsupported: string[] = [];
    let alreadyReverted = 0;
    for (const path of affected) {
      const baselineEntry = baselineMap.get(path);
      const targetEntry = targetMap.get(path);
      const headEntry = baseMap.get(path);
      // Unsupported in v1: any affected non-blob leaf (e.g. a submodule 'commit' entry) — BLOCK, never guess.
      if ((baselineEntry && baselineEntry.type !== 'blob') || (targetEntry && targetEntry.type !== 'blob')) {
        unsupported.push(path);
        continue;
      }
      if (sameEntry(headEntry, targetEntry) || (!headEntry && !targetEntry)) {
        // Current base still carries the target's version of this path → cleanly revert to the baseline version.
        if (baselineEntry) {
          overrides.push({ path, mode: baselineEntry.mode, type: 'blob', sha: baselineEntry.sha });
        } else {
          // Target ADDED this path; reverting removes it.
          overrides.push({ path, mode: targetEntry?.mode ?? '100644', type: 'blob', sha: null });
        }
      } else if (sameEntry(headEntry, baselineEntry) || (!headEntry && !baselineEntry)) {
        // Already at the baseline version here → nothing to do for this path.
        alreadyReverted += 1;
      } else {
        // A third state: the path diverged after the target (or in a way the revert can't express) → conflict.
        conflicts.push(path);
      }
    }

    if (unsupported.length > 0) {
      return result('blocked', `Revert of ${payload.targetSha} touches unsupported (non-file) entries not handled in v1: ${unsupported.slice(0, 10).join(', ')}. Refusing.`, target);
    }
    if (conflicts.length > 0) {
      return result('blocked', `Revert of ${payload.targetSha} conflicts with later changes on "${baseBranch}" at: ${conflicts.slice(0, 10).join(', ')}. The current base differs from both the target and the baseline — a clean revert is not possible (no 3-way merge in v1). Refusing.`, target);
    }
    if (overrides.length === 0) {
      return result('blocked', `Revert of ${payload.targetSha} is a no-op on "${baseBranch}" — every affected path is already at the pre-target version (already reverted). Refusing.`, target);
    }

    const subject = targetCommit.subject.slice(0, 120);
    const message = `Revert ${payload.targetSha}: ${subject}`.slice(0, 200);
    const prTitle = message;
    const prBody =
      `Automated revert of \`${payload.targetSha}\` (${subject || 'no subject'}).\n\n` +
      `Baseline (first parent): \`${baselineSha}\`\nBase: \`${baseBranch}\` @ \`${payload.expectedBaseHeadSha}\`\n` +
      `Restores ${overrides.length} path${overrides.length === 1 ? '' : 's'}` +
      `${alreadyReverted > 0 ? ` (${alreadyReverted} already at baseline, skipped)` : ''}.`;
    const plan = {
      ...target,
      originalTargetSha: payload.targetSha,
      baselineSha,
      affectedPaths: overrides.length,
      alreadyReverted,
      paths: overrides.map((o) => o.path).slice(0, 50),
    };

    if (action.mode === 'dry_run') {
      return result('not_executed', `Dry run only. Would open a revert pull request for ${payload.targetSha} from ${revertBranch} into ${baseBranch} (${overrides.length} path${overrides.length === 1 ? '' : 's'}).`, { ...plan, wouldExecute: true });
    }

    // Collision/idempotency guard: a pre-existing revert branch means a prior attempt may have run → reconcile.
    // Existence is checked via the Git Refs API (branchHeadSha: null == absent), NOT getCommit — GitHub's commits
    // endpoint returns 422 (not 404) for a non-existent ref, which would mis-classify every fresh revert as a
    // "could not check" failure (the exact bug the canary caught). A non-404 provider error is still fail-closed.
    let existingRevertHead: string | null;
    try {
      existingRevertHead = await this.deps.client.branchHeadSha(repo, revertBranch);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `No side effect occurred: could not check whether revert branch "${revertBranch}" exists: ${detail}`, plan, { retryAllowed: true });
    }
    if (existingRevertHead !== null) {
      return result('blocked', `Revert branch "${revertBranch}" already exists in ${link.repoFullName} (head ${existingRevertHead}) — a prior attempt may have run. Reconcile (open the PR or delete the branch) before retrying.`, plan);
    }

    // Mint the inverse tree + commit. These are content-addressed objects: no ref points at them yet, so a failure
    // here has no VISIBLE side effect (an orphan object is invisible and GC'd) → definite/failed, safe to surface.
    let revertTreeSha: string;
    let revertCommitSha: string;
    try {
      revertTreeSha = (await this.deps.client.createTree(repo, baseHead.treeSha, overrides)).treeSha;
      revertCommitSha = (await this.deps.client.createCommit(repo, { message, treeSha: revertTreeSha, parentSha: baseHead.sha })).commitSha;
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      const retry = classifyGitHubMutationError(err) !== 'definite';
      return result('failed', `No visible side effect occurred while preparing the revert objects: ${detail}`, plan, { retryAllowed: retry });
    }

    // Staleness guard AT THE WRITE BOUNDARY (TOCTOU): the base head was read before the analysis + object-minting
    // window. Re-read it immediately before the first visible write and refuse if it moved — otherwise a branch
    // built on a now-stale base could still be created. No side effect yet (the minted tree/commit are orphan
    // objects), so a move here is a clean `blocked`; an inability to re-read is a no-side-effect `failed`.
    let baseAtWrite;
    try {
      baseAtWrite = await this.deps.client.getCommit(repo, baseBranch);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('failed', `No side effect occurred: could not re-read base branch "${baseBranch}" before creating the revert branch: ${detail}`, plan, { retryAllowed: true });
    }
    if (baseAtWrite.sha !== payload.expectedBaseHeadSha) {
      return result('blocked', `Base branch "${baseBranch}" head moved to ${baseAtWrite.sha} during analysis (expected ${payload.expectedBaseHeadSha}) — stale, refusing to create the revert branch. No side effect (the prepared objects are unreferenced).`, plan);
    }

    // FIRST visible side effect: create the work branch at the exact revert commit.
    try {
      await this.deps.client.createRefAtSha(repo, revertBranch, revertCommitSha);
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      if (err instanceof GitHubApiError && err.status === 422) {
        // EVIDENCE-BASED 422 handling: a 422 from create-ref does NOT by itself mean "branch already exists" —
        // GitHub also returns 422 for other validation failures. Reconcile with a read-only refs lookup and decide
        // from the ACTUAL state, never from the status code alone. Never auto-retried in any branch.
        let afterHead: string | null;
        try {
          afterHead = await this.deps.client.branchHeadSha(repo, revertBranch);
        } catch (reErr) {
          const rd = reErr instanceof Error ? reErr.message : 'unknown error';
          return result('ambiguous', `Creating the revert branch "${revertBranch}" returned 422 and the follow-up existence check failed (${rd}) — state unknown. Reconcile before any retry.`, plan, { reconciliation: 'required', retryAllowed: false });
        }
        if (afterHead === null) {
          // Branch still absent → the 422 was a definite provider validation failure with no side effect.
          return result('failed', `GitHub rejected creating the revert branch with HTTP 422 and no branch exists afterward — a definite validation failure, no side effect: ${detail}.`, plan, { retryAllowed: false });
        }
        if (afterHead === revertCommitSha) {
          // Branch exists at OUR intended commit → the ref may have been created by this attempt (422 despite a
          // partial write) → ambiguous/partial, reconcile. Not a clean retry, not blindly blocked.
          return result('ambiguous', `The revert branch "${revertBranch}" returned 422 but now exists at the intended revert commit ${revertCommitSha} — it may have been created by this attempt. Reconcile (open the PR or delete the branch) before any retry.`, { ...plan, revertCommitSha }, { reconciliation: 'required', retryAllowed: false });
        }
        // Branch exists at a DIFFERENT commit → a pre-existing/foreign branch collided; our call made no change.
        return result('blocked', `The revert branch "${revertBranch}" already exists at a different commit ${afterHead} (not the intended ${revertCommitSha}) — collision; our write made no change. Reconcile (choose a new revert branch or delete the stale one) before any retry.`, { ...plan, revertCommitSha });
      }
      if (classifyGitHubMutationError(err) === 'definite') {
        return result('failed', `GitHub rejected creating the revert branch (no side effect): ${detail}.`, plan, { retryAllowed: false });
      }
      return result('ambiguous', `Creating the revert branch "${revertBranch}" failed after a transport/server error — it may or may not exist: ${detail}. Reconcile before any retry.`, plan, { reconciliation: 'required', retryAllowed: false });
    }

    // The branch now exists: any failure past here is a PARTIAL outcome (branch created, PR not) → ambiguous.
    let prNumber: number;
    try {
      prNumber = (await this.deps.client.openPullRequest(repo, { fromBranch: revertBranch, intoBranch: baseBranch, title: prTitle, body: prBody })).prNumber;
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('ambiguous', `The revert branch "${revertBranch}" was created in ${link.repoFullName} but opening the pull request failed: ${detail}. Reconcile (open the PR manually or delete the branch) before any retry.`, plan, { reconciliation: 'required', retryAllowed: false });
    }
    const prUrl = `https://github.com/${link.repoFullName}/pull/${prNumber}`;

    // Fail-closed post-action verification. A visible branch + PR now exist, so any mismatch ⇒ ambiguous +
    // reconciliation (never a silent success, never a retry): the branch head AND the PR's own bound head SHA must
    // equal the revert commit (not just headRef), and the PR head/base refs must match. Also re-read the base: if
    // it moved during the operation, a branch/PR now exists against a changed base → reconcile.
    try {
      const headAfter = await this.deps.client.getCommit(repo, revertBranch);
      const pr = await this.deps.client.getPullRequest(repo, prNumber);
      const baseAfter = await this.deps.client.getCommit(repo, baseBranch);
      if (baseAfter.sha !== payload.expectedBaseHeadSha) {
        return result('ambiguous', `The revert PR #${prNumber} was created, but base branch "${baseBranch}" moved to ${baseAfter.sha} during the operation (expected ${payload.expectedBaseHeadSha}). A branch/PR now exists against a changed base — reconcile before any retry.`, { ...plan, prNumber, prUrl, revertCommitSha }, { reconciliation: 'required', retryAllowed: false });
      }
      const ok = headAfter.sha === revertCommitSha && pr.headSha === revertCommitSha && pr.headRef === revertBranch && pr.baseRef === baseBranch;
      if (!ok) {
        return result('ambiguous', `The revert PR #${prNumber} was created but post-action verification did not match (branch head ${headAfter.sha} / PR head ${pr.headSha} vs ${revertCommitSha}; PR ${pr.headRef}→${pr.baseRef}). Reconcile before any retry.`, { ...plan, prNumber, prUrl, revertCommitSha }, { reconciliation: 'required', retryAllowed: false });
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown error';
      return result('ambiguous', `The revert PR #${prNumber} was created but could not be verified afterward: ${detail}. Reconcile before any retry.`, { ...plan, prNumber, prUrl, revertCommitSha }, { reconciliation: 'required', retryAllowed: false });
    }

    return result('succeeded', `Opened revert pull request #${prNumber} in ${link.repoFullName} for ${payload.targetSha}.`, {
      ...plan,
      prNumber,
      prUrl,
      revertCommitSha,
    });
  }

  private provenance(action: ExecutorAction, attemptedAt: string): Readonly<ExecutorProvenance> {
    return Object.freeze({
      contractVersion: '1' as const,
      executorId: this.capability.executorId,
      executorVersion: GIT_PR_EXECUTOR_VERSION,
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
