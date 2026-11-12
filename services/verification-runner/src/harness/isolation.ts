/**
 * Execution isolation policy (design §2.3) — and the honest admission of what this reference
 * implementation can and cannot enforce.
 *
 * §2.3 is explicit that "outside the checkout" is a LOCATION, not protection: on a shared machine a
 * hostile dependency can still read a sibling directory, scrape the collector's environment, or
 * ptrace it. Real protection needs a distinct unprivileged uid, a container/microVM, no network
 * egress, and a ptrace barrier.
 *
 * This module does NOT pretend to create those conditions. It PROBES for them and reports, and the
 * harness FAILS CLOSED when they are absent. That choice is the whole point: a runner that executes
 * untrusted commands without isolation and signs the result anyway is worse than one that refuses,
 * because the signature would carry authority the execution had not earned (§6.4).
 *
 * The probe result is stamped into every harness record, so the attestation stage can refuse to
 * sign unisolated evidence without having to re-derive any of this.
 */
import { platform } from 'node:process';

export interface IsolationControls {
  /** Checks run as a uid distinct from the collector's, so they cannot ptrace or read its env. */
  readonly separateExecutionUid: boolean;
  /** Checks run inside a container/microVM, not merely a different directory. */
  readonly sandboxed: boolean;
  /** Network egress is denied in the execution sandbox by default. */
  readonly egressDenied: boolean;
  /** The result sink is unreachable (not writable, not readable) by the execution uid. */
  readonly sinkUnreachableByExecution: boolean;
}

export interface IsolationReport {
  readonly enforced: boolean;
  readonly controls: IsolationControls;
  /** Human-readable reasons a control is absent — surfaced verbatim in the refusal. */
  readonly gaps: readonly string[];
  readonly platform: string;
}

export interface IsolationOptions {
  /**
   * The uid untrusted commands run as. Distinct from the collector's uid, per §2.3. Supplied by
   * the operator (a CI job that has already created the user), never guessed.
   */
  readonly executionUid?: number;
  /** Set when the caller has placed the whole harness inside a container/microVM. */
  readonly sandboxed?: boolean;
  /** Set when egress is denied for the execution context (e.g. a network-less container). */
  readonly egressDenied?: boolean;
}

/**
 * Probe the controls §2.3 requires. Everything is reported from what the OPERATOR declared plus
 * what the OS can actually support — nothing is inferred optimistically. In particular POSIX uid
 * separation is impossible to honour on win32, where `child_process` has no `uid` option at all,
 * so win32 can never report `enforced: true`.
 */
export function probeIsolation(opts: IsolationOptions = {}): IsolationReport {
  const gaps: string[] = [];
  const posix = platform !== 'win32';

  const collectorUid = typeof process.getuid === 'function' ? process.getuid() : null;
  let separateExecutionUid = false;
  if (!posix) {
    gaps.push('platform win32 cannot run a child process under a different uid (no POSIX uid support)');
  } else if (opts.executionUid === undefined) {
    gaps.push('no executionUid supplied — untrusted commands would run as the collector uid');
  } else if (collectorUid !== null && opts.executionUid === collectorUid) {
    gaps.push(`executionUid ${opts.executionUid} equals the collector uid — no ptrace/env barrier`);
  } else {
    separateExecutionUid = true;
  }

  const sandboxed = opts.sandboxed === true;
  if (!sandboxed) gaps.push('not declared sandboxed — checks would share the host namespace');

  const egressDenied = opts.egressDenied === true;
  if (!egressDenied) gaps.push('network egress not declared denied — a check could exfiltrate or phone home');

  // The sink is unreachable exactly when there is a uid barrier to make it unreachable FROM. The
  // sink's own 0700/ownership is asserted separately in `sink.ts`; without a distinct uid, mode
  // bits protect nothing because the executing process is the owner.
  const sinkUnreachableByExecution = separateExecutionUid;
  if (!sinkUnreachableByExecution) {
    gaps.push('result sink is reachable by the execution context (no uid barrier; 0700 protects nothing from its owner)');
  }

  const controls: IsolationControls = { separateExecutionUid, sandboxed, egressDenied, sinkUnreachableByExecution };
  return { enforced: gaps.length === 0, controls, gaps, platform };
}

export class IsolationError extends Error {
  constructor(public readonly report: IsolationReport) {
    super(
      `execution isolation is not enforced (platform ${report.platform}); refusing to run untrusted commands:\n` +
        report.gaps.map((g) => `  - ${g}`).join('\n') +
        '\nPass allowUnisolated only for a trusted local dry run; such records cannot be signed by default.',
    );
    this.name = 'IsolationError';
  }
}

/**
 * Gate on isolation. `allowUnisolated` exists so the harness is usable for local development, but
 * it is deliberately NOT a quiet override: the resulting records carry `isolation.enforced: false`,
 * and `buildSubmission` refuses them unless the operator repeats the acknowledgement. There is no
 * code path that produces a signable record without an explicit, recorded decision.
 */
export function requireIsolation(report: IsolationReport, allowUnisolated: boolean): void {
  if (!report.enforced && !allowUnisolated) throw new IsolationError(report);
}
