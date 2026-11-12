/**
 * Stage 2 — attestation (design §2.2 end-to-end: read authoritative records, sign, upload, submit).
 *
 * This stage is the one that holds secrets: the bearer credential and the signing key. The
 * checked-out code never enters it (§2.3). It reads harness records from the sink and the
 * repository state from git, and nothing else from disk inside the working tree except the
 * declared artifact files themselves.
 */
import { assertCatalogPinMatches, loadCatalogVersion, type ResolvedCatalog } from '../catalog';
import type { EvidenceSubmission, VerificationContract } from '../contract';
import { readRecords } from '../harness/sink';
import { sealEnvelope } from '../sign';
import { assertCommitMatchesContract, readRepoState, type RepoState } from './git';
import { buildSubmission } from './build-submission';
import { HubClient, type HubClientOptions } from './hub-client';
import { uploadArtifacts, type ArtifactSource } from './submit';

export interface AttestOptions {
  readonly hub: HubClientOptions;
  readonly contractId: string;
  readonly checkoutDir: string;
  readonly sinkDir: string;
  readonly catalogDir: string;
  readonly runnerId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly environment: string;
  /** HMAC signing secret for this project. Never the bearer credential. */
  readonly signingSecret: string;
  readonly artifacts?: readonly ArtifactSource[];
  readonly acknowledgeUnisolated?: boolean;
  /** Stop before uploading or submitting; returns what WOULD be sent. */
  readonly dryRun?: boolean;
}

export interface AttestResult {
  readonly contract: VerificationContract;
  readonly catalog: ResolvedCatalog;
  readonly repo: RepoState;
  readonly payload: EvidenceSubmission;
  readonly submitted: boolean;
  readonly accepted: boolean | null;
  readonly response: unknown;
}

export async function runAttestation(opts: AttestOptions): Promise<AttestResult> {
  const client = new HubClient(opts.hub);

  // The contract is fetched from the Hub, never reconstructed locally: it is the source of
  // requirements and of the catalog pin (§1).
  const contract = await client.getContract(opts.contractId);

  const catalog = loadCatalogVersion(opts.catalogDir, contract.catalogVersion);
  assertCatalogPinMatches(contract, catalog);

  const repo = readRepoState(opts.checkoutDir);
  assertCommitMatchesContract(contract, repo);

  // Authoritative execution facts: the sink, and only the sink.
  const records = readRecords(opts.sinkDir);

  // Artifacts are uploaded BEFORE signing, because the payload must reference the server-generated
  // storage keys the grants produced.
  const uploaded = opts.dryRun
    ? []
    : await uploadArtifacts({
        client,
        requestId: contract.id,
        attemptId: opts.attemptId,
        checkoutDir: opts.checkoutDir,
        artifacts: opts.artifacts ?? [],
      });

  const payload = buildSubmission({
    contract,
    catalog,
    records,
    repo,
    artifacts: uploaded,
    runnerId: opts.runnerId,
    runId: opts.runId,
    attemptId: opts.attemptId,
    environment: opts.environment,
    ...(opts.acknowledgeUnisolated !== undefined ? { acknowledgeUnisolated: opts.acknowledgeUnisolated } : {}),
  });

  if (opts.dryRun) {
    return { contract, catalog, repo, payload, submitted: false, accepted: null, response: null };
  }

  const envelope = sealEnvelope(opts.signingSecret, payload);
  const res = await client.submitEvidence(envelope);
  return { contract, catalog, repo, payload, submitted: true, accepted: res.accepted, response: res.body };
}

export { HubClient, HubError } from './hub-client';
export type { HubClientOptions, HubErrorKind } from './hub-client';
export { buildSubmission, deriveIdempotencyKey, SubmissionError } from './build-submission';
export { readRepoState, assertCommitMatchesContract } from './git';
export type { RepoState } from './git';
export { uploadArtifacts, withRetries } from './submit';
export type { ArtifactSource } from './submit';
