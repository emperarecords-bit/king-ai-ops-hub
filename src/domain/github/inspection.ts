import 'server-only';
import { type DbTx } from '@/db/client';
import { type TenantContext } from '@/types/domain';
import { listRepoLinks } from './links';
import {
  isGitHubConfigured,
  type GitHubRepoClient,
  type PullRequestSummary,
  type RefCheckStatus,
  type RepoRef,
} from './client';
import { hasEligibleExecutor } from '@/domain/execution/executors';
import { EXECUTOR_RISK_BY_ACTION } from '@/domain/execution/executor-policy';
import { resolveDispatchPolicyFromEnv, type DispatchPolicy } from '@/domain/execution/dispatch';
import { GIT_PR_EXECUTOR_ID } from '@/domain/execution/git-pr-executor';

/**
 * Read-only GitHub inspection for the Ops Chat bridge (Phase 2A). Every function here is a pure read:
 * it resolves the workspace's linked repositories (server-side, RLS-scoped) and calls the read methods
 * of the policy-gated GitHub client. The GitHub App installation id NEVER leaves this layer — it is held
 * only inside the internal `RepoRef` passed to the client; the returned DTOs carry repo content + CI state
 * only, so nothing secret can reach the model context, a proposal card, or an audit detail.
 */

export class RepoNotLinkedError extends Error {
  constructor(repoFullName: string) {
    super(`Repository "${repoFullName}" is not linked to this workspace.`);
    this.name = 'RepoNotLinkedError';
  }
}

export interface LinkedRepoView {
  readonly repoFullName: string;
  readonly defaultBranch: string;
}

export interface WorkspaceGithubCapabilities {
  /** App credentials present in the environment (fail-closed when false). */
  readonly githubConfigured: boolean;
  readonly gitPr: {
    readonly actionType: 'git_pr';
    readonly riskClass: string;
    /** A registered executor exists for the action type (static capability). */
    readonly executorRegistered: boolean;
    /** The server kill-switch currently enables the executor (EXECUTORS_ENABLED). */
    readonly executorEnabled: boolean;
    readonly confirmationRequired: true;
  };
  readonly linkedRepos: readonly LinkedRepoView[];
  /** Ops Chat can prepare a create-PR proposal: a registered executor AND at least one linked repo. */
  readonly canProposePr: boolean;
}

/** What governed GitHub actions this workspace can do right now. Pure read. */
export async function githubWorkspaceCapabilities(
  tx: DbTx,
  ctx: TenantContext,
  policy: DispatchPolicy = resolveDispatchPolicyFromEnv(),
): Promise<WorkspaceGithubCapabilities> {
  const links = await listRepoLinks(tx, ctx);
  const linkedRepos: LinkedRepoView[] = links.map((l) => ({ repoFullName: l.repoFullName, defaultBranch: l.defaultBranch }));
  const executorRegistered = hasEligibleExecutor('git_pr');
  const executorEnabled = (policy.enabledExecutorIds ?? []).includes(GIT_PR_EXECUTOR_ID);
  return {
    githubConfigured: isGitHubConfigured(),
    gitPr: {
      actionType: 'git_pr',
      riskClass: EXECUTOR_RISK_BY_ACTION.git_pr,
      executorRegistered,
      executorEnabled,
      confirmationRequired: true,
    },
    linkedRepos,
    canProposePr: executorRegistered && linkedRepos.length > 0,
  };
}

/** The workspace's linked repositories as safe DTOs (no installation id). Pure read. */
export async function listWorkspaceRepos(tx: DbTx, ctx: TenantContext): Promise<LinkedRepoView[]> {
  const links = await listRepoLinks(tx, ctx);
  return links.map((l) => ({ repoFullName: l.repoFullName, defaultBranch: l.defaultBranch }));
}

/** Resolve a linked repo to the trusted RepoRef (installation id held server-side). Null if not linked. */
async function resolveLinkedRepoRef(tx: DbTx, ctx: TenantContext, repoFullName: string): Promise<RepoRef | null> {
  const links = await listRepoLinks(tx, ctx);
  const link = links.find((l) => l.repoFullName === repoFullName);
  return link ? { installationId: link.installationId, repoFullName: link.repoFullName } : null;
}

export async function listWorkspacePullRequests(
  tx: DbTx,
  ctx: TenantContext,
  client: GitHubRepoClient,
  repoFullName: string,
  opts?: { state?: 'open' | 'closed' | 'all' },
): Promise<PullRequestSummary[]> {
  const ref = await resolveLinkedRepoRef(tx, ctx, repoFullName);
  if (!ref) throw new RepoNotLinkedError(repoFullName);
  return client.listPullRequests(ref, opts);
}

export async function getWorkspacePullRequest(
  tx: DbTx,
  ctx: TenantContext,
  client: GitHubRepoClient,
  repoFullName: string,
  prNumber: number,
): Promise<{ pr: PullRequestSummary; checks: RefCheckStatus }> {
  const ref = await resolveLinkedRepoRef(tx, ctx, repoFullName);
  if (!ref) throw new RepoNotLinkedError(repoFullName);
  const pr = await client.getPullRequest(ref, prNumber);
  const checks = await client.getRefChecks(ref, pr.headSha || pr.headRef);
  return { pr, checks };
}
