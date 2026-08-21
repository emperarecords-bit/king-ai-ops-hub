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
