/**
 * External-runner evidence ingestion (VER-002) — types.
 *
 * Option A: the Hub never runs commands. A trusted external runner (a signed
 * local runner today; a CI provider later) submits an evidence bundle, and the
 * Hub binds it to the work, checks the required checks, verifies artifact
 * availability, and adjudicates — idempotently. Agent prose is never accepted:
 * the only ingress is a signed submission.
 */
import type { TaskVerificationStatus } from './types';

/** Where evidence came from. Only authenticated sources are admissible. */
export type EvidenceSource = 'local_runner' | 'github_actions';

/** Result of one named required check within a run. */
export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'cancelled' | 'errored' | 'missing';

export interface CheckResult {
  readonly name: string;
  readonly status: CheckStatus;
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly detail: string | null;
}

/** An artifact the runner claims it produced and stored. */
export interface SubmittedArtifact {
  readonly path: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  /** Where the runner stored it (object-store key / URL the Hub can retrieve). */
  readonly storageKey: string;
}

export type ArtifactAvailabilityState = 'available' | 'unavailable' | 'hash_mismatch' | 'expired' | 'forbidden';

export interface ArtifactAvailability {
  readonly path: string;
  readonly storageKey: string;
  readonly state: ArtifactAvailabilityState;
  readonly recordedSha256: string;
  readonly observedSha256: string | null;
  readonly detail: string;
}

/**
 * The verification CONTRACT, created BEFORE any results are received. It pins the
 * exact code version and the full set of required checks, so "exit 0 from one
 * command" can never masquerade as verification.
 */
export interface VerificationRequest {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly repoFullName: string;
  /** The exact commit this contract will verify. Stale-commit evidence is rejected. */
  readonly expectedCommitSha: string;
  /** Every check that must PASS. Declared up front, before results. */
  readonly requiredChecks: readonly string[];
  /** Artifact paths that MUST be present and available. Declared before execution;
   *  an empty submitted list can never bypass these. */
  readonly requiredArtifacts: readonly string[];
  /** Reserved. Dirty working trees are rejected in this initial integration
   *  regardless of this flag (a future release may bind to a real content snapshot). */
  readonly allowDirty: boolean;
  readonly createdBy: string;
  readonly createdAt: string;
}

/** The signed bundle a runner submits. */
export interface EvidenceSubmission {
  readonly requestId: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly repoFullName: string;
  readonly commitSha: string;
  /** True when the runner's working tree had uncommitted changes at run time. */
  readonly dirty: boolean;
  /** Digest of `git status --porcelain` when dirty; a SHA alone cannot identify a dirty tree. */
  readonly uncommittedChangesDigest: string | null;
  readonly runnerId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly environment: string;
  readonly source: EvidenceSource;
  readonly checks: readonly CheckResult[];
  readonly artifacts: readonly SubmittedArtifact[];
  /** Replay/duplicate guard — same key must never change the result. */
  readonly idempotencyKey: string;
  readonly submittedAt: string;
}

/** The signed envelope actually posted to the ingestion endpoint. */
export interface SignedEnvelope {
  readonly runnerId: string;
  readonly payload: EvidenceSubmission;
  /** HMAC-SHA256 (hex) of the canonical payload under the project's runner secret. */
  readonly signature: string;
}

export type RejectionCode =
  | 'unknown_request'
  | 'unauthenticated'
  | 'expired'
  | 'wrong_tenant'
  | 'wrong_project'
  | 'wrong_repo'
  | 'wrong_task'
  | 'stale_commit'
  | 'dirty_tree'
  | 'invalid_checks'
  | 'idempotency_conflict';

export interface CheckEvaluation {
  readonly allRequiredPassed: boolean;
  readonly byCheck: readonly { readonly name: string; readonly status: CheckStatus }[];
  readonly failing: readonly { readonly name: string; readonly status: CheckStatus }[];
  /** Structural problems that make the submission invalid: duplicate check names,
   *  contradictory status/exit, or missing execution metadata. Non-empty ⇒ reject. */
  readonly problems: readonly string[];
  /** Scope statement — reflects the ACTUAL outcome; never describes a failure as passed. */
  readonly scope: string;
}

/** The persisted, idempotent outcome of ingesting one submission. */
export interface IngestDecision {
  readonly accepted: boolean;
  readonly rejection: { readonly code: RejectionCode; readonly message: string } | null;
  readonly status: TaskVerificationStatus;
  readonly deliverable: boolean;
  readonly idempotencyKey: string;
  readonly checkEvaluation: CheckEvaluation | null;
  readonly artifactAvailability: readonly ArtifactAvailability[];
  readonly reasons: readonly string[];
  readonly decidedAt: string;
  /** True when this decision was returned from a prior submission (replay). */
  readonly replayed: boolean;
}
