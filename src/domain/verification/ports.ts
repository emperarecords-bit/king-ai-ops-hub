/**
 * Ports (VER-002). The ingestion orchestrator depends only on these interfaces,
 * so it is testable with in-memory adapters and wired to Drizzle + the object
 * store in production without any change to the logic.
 */
import type { CatalogResolver } from './catalog';
import type { EvidenceSubmission, IngestDecision, NewVerificationRequest, VerificationRequest } from './ingest-types';

/**
 * A contract plus policy-NEUTRAL evidence facts for retrieval. `acceptedEvidenceCount`/
 * `hasVerifiedComplete` are counts, NOT a verdict — "open" (no accepted evidence yet) deliberately
 * does not encode the unresolved conflicting-attempt resolution policy.
 */
export interface ContractSummary {
  readonly request: VerificationRequest;
  readonly acceptedEvidenceCount: number;
  readonly hasVerifiedComplete: boolean;
}

/** Bounded, deterministic keyset pagination over a project's contracts (ordered by contract id). */
export interface ContractListOptions {
  readonly limit: number;
  readonly afterId?: string | null;
  /** When true, return only contracts with NO accepted evidence yet (awaiting a first result). */
  readonly openOnly: boolean;
}

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
  /** The repositories authorized for this project (its github_repo_links). A contract may only bind one
   *  of these; an empty result means NO authorized binding exists and creation must fail explicitly. */
  linkedRepoFullNames(orgId: string, projectId: string): Promise<string[]>;
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
  /** Project-scoped contract retrieval (PR-3): a bounded page of this project's contracts + evidence
   *  facts. Project-scoped — all of a project's credentials share read access; not runner-specific. */
  listRequests(orgId: string, projectId: string, opts: ContractListOptions): Promise<ContractSummary[]>;
  /** One contract by id, with the same evidence facts, or null when absent in this tenant. */
  getRequestSummary(orgId: string, projectId: string, requestId: string): Promise<ContractSummary | null>;
}

export interface IngestDeps {
  readonly store: VerificationStore;
  readonly artifacts: StoredArtifactStore;
  readonly secrets: RunnerSecretSource;
  /** Trusted, server-side command-catalog resolver (never caller-supplied). */
  readonly catalog: CatalogResolver;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** Max age of a submission's signed timestamp before it is rejected as expired (default 10 min). */
  readonly maxSubmissionAgeMs?: number;
}
