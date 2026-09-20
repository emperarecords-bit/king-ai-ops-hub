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
// Shared contract shapes live in the neutral `types` floor so the DB schema can type its columns
// with them without importing domain. Re-exported here so domain-side imports are unchanged.
import type {
  ArtifactAvailability,
  CheckResult,
  CheckStatus,
  RejectionCode,
  SubmittedArtifact,
} from '@/types/verification';
export type {
  ArtifactAvailability,
  ArtifactAvailabilityState,
  CheckResult,
  CheckStatus,
  RejectionCode,
  SubmittedArtifact,
} from '@/types/verification';

/** Where evidence came from. Only authenticated sources are admissible. */
export type EvidenceSource = 'local_runner' | 'github_actions';

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

/**
 * A validated, normalized request to CREATE a contract. org/project/creator are supplied separately
 * from the authenticated tenant context — never from here — so a caller can never bind a contract to
 * another tenant. `commitSha` is a full 40-hex SHA; the lists are de-duplicated and trimmed.
 */
export interface NewVerificationRequest {
  readonly taskId: string;
  readonly repoFullName: string;
  readonly commitSha: string;
  readonly requiredChecks: readonly string[];
  readonly requiredArtifacts: readonly string[];
  readonly allowDirty: boolean;
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
  /** Which signing-key version produced `signature`. Absent ⇒ treated as the original 'v1' so
   *  envelopes signed before this field existed keep verifying; an unsupported version is rejected. */
  readonly signingKeyVersion?: string;
}

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
