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

// ─────────────────────────── VER-002 PR-4 — artifact upload grants ───────────────────────────

/** An immutable upload grant: (tenant, contract, attempt, logical path) bound to one object key + the
 *  declared size/digest, with a start-TTL and a recorded (unenforced) max-upload-duration. */
export interface UploadGrant {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly logicalPath: string;
  readonly objectKey: string;
  readonly declaredSize: number;
  readonly declaredSha256: string;
  readonly contentType: string;
  readonly expiresAt: string; // ISO — when an upload may START
  readonly maxUploadMs: number; // T_max, recorded only (unproven; never a reclaim trigger)
  readonly createdAt: string; // ISO
}

/** Untrusted-but-validated fields for a new grant (tenant/creator supplied separately from context). */
export interface NewUploadGrant {
  readonly requestId: string;
  readonly attemptId: string;
  readonly logicalPath: string;
  readonly objectKey: string;
  readonly declaredSize: number;
  readonly declaredSha256: string;
  readonly contentType: string;
  readonly expiresAt: Date;
  readonly maxUploadMs: number;
}

/** The upload-grant "uploaded" state is DERIVED from a completion event, never a mutable column. */
export type UploadGrantEventType = 'uploaded' | 'redemption_failed';

/** Read-only binding lookup used at INGEST (a subset of the full store). */
export interface UploadGrantBindingSource {
  /** The successfully-`uploaded` grant matching (contract, attempt, logical path), or null. */
  findUploadedGrantForArtifact(
    orgId: string,
    projectId: string,
    requestId: string,
    attemptId: string,
    logicalPath: string,
  ): Promise<UploadGrant | null>;
}

/** Persistence for upload grants (immutable metadata + append-only lifecycle events). */
export interface UploadGrantStore extends UploadGrantBindingSource {
  findGrantByDedup(orgId: string, projectId: string, requestId: string, attemptId: string, logicalPath: string): Promise<UploadGrant | null>;
  getGrantById(orgId: string, projectId: string, grantId: string): Promise<UploadGrant | null>;
  /** Insert idempotently on the dedup unique; `inserted:false` + the WINNER on a concurrent create. */
  insertGrant(orgId: string, projectId: string, createdBy: string | null, input: NewUploadGrant): Promise<{ grant: UploadGrant; inserted: boolean }>;
  /** True iff a completion ('uploaded') event exists — state derived from events, not the latest one. */
  isUploaded(orgId: string, projectId: string, grantId: string): Promise<boolean>;
  /** Append a lifecycle event. The 'uploaded' insert is idempotent (partial unique → no-op on conflict). */
  appendEvent(orgId: string, projectId: string, grantId: string, eventType: UploadGrantEventType, detail: string | null): Promise<void>;
}

/** A private temp sink for streaming validated bytes before an atomic create-only publish. */
export interface StagedArtifact {
  /** Append a chunk to the private temp file (never the final key). */
  append(chunk: Buffer): Promise<void>;
  /** Atomically publish the temp file at the final key WITHOUT replacement (create-only link).
   *  'created' = this call created it; 'exists' = an object was already present (no overwrite). */
  publish(contentType: string): Promise<'created' | 'exists'>;
  /** Delete the temp file (idempotent). Always called in `finally`. */
  discard(): Promise<void>;
}

/** Options for a staged create-only publish. `deadline` bounds any INTERNAL retry (e.g. the S3 adapter's
 *  ambiguous-outcome retry) to the grant's expiry — a retry after it is a new create the grant no longer
 *  authorizes. Adapters without internal retries (local link) may ignore it. */
export interface StageOptions {
  readonly deadline?: Date;
}

/**
 * Create-only artifact writer. Publishes ONLY complete, validated bytes, atomically, without
 * replacement. An adapter that cannot guarantee atomic create-only MUST fail closed (throw), never fall
 * back to an overwriting `put`.
 */
export interface ExclusiveArtifactWriter {
  stage(finalKey: string, opts?: StageOptions): Promise<StagedArtifact>;
}

/** Thrown by an adapter that cannot guarantee atomic create-only writes — the caller fails closed and
 *  never falls back to an overwriting `put`. */
export class UnsupportedExclusiveWriteError extends Error {
  constructor(driver: string) {
    super(`storage driver '${driver}' does not support atomic create-only artifact writes`);
    this.name = 'UnsupportedExclusiveWriteError';
  }
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
  /** VER-002 PR-4 — binds each submitted artifact to a successfully-uploaded grant (contract+attempt
   *  +path+key+size+digest) before availability is even checked. */
  readonly grants: UploadGrantBindingSource;
  /** Injectable clock for deterministic tests. */
  readonly now?: () => Date;
  /** Max age of a submission's signed timestamp before it is rejected as expired (default 10 min). */
  readonly maxSubmissionAgeMs?: number;
}
