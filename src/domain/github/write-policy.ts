import { type ActionType } from '@/types/domain';

/**
 * The branch + PR-only write policy (Phase 6, ROADMAP: "Write: branch + PR only, never direct push to a default
 * branch"). PURE and fail-closed: given a proposed git action and the project's linked-repo facts, it returns an
 * explicit allow/deny with a stable reason. It is evaluated at execution-PLANNING time, not only at proposal
 * time — so even a human-approved payload cannot reach a default branch: approval authorizes intent, this policy
 * bounds mechanism.
 *
 * Nothing in this phase executes git actions at all (they are proposals in the approvals queue); this policy is
 * the contract any future executor MUST consult before acting, and it is pinned by tests.
 */

export interface GitWriteAssessmentInput {
  /** The proposed action type (from the closed ACTION_TYPES set). */
  readonly actionType: ActionType | string;
  /** Repository the action names, canonical `owner/repo`. */
  readonly targetRepo: unknown;
  /** Branch the action writes to (for git_pr: the PR's SOURCE branch). */
  readonly targetBranch: unknown;
  /** The project's linked repository (github_repo_links.repo_full_name). */
  readonly linkedRepo: string;
  /** The linked repository's default branch (github_repo_links.default_branch). */
  readonly defaultBranch: string;
}

export interface GitWriteAssessment {
  readonly allowed: boolean;
  readonly decision: 'allow' | 'deny';
  readonly reason: string;
}

const GIT_WRITE_ACTIONS: ReadonlySet<string> = new Set(['git_commit', 'git_push', 'git_pr']);
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

function deny(reason: string): GitWriteAssessment {
  return { allowed: false, decision: 'deny', reason };
}

/** Normalize a branch spec so `refs/heads/main` and `main` compare equal. */
function normalizeBranch(branch: string): string {
  return branch.replace(/^refs\/heads\//, '');
}

export function assessGitWrite(input: GitWriteAssessmentInput): GitWriteAssessment {
  if (!GIT_WRITE_ACTIONS.has(String(input.actionType))) {
    return deny(`action "${String(input.actionType)}" is not a git write action`);
  }
  if (typeof input.targetRepo !== 'string' || input.targetRepo.length === 0) {
    return deny('target repository is missing or malformed');
  }
  if (input.targetRepo !== input.linkedRepo) {
    return deny(`target repository "${input.targetRepo}" is not the project's linked repository`);
  }
  if (typeof input.targetBranch !== 'string' || input.targetBranch.length === 0) {
    return deny('target branch is missing or malformed');
  }
  const branch = normalizeBranch(input.targetBranch);
  if (!BRANCH_RE.test(branch) || branch.includes('..') || branch.endsWith('/') || branch.endsWith('.lock')) {
    return deny(`target branch "${input.targetBranch}" is not a valid branch name`);
  }
  if (branch === 'HEAD') {
    return deny('HEAD is not a writable target');
  }
  const defaultBranch = normalizeBranch(input.defaultBranch);
  if (branch === defaultBranch) {
    return deny(`writes to the default branch "${defaultBranch}" are never permitted — open a pull request from a work branch instead`);
  }
  // main/master are denied even when a repo link (mis)declares a different default: belt for a stale or
  // tampered default_branch value. A legitimate work branch never carries these exact names.
  if (branch === 'main' || branch === 'master') {
    return deny(`writes to "${branch}" are never permitted — open a pull request from a work branch instead`);
  }
  return { allowed: true, decision: 'allow', reason: `git write to work branch "${branch}" of the linked repository is permitted; merging into "${defaultBranch}" still requires a pull request` };
}
