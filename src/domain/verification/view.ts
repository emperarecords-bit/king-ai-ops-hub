/**
 * Verification view-model (VER-002, Priority 6).
 *
 * The exact data the task/approval UI must show: repository/access status,
 * evidence source, reviewed commit, required checks + their results, the
 * verification result, and remaining blockers. Pure — the React page renders
 * this object; it invents nothing.
 */
import type { RepoAccess } from './types';
import type { IngestDecision, VerificationRequest } from './ingest-types';

export interface VerificationView {
  readonly repository: {
    readonly connection: RepoAccess['connection'];
    readonly repoFullName: string | null;
    readonly branch: string | null;
    readonly commitSha: string | null;
    readonly lastCheckedAt: string | null;
    readonly missingConnection: string | null;
  };
  readonly evidenceSource: string | null;
  readonly reviewedCommit: string | null;
  readonly requiredChecks: readonly { readonly name: string; readonly status: string }[];
  readonly verification: {
    readonly status: IngestDecision['status'] | 'not_requested';
    readonly deliverable: boolean;
    readonly decidedAt: string | null;
    readonly scannerLimitation: string;
  };
  readonly remainingBlockers: readonly string[];
}

const SCANNER_LIMITATION =
  'Secret scanning is pattern-based: omissions and matches are recorded, but a clean scan is not proof that no secrets exist.';

export function buildVerificationView(
  access: RepoAccess,
  request: VerificationRequest | null,
  decision: IngestDecision | null,
): VerificationView {
  const blockers: string[] = [];
  if (access.connection !== 'connected' && access.missingConnection) blockers.push(access.missingConnection);
  if (!request) blockers.push('No verification contract has been created for this task.');

  // Required checks + their latest observed status, if evidence has arrived.
  const byCheck = new Map((decision?.checkEvaluation?.byCheck ?? []).map((c) => [c.name, c.status]));
  const requiredChecks = (request?.requiredChecks ?? []).map((name) => ({
    name,
    status: byCheck.get(name) ?? (decision ? 'missing' : 'pending'),
  }));

  if (decision && decision.status !== 'verified_complete') {
    blockers.push(...decision.reasons.filter((r) => !r.startsWith('Scope:')));
  }
  if (decision?.artifactAvailability?.some((a) => a.state !== 'available')) {
    for (const a of decision.artifactAvailability.filter((a) => a.state !== 'available')) {
      blockers.push(`Artifact ${a.path}: ${a.state} (${a.detail})`);
    }
  }

  return {
    repository: {
      connection: access.connection,
      repoFullName: access.repoFullName,
      branch: access.branch,
      commitSha: access.commitSha,
      lastCheckedAt: access.lastCheckedAt,
      missingConnection: access.missingConnection,
    },
    evidenceSource: decision ? 'local_runner' : request ? 'awaiting submission' : null,
    reviewedCommit: request?.expectedCommitSha ?? null,
    requiredChecks,
    verification: {
      status: decision ? decision.status : 'not_requested',
      deliverable: decision?.deliverable ?? false,
      decidedAt: decision?.decidedAt ?? null,
      scannerLimitation: SCANNER_LIMITATION,
    },
    remainingBlockers: [...new Set(blockers)],
  };
}
