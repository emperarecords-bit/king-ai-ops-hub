/**
 * The Hub's verification wire contract, as consumed by an external runner.
 *
 * These are structural mirrors of the Hub's `src/domain/verification/ingest-types.ts` and
 * `ports.ts`. A runner is an independent program on the other side of an HTTP boundary, so it
 * restates the contract instead of importing it; drift is caught by the parity tests in
 * `tests/unit/verification-runner-*.test.ts`, which type-check these shapes against the Hub's own.
 *
 * What a runner may and may NOT do (design §1) is encoded here by OMISSION: there is no type for
 * creating or amending a contract, because a runner credential cannot do either. The only shapes
 * are "read a contract", "ask for an upload grant", and "submit signed evidence".
 */

/** A check result as executed by the harness. `command` must equal the pinned catalog entry. */
export interface CheckResult {
  readonly name: string;
  readonly status: 'passed' | 'failed' | 'skipped' | 'errored';
  readonly command: string;
  /** Authoritative exit code, captured by the harness parent process — never self-reported. */
  readonly exitCode: number | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly outputDigest: string | null;
}

export interface SubmittedArtifact {
  readonly logicalPath: string;
  readonly storageKey: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

/** The contract the Hub hands a runner. Requirements are READ from here, never authored. */
export interface VerificationContract {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly repoFullName: string;
  readonly expectedCommitSha: string;
  readonly requiredChecks: readonly string[];
  readonly requiredArtifacts: readonly string[];
  readonly catalogVersion: string;
  readonly catalogDigest: string;
}

/** The signed payload. Field names and order-independence must match the Hub byte-for-byte. */
export interface EvidenceSubmission {
  readonly requestId: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly repoFullName: string;
  readonly commitSha: string;
  readonly dirty: boolean;
  readonly uncommittedChangesDigest: string | null;
  readonly runnerId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly environment: string;
  readonly source: 'local_runner' | 'github_actions';
  readonly checks: readonly CheckResult[];
  readonly artifacts: readonly SubmittedArtifact[];
  readonly catalogVersion: string;
  readonly catalogDigest: string;
  readonly idempotencyKey: string;
  readonly submittedAt: string;
}

export interface SignedEnvelope {
  readonly runnerId: string;
  readonly payload: EvidenceSubmission;
  readonly signature: string;
  readonly signingKeyVersion?: string;
}

/** The Hub's response to a grant request (`grantView` in the uploads route). */
export interface UploadGrantView {
  readonly grantId: string;
  readonly objectKey: string;
  readonly logicalPath: string;
  readonly attemptId: string;
  readonly declaredSize: number;
  readonly declaredSha256: string;
  readonly contentType: string;
  readonly expiresAt: string;
  /** Hub-relative path the bytes are PUT to. The Hub proxies and enforces; see README. */
  readonly uploadPath: string;
}
