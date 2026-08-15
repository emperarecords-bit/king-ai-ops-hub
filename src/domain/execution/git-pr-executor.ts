import { z } from 'zod';
import { sha256Hex } from '@/lib/crypto';
import { canonicalJson } from '@/orchestration/actions';
import { type GitHubRepoClient, type RepoRef } from '@/domain/github/client';
import { GitHubApiError } from '@/domain/github/live-client';
import { assessGitWrite } from '@/domain/github/write-policy';
import {
  type Executor,
  type ExecutorAction,
  type ExecutorCapability,
  type ExecutorProvenance,
  type ExecutorResult,
} from './executor-contract';

export const GIT_PR_EXECUTOR_ID = 'git_pr';
export const GIT_PR_EXECUTOR_VERSION = '1';

/**
 * The canonical git_pr payload an agent must propose for the action to be executable. Anything the
 * model emits is hostile until it survives this parse — extra keys, wrong shapes, and oversized
 * content are all refusals, never best-effort repairs.
 */
export const gitPrPayloadSchema = z.object({
  /** Canonical `owner/repo`; must be a repository linked to this workspace. */
  repo: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/),
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

export type GitPrPayload = z.infer<typeof gitPrPayloadSchema>;

export interface GitPrRepoLink {
  readonly installationId: bigint;
  readonly repoFullName: string;
  readonly defaultBranch: string;
}

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
 * with reconciliation required, never silently retried.
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
