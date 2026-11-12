/**
 * The harness record — the only thing the signer trusts about an execution (design §2.2).
 *
 * Every field here is produced by the COLLECTOR process: wall-clock timestamps it took itself, the
 * exit code the OS reported to it, and a digest of output it captured over a pipe. Nothing is read
 * back from the checkout, so repo code cannot contribute to it.
 *
 * `isolation` travels WITH the record rather than being asserted once at the end of a run. A run
 * that degraded part-way (or records copied between machines) cannot therefore be laundered into
 * looking isolated: the claim is attached to each measurement it is meant to qualify.
 */
import type { IsolationReport } from './isolation';

/** Mirrors the Hub's `CheckStatus`. `errored` is for a harness-level failure (spawn/timeout). */
export type CheckStatus = 'passed' | 'failed' | 'skipped' | 'errored';

export interface HarnessRecord {
  readonly schema: 'king-verification-harness/v1';
  readonly name: string;
  /** The command as approved by the pinned catalog — recorded so the signer can re-assert it. */
  readonly command: string;
  readonly status: CheckStatus;
  /** Null only when the process never produced one (spawn failure, or killed on timeout). */
  readonly exitCode: number | null;
  /** Set when the collector killed the process; a timeout is `errored`, never `failed`. */
  readonly timedOut: boolean;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  /** sha256 of the captured stdout+stderr stream. Null when nothing was captured. */
  readonly outputDigest: string | null;
  readonly outputBytes: number;
  readonly isolation: IsolationReport;
  /** Identifies the run these records belong to, so a stale sink cannot be mixed into a new run. */
  readonly runId: string;
}

/**
 * Map an exit code to a check status.
 *
 * A timeout is `errored`, not `failed`: "the suite reported a failing test" and "we never found out"
 * are different facts, and collapsing them would let an infrastructure flake be recorded as a
 * genuine test failure (or, worse, the reverse once someone 'fixes' the mapping).
 */
export function statusFor(exitCode: number | null, timedOut: boolean): CheckStatus {
  if (timedOut) return 'errored';
  if (exitCode === null) return 'errored';
  return exitCode === 0 ? 'passed' : 'failed';
}

/** Structural validation of a record read back from the sink. Fails closed on anything odd. */
export function assertValidRecord(value: unknown, context: string): HarnessRecord {
  const r = value as Partial<HarnessRecord> | null;
  if (!r || typeof r !== 'object') throw new Error(`${context}: record is not an object`);
  if (r.schema !== 'king-verification-harness/v1') throw new Error(`${context}: unknown record schema ${String(r.schema)}`);
  for (const k of ['name', 'command', 'status', 'startedAt', 'finishedAt', 'runId'] as const) {
    if (typeof r[k] !== 'string' || r[k] === '') throw new Error(`${context}: missing ${k}`);
  }
  if (typeof r.durationMs !== 'number' || !Number.isFinite(r.durationMs) || r.durationMs < 0) {
    throw new Error(`${context}: invalid durationMs`);
  }
  if (r.exitCode !== null && typeof r.exitCode !== 'number') throw new Error(`${context}: invalid exitCode`);
  if (typeof r.timedOut !== 'boolean') throw new Error(`${context}: invalid timedOut`);
  if (!r.isolation || typeof r.isolation !== 'object' || typeof r.isolation.enforced !== 'boolean') {
    throw new Error(`${context}: missing isolation report`);
  }
  return r as HarnessRecord;
}
