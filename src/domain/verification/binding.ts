/**
 * Bind evidence to the work (VER-002).
 *
 * Evidence is only admissible if it is for the RIGHT tenant, project, repository,
 * task, and the EXACT code version the contract pins. Stale-commit evidence
 * cannot verify newer code. A dirty working tree is recorded and — unless the
 * contract explicitly allows it — cannot stand in for the committed SHA.
 */
import type { EvidenceSubmission, RejectionCode, VerificationRequest } from './ingest-types';

export interface TenantContext {
  readonly orgId: string;
  readonly projectId: string;
}

export interface BindingResult {
  readonly ok: boolean;
  readonly rejection: { readonly code: RejectionCode; readonly message: string } | null;
}

export function validateBinding(
  request: VerificationRequest,
  submission: EvidenceSubmission,
  ctx: TenantContext,
): BindingResult {
  const reject = (code: RejectionCode, message: string): BindingResult => ({ ok: false, rejection: { code, message } });

  // Tenant/project must match BOTH the caller context and the contract.
  if (submission.orgId !== ctx.orgId || request.orgId !== ctx.orgId) {
    return reject('wrong_tenant', `Evidence org ${submission.orgId} does not match ${ctx.orgId}.`);
  }
  if (submission.projectId !== ctx.projectId || request.projectId !== ctx.projectId) {
    return reject('wrong_project', `Evidence project ${submission.projectId} does not match ${ctx.projectId}.`);
  }
  if (submission.taskId !== request.taskId) {
    return reject('wrong_task', `Evidence task ${submission.taskId} does not match request task ${request.taskId}.`);
  }
  if (submission.repoFullName !== request.repoFullName) {
    return reject('wrong_repo', `Evidence repo ${submission.repoFullName} does not match ${request.repoFullName}.`);
  }
  // Stale/wrong code version: the contract pins exactly one commit.
  if (submission.commitSha !== request.expectedCommitSha) {
    return reject(
      'stale_commit',
      `Evidence commit ${submission.commitSha} does not match the reviewed commit ${request.expectedCommitSha}.`,
    );
  }
  // Initial integration: a dirty working tree is ALWAYS rejected. A commit SHA
  // does not identify a dirty tree, and git-status text is not a content identity.
  // (Verifying dirty work will require binding to a real content snapshot/digest;
  // `allowDirty` is reserved for that and is intentionally not honored yet.)
  if (submission.dirty) {
    return reject('dirty_tree', 'Working tree was dirty; only committed code can be verified in this integration.');
  }
  return { ok: true, rejection: null };
}
