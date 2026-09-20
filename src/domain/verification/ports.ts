/**
 * Ports (VER-002). The ingestion orchestrator depends only on these interfaces,
 * so it is testable with in-memory adapters and wired to Drizzle + the object
 * store in production without any change to the logic.
 */
import type { EvidenceSubmission, IngestDecision, VerificationRequest } from './ingest-types';

/** Retrieval + head for a stored artifact, so the Hub can confirm availability and rehash. */
export interface StoredArtifactStore {
  head(storageKey: string): Promise<{ sizeBytes: number; expired: boolean } | null>;
  get(storageKey: string): Promise<Buffer | null>;
}

/** Supplies a project's runner HMAC secret (from the encrypted integration_secrets store). */
export interface RunnerSecretSource {
  getRunnerSecret(orgId: string, projectId: string): Promise<string | null>;
}

/** Persistence for contracts + idempotent evidence decisions. */
export interface VerificationStore {
  getRequest(orgId: string, projectId: string, requestId: string): Promise<VerificationRequest | null>;
  /** Prior decision for this idempotency key, if any (replay safety). */
  findDecisionByIdempotencyKey(orgId: string, projectId: string, key: string): Promise<IngestDecision | null>;
  /** Persist the submission + its decision atomically; returns the stored decision. */
  saveEvidence(
    orgId: string,
    projectId: string,
    submission: EvidenceSubmission,
    decision: IngestDecision,
  ): Promise<IngestDecision>;
}

export interface IngestDeps {
  readonly store: VerificationStore;
  readonly artifacts: StoredArtifactStore;
  readonly secrets: RunnerSecretSource;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** Max age of a submission's signed timestamp before it is rejected as expired (default 10 min). */
  readonly maxSubmissionAgeMs?: number;
}
