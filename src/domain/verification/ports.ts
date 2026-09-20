/**
 * Ports (VER-002). The ingestion orchestrator depends only on these interfaces,
 * so it is testable with in-memory adapters and wired to Drizzle + the object
 * store in production without any change to the logic.
 */
import type { EvidenceSubmission, IngestDecision, NewVerificationRequest, VerificationRequest } from './ingest-types';

/** Retrieval + head for a stored artifact, so the Hub can confirm availability and rehash. */
export interface StoredArtifactStore {
  head(storageKey: string): Promise<{ sizeBytes: number; expired: boolean } | null>;
  get(storageKey: string): Promise<Buffer | null>;
}

/** Supplies a project's runner HMAC secret (from the encrypted integration_secrets store). */
export interface RunnerSecretSource {
  getRunnerSecret(orgId: string, projectId: string): Promise<string | null>;
}

/** A prior submission recorded under an idempotency key, with its content digest. */
export interface PriorEvidence {
  readonly decision: IngestDecision;
  /** Canonical digest of the ORIGINAL submission — identical retries match it. */
  readonly submissionSha256: string;
}

/** Persistence for contracts + idempotent evidence decisions. */
export interface VerificationStore {
  getRequest(orgId: string, projectId: string, requestId: string): Promise<VerificationRequest | null>;
  /** True iff `taskId` exists in THIS tenant (org, project) — RLS-scoped, so a task id from another
   *  project is invisible and reads as absent. Used to bind a contract to a real, in-project task. */
  taskExistsInTenant(orgId: string, projectId: string, taskId: string): Promise<boolean>;
  /** The existing contract for the natural key (org, project, task, commit), if any. */
  findRequestByTaskCommit(orgId: string, projectId: string, taskId: string, commitSha: string): Promise<VerificationRequest | null>;
  /**
   * Insert a contract idempotently under the unique (org, project, task_id, expected_commit_sha) key.
   * `inserted` is true when THIS call created the row; on a concurrent-create race the losing call gets
   * `inserted: false` and the WINNER's row, so the caller can detect a conflicting contract.
   */
  createRequest(
    orgId: string,
    projectId: string,
    createdBy: string,
    input: NewVerificationRequest,
  ): Promise<{ request: VerificationRequest; inserted: boolean }>;
  /** Prior evidence for (request, idempotency key), if any — for replay/conflict. */
  findExisting(orgId: string, projectId: string, requestId: string, key: string): Promise<PriorEvidence | null>;
  /**
   * Persist the submission + digest + decision atomically. Under a unique
   * constraint on (org, project, request_id, idempotency_key), a concurrent
   * insert with the same key is a no-op and this returns the WINNER's stored
   * record — so the caller can detect a losing conflict by digest mismatch.
   */
  saveEvidence(
    orgId: string,
    projectId: string,
    submission: EvidenceSubmission,
    submissionSha256: string,
    decision: IngestDecision,
  ): Promise<PriorEvidence>;
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
