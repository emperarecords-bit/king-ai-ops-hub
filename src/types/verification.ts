/**
 * Shared verification CONTRACT types (VER-002).
 *
 * These are the neutral, dependency-free shapes that both the domain ingestion
 * logic and the database schema need: the schema types its jsonb/text columns
 * with them, and the domain reads/writes them. They live in the `types` floor so
 * neither layer has to import the other (db/lib/types must not import domain).
 * The domain re-exports them from `@/domain/verification` for convenience, so
 * existing domain-side imports are unchanged.
 */

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
  | 'idempotency_conflict'
  /** The envelope declared a signing-key version the Hub no longer supports (signing-key retirement —
   *  distinct from a revoked bearer credential, which is refused earlier at authentication). */
  | 'unsupported_signing_version'
  /** The contract predates catalog pinning (carries the 'unpinned' sentinel) — rejected, fail closed. */
  | 'catalog_unpinned'
  /** The contract's pinned catalog version can no longer be resolved server-side (missing snapshot) —
   *  fail closed rather than verify against an unknown catalog. */
  | 'catalog_unavailable'
  /** The evidence's declared catalog identity, the contract's pinned identity, and the server-resolved
   *  catalog do not all agree (skew or tampering). */
  | 'catalog_mismatch'
  /** A submitted artifact has no successfully-uploaded upload grant binding it to this contract+attempt
   *  +path (VER-002 PR-4). A same-tenant object from another contract/attempt lands here. Fail closed. */
  | 'artifact_not_granted'
  /** A submitted artifact matches an upload grant on (contract, attempt, path) but a bound field
   *  (object key, declared size, or declared digest) disagrees with the grant (VER-002 PR-4). */
  | 'grant_binding_mismatch';
