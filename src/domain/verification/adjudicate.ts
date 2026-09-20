/**
 * Evidence-backed task status adjudication (Priority 2).
 *
 * The single function that decides a task's verification status from FACTS, not
 * from an agent's claim. Its guarantees:
 *  - A summary alone is never `verified_complete` — evidence must be a real
 *    `trusted_runner` execution record.
 *  - A failing exit code can never be `verified_complete` (→ verification_failed).
 *  - A missing promised artifact can never be a delivery (→ verification_failed,
 *    deliverable=false), even when the command exited 0.
 *  - Missing access is reported as `blocked_missing_access`, never silently.
 */
import type { ExecutionEvidence, RepoAccess, TaskVerificationStatus } from './types';

export interface AdjudicationInput {
  /** Did the agent produce a draft deliverable? */
  readonly hasDraft: boolean;
  /** Does verifying this task require actually running something (a test/build)? */
  readonly requiresExecution: boolean;
  readonly access: RepoAccess;
  /** The execution evidence, if a verification run has been recorded. */
  readonly evidence: ExecutionEvidence | null;
  /** Logical artifact paths that MUST exist to claim delivery. */
  readonly requiredArtifacts: readonly string[];
}

export interface Adjudication {
  readonly status: TaskVerificationStatus;
  /** May we claim this task delivered its result? True only for verified_complete. */
  readonly deliverable: boolean;
  readonly reasons: readonly string[];
}

/** Only a real trusted-runner record counts as evidence. Prose is not. */
export function isAdmissibleEvidence(e: ExecutionEvidence | null): boolean {
  return !!e && e.kind === 'command' && e.producedBy === 'trusted_runner';
}

export function adjudicate(input: AdjudicationInput): Adjudication {
  const reasons: string[] = [];

  if (!input.hasDraft) {
    return { status: 'draft_complete', deliverable: false, reasons: ['No draft has been produced yet.'] };
  }

  // A non-executable task (pure document/answer) tops out at draft_complete here;
  // delivery of such work is gated elsewhere (e.g. objective criteria), not by execution.
  if (!input.requiresExecution) {
    return {
      status: 'draft_complete',
      deliverable: false,
      reasons: ['Draft complete; this task needs no execution verification.'],
    };
  }

  // Reject any non-admissible "evidence" (e.g. an agent summary masquerading as a result).
  if (input.evidence && input.evidence.producedBy !== 'trusted_runner') {
    reasons.push(
      `Evidence rejected: producedBy='${input.evidence.producedBy}'. An agent summary is not execution evidence.`,
    );
  }
  const evidence =
    input.evidence && input.evidence.kind === 'command' && input.evidence.producedBy === 'trusted_runner'
      ? input.evidence
      : null;

  // No admissible evidence yet → depends on access.
  if (!evidence) {
    if (input.access.connection !== 'connected') {
      return {
        status: 'blocked_missing_access',
        deliverable: false,
        reasons: [
          input.access.missingConnection ?? 'Repository access is not connected.',
          ...reasons,
        ],
      };
    }
    return {
      status: 'ready_for_verification',
      deliverable: false,
      reasons: ['Draft complete and access is connected; awaiting a verification run.', ...reasons],
    };
  }

  // We have real evidence. A non-zero exit can never be verified_complete.
  if (evidence.exitCode !== 0) {
    return {
      status: 'verification_failed',
      deliverable: false,
      reasons: [`Verification command exited ${evidence.exitCode} (command: ${evidence.command}).`, ...reasons],
    };
  }

  // Exit 0 — but every promised artifact must actually exist before we claim delivery.
  const present = new Map(evidence.artifacts.map((a) => [a.path, a]));
  const missing = input.requiredArtifacts.filter((p) => {
    const a = present.get(p);
    return !a || !a.present || !a.sha256;
  });
  if (missing.length > 0) {
    return {
      status: 'verification_failed',
      deliverable: false,
      reasons: [
        `Command passed (exit 0) but required artifact(s) not produced: ${missing.join(', ')}. Delivery cannot be claimed.`,
        ...reasons,
      ],
    };
  }

  return {
    status: 'verified_complete',
    deliverable: true,
    reasons: [
      `Verified: '${evidence.command}' exited 0 at ${evidence.finishedAt}; ${input.requiredArtifacts.length} artifact(s) confirmed present.`,
      ...reasons,
    ],
  };
}
