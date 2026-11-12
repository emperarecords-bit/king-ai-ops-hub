/**
 * Assemble the payload that will be signed (design §2.2, §1).
 *
 * This is the hinge of the whole trust model, so it is written to make the safe thing the only
 * thing:
 *
 *  - Check results come from harness records read out of the SINK. There is no parameter through
 *    which a caller could inject a result, and nothing here opens a file in the checkout.
 *  - The required-check and required-artifact lists come from the CONTRACT. A runner cannot narrow
 *    them; a missing required check is a refusal here, exactly as it would be a rejection at the
 *    Hub (§1).
 *  - Each record's command is re-asserted against the pinned catalog (§2.1) before signing.
 *  - A record whose isolation was not enforced is refused unless the operator explicitly
 *    acknowledges it, so an unisolated dry run cannot be signed by accident (§6.4).
 */
import { createHash } from 'node:crypto';
import { assertCommandsMatchCatalog, type ResolvedCatalog } from '../catalog';
import { canonicalJson } from '../canonical';
import type { CheckResult, EvidenceSubmission, SubmittedArtifact, VerificationContract } from '../contract';
import { assertValidRecord, type HarnessRecord } from '../harness/records';
import type { RepoState } from './git';

export interface BuildSubmissionInput {
  readonly contract: VerificationContract;
  readonly catalog: ResolvedCatalog;
  /** Records read from the harness sink. The ONLY source of execution facts. */
  readonly records: readonly unknown[];
  readonly repo: RepoState;
  readonly artifacts: readonly SubmittedArtifact[];
  readonly runnerId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly environment: string;
  /** Must be true to sign records whose isolation report says enforced: false. */
  readonly acknowledgeUnisolated?: boolean;
  readonly submittedAt?: string;
}

export class SubmissionError extends Error {}

/**
 * A deterministic idempotency key.
 *
 * Derived from the identity of the attempt rather than randomly generated, so an interrupted
 * submit can be retried byte-identically and the Hub replays its stored result instead of creating
 * a second attempt. Randomness here would silently defeat the Hub duplicate guard on exactly the
 * retry path it exists to protect.
 */
export function deriveIdempotencyKey(input: {
  readonly requestId: string;
  readonly attemptId: string;
  readonly commitSha: string;
  readonly records: readonly HarnessRecord[];
}): string {
  const basis = canonicalJson({
    requestId: input.requestId,
    attemptId: input.attemptId,
    commitSha: input.commitSha,
    checks: input.records.map((r) => ({ name: r.name, status: r.status, exitCode: r.exitCode, startedAt: r.startedAt, finishedAt: r.finishedAt })),
  });
  return createHash('sha256').update(basis).digest('hex');
}

export function buildSubmission(input: BuildSubmissionInput): EvidenceSubmission {
  const records = input.records.map((r, i) => assertValidRecord(r, 'harness record #' + i));

  // One run only. A sink holding records from a previous run would otherwise be signed as if they
  // described this one.
  const foreign = records.filter((r) => r.runId !== input.runId);
  if (foreign.length > 0) {
    throw new SubmissionError(
      'sink holds records from other runs (' + [...new Set(foreign.map((r) => r.runId))].join(', ') + '); expected only ' + input.runId,
    );
  }

  // Isolation must be enforced, or explicitly acknowledged as not.
  const unisolated = records.filter((r) => r.isolation.enforced !== true);
  if (unisolated.length > 0 && input.acknowledgeUnisolated !== true) {
    throw new SubmissionError(
      'refusing to sign ' + unisolated.length + ' record(s) whose execution isolation was not enforced: ' +
        unisolated.map((r) => r.name).join(', ') +
        '. A signature would assert authority the execution did not earn (design §6.4).',
    );
  }

  // Every required check must be present. The contract is the source of requirements (§1).
  const byName = new Map(records.map((r) => [r.name, r]));
  const missing = input.contract.requiredChecks.filter((n) => !byName.has(n));
  if (missing.length > 0) {
    throw new SubmissionError('harness produced no record for required check(s): ' + missing.join(', '));
  }

  const checks: CheckResult[] = input.contract.requiredChecks.map((name) => {
    const r = byName.get(name) as HarnessRecord;
    return {
      name: r.name,
      status: r.status,
      command: r.command,
      exitCode: r.exitCode,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      outputDigest: r.outputDigest,
    };
  });

  // The commands we are about to attest must be the reviewed ones (§2.1).
  assertCommandsMatchCatalog(checks, input.catalog);

  // Every required artifact must be present in what we are submitting (§1: an empty submitted list
  // can never bypass the contract requirements).
  const haveArtifacts = new Set(input.artifacts.map((a) => a.logicalPath));
  const missingArtifacts = input.contract.requiredArtifacts.filter((p) => !haveArtifacts.has(p));
  if (missingArtifacts.length > 0) {
    throw new SubmissionError('missing required artifact(s): ' + missingArtifacts.join(', '));
  }

  const payload: EvidenceSubmission = {
    requestId: input.contract.id,
    orgId: input.contract.orgId,
    projectId: input.contract.projectId,
    taskId: input.contract.taskId,
    repoFullName: input.contract.repoFullName,
    commitSha: input.repo.commitSha,
    dirty: input.repo.dirty,
    uncommittedChangesDigest: input.repo.uncommittedChangesDigest,
    runnerId: input.runnerId,
    runId: input.runId,
    attemptId: input.attemptId,
    environment: input.environment,
    source: 'local_runner',
    checks,
    artifacts: input.artifacts,
    // Declared INSIDE the signed payload so the Hub can cross-check it against both the contract
    // pin and its own server-side re-resolution.
    catalogVersion: input.catalog.version,
    catalogDigest: input.catalog.digest,
    idempotencyKey: deriveIdempotencyKey({
      requestId: input.contract.id,
      attemptId: input.attemptId,
      commitSha: input.repo.commitSha,
      records,
    }),
    submittedAt: input.submittedAt ?? new Date().toISOString(),
  };
  return payload;
}
