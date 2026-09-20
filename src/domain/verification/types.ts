/**
 * Verification & evidence contracts (VER-001).
 *
 * The Hub's honesty layer: it distinguishes what an agent CLAIMED from what was
 * actually executed and verified. These are pure data types with no DB/Next
 * dependency, so the adjudication logic is unit-testable and can later be wired
 * into the live task path through `withTenant`.
 *
 * Design law: an agent-written summary is NEVER execution evidence. Only an
 * `ExecutionEvidence` record with `producedBy: 'trusted_runner'` (a real process
 * with a real exit code, captured by an environment that actually ran it) can
 * move a task toward `verified_complete`.
 */

/** What an agent can ACTUALLY do against a project's linked source, right now. */
export type Capability = 'read_files' | 'run_commands' | 'network';

/**
 * Project access visibility (Priority 1). Reports the linked repo/branch, the
 * full reviewed commit, the real capabilities, and the connection status — and,
 * when access is missing, the ONE exact missing connection to fix.
 */
export interface RepoAccess {
  readonly linked: boolean;
  readonly repoFullName: string | null;
  readonly branch: string | null;
  /** Full reviewed commit SHA (40 hex), never abbreviated. */
  readonly commitSha: string | null;
  /** Sanitized `git status --porcelain` when a local checkout applies; null for REST-only or clean. */
  readonly workingTreeChanges: string | null;
  /** What the agent can actually do here. `run_commands` requires a real execution environment. */
  readonly capabilities: readonly Capability[];
  readonly connection: 'connected' | 'disconnected' | 'error';
  /** ISO timestamp of the last access check (successful or attempted). */
  readonly lastCheckedAt: string | null;
  /** When access is absent, the single exact connection that is missing. Null when connected. */
  readonly missingConnection: string | null;
  readonly detail: string;
}

/**
 * Evidence-backed task status (Priority 2). Ordered from least to most trusted.
 */
export type TaskVerificationStatus =
  | 'draft_complete' // an agent produced a draft; nothing was executed or verified
  | 'blocked_missing_access' // a required connection is absent; work cannot proceed
  | 'ready_for_verification' // draft + access present; awaiting a verification run
  | 'verification_failed' // a verification run ran and did not pass (bad exit, or a promised artifact is missing)
  | 'verified_complete'; // passed: real evidence, exit 0, and every promised artifact exists

/** A retrievable evidence artifact. `present` records whether creation actually succeeded. */
export interface ArtifactRef {
  readonly path: string;
  readonly sha256: string | null;
  readonly sizeBytes: number | null;
  readonly present: boolean;
}

/**
 * The record of a real command execution. Produced only by a trusted runner (a
 * real environment — this session's shell, CI, or a future Hub sandbox), never
 * synthesized from an agent's prose.
 */
export interface ExecutionEvidence {
  readonly kind: 'command';
  readonly command: string;
  readonly cwd: string;
  readonly environment: string; // e.g. 'local-offline', 'ci'
  readonly commitSha: string | null;
  /** Sanitized `git status --porcelain` at run time, if the runner captured it. */
  readonly uncommittedChanges: string | null;
  readonly startedAt: string; // ISO
  readonly finishedAt: string; // ISO
  readonly exitCode: number; // the real process exit code
  readonly stdout: string; // sanitized
  readonly stderr: string; // sanitized
  readonly artifacts: readonly ArtifactRef[];
  /** The provenance gate. Only 'trusted_runner' is admissible as evidence. */
  readonly producedBy: 'trusted_runner' | 'agent_summary';
}

/** One entry in a review-package manifest (Priority 4). */
export interface ManifestEntry {
  readonly path: string; // path inside the package
  readonly sourcePath: string; // where it came from
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface ManifestOmission {
  readonly path: string;
  readonly reason: 'excluded_class' | 'contains_sensitive' | 'not_found';
  readonly detail: string;
}

export interface ReviewManifest {
  readonly generatedAt: string;
  readonly sourceCommit: string | null;
  readonly verificationStatus: TaskVerificationStatus;
  readonly files: readonly ManifestEntry[];
  readonly omissions: readonly ManifestOmission[];
  readonly sensitiveScan: 'clean' | 'omitted';
}

export interface ReviewPackage {
  readonly manifest: ReviewManifest;
  /** The ACTUAL selected file contents, not just filenames. */
  readonly files: readonly { readonly path: string; readonly bytes: Buffer }[];
}
