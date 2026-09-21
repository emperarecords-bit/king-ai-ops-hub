/**
 * Evidence ingestion orchestrator (VER-002, Option A).
 *
 * The one entry point that turns a signed external-runner submission into an
 * idempotent verification decision. Order of gates:
 *   1. known contract  2. authenticated signature  3. replay/idempotency
 *   4. binding (tenant/project/repo/task/commit/dirty)  5. required checks
 *   6. artifact availability  7. adjudicate + persist.
 *
 * Only a submission that clears every gate reaches `verified_complete`. Agent
 * prose carries no valid signature and is rejected at gate 2.
 */
import { allArtifactsAvailable, verifyArtifactAvailability } from './artifacts-availability';
import { validateBinding, type TenantContext } from './binding';
import { evaluateChecks } from './checks';
import type { IngestDecision, RejectionCode, SignedEnvelope } from './ingest-types';
import type { IngestDeps } from './ports';
import { DEFAULT_SIGNING_VERSION, isSupportedSigningVersion, submissionDigest, verifyEvidenceSignature } from './signing';
import { UNPINNED_CATALOG_VERSION } from './catalog';
import { isCanonicalTenantKey } from './tenant-key';

export async function ingestEvidence(
  deps: IngestDeps,
  ctx: TenantContext,
  envelope: SignedEnvelope,
): Promise<IngestDecision> {
  const now = (deps.now ?? (() => new Date()))();
  const decidedAt = now.toISOString();
  const { payload } = envelope;
  const base = {
    idempotencyKey: payload.idempotencyKey,
    checkEvaluation: null,
    artifactAvailability: [] as never[],
    decidedAt,
    replayed: false,
  };
  const reject = (code: RejectionCode, message: string): IngestDecision => ({
    ...base,
    accepted: false,
    rejection: { code, message },
    // Fail-safe: a rejected submission never confers verification. Callers apply
    // `status` to the task only when `accepted` is true.
    status: 'verification_failed',
    deliverable: false,
    reasons: [message],
  });

  // 1. Known contract (looked up under the TRUSTED caller tenant, never the payload's claims).
  const request = await deps.store.getRequest(ctx.orgId, ctx.projectId, payload.requestId);
  if (!request) return reject('unknown_request', `No verification contract ${payload.requestId} for this project.`);

  // 1b. Signing-key version. Absent ⇒ 'v1' (envelopes predating the field keep verifying). An
  //     unsupported version is a signing-key RETIREMENT rejection — distinct from a revoked bearer
  //     credential (refused earlier, at authentication). Applied on both auth paths (all ingest).
  const signingVersion = envelope.signingKeyVersion ?? DEFAULT_SIGNING_VERSION;
  if (!isSupportedSigningVersion(signingVersion)) {
    return reject('unsupported_signing_version', `Signing-key version '${signingVersion}' is not supported.`);
  }

  // 2. Authenticated signature (per-project runner secret; prose has no signature).
  //    The secret is fetched with the TRUSTED caller tenant, never the payload's
  //    claims, so a submission can never widen its own authorized scope.
  const secret = await deps.secrets.getRunnerSecret(ctx.orgId, ctx.projectId);
  if (!secret || !verifyEvidenceSignature(secret, payload, envelope.signature)) {
    return reject('unauthenticated', 'Evidence signature is missing or invalid for this project runner secret.');
  }

  // 2b. Freshness — the signed timestamp bounds the replay window. A valid HMAC
  //     authenticates the submitter, not the freshness of a captured envelope.
  const maxAgeMs = deps.maxSubmissionAgeMs ?? 10 * 60_000;
  const skewMs = 60_000;
  const submittedMs = Date.parse(payload.submittedAt);
  if (!Number.isFinite(submittedMs) || submittedMs > now.getTime() + skewMs || now.getTime() - submittedMs > maxAgeMs) {
    return reject('expired', `Submission timestamp ${payload.submittedAt} is outside the ${maxAgeMs}ms freshness window.`);
  }

  // 3. Idempotency — bound to (request + canonical submission digest). An identical
  //    retry returns the ORIGINAL decision; a DIFFERENT submission reusing the key
  //    is an explicit conflict, never a silent overwrite.
  const digest = submissionDigest(payload);
  // Single persistence path for EVERY outcome (reject or accept). A concurrent
  // insert that won the (request,key) row with a different submission is detected
  // by digest mismatch, so a losing changed submission can never inherit the
  // winner's decision — success or otherwise.
  const persist = async (d: IngestDecision): Promise<IngestDecision> => {
    const saved = await deps.store.saveEvidence(ctx.orgId, ctx.projectId, payload, digest, d);
    if (saved.submissionSha256 !== digest) {
      return reject('idempotency_conflict', 'A concurrent submission with the same key differed; the first decision is preserved.');
    }
    return saved.decision;
  };

  const prior = await deps.store.findExisting(ctx.orgId, ctx.projectId, payload.requestId, payload.idempotencyKey);
  if (prior) {
    if (prior.submissionSha256 === digest) return { ...prior.decision, replayed: true };
    return reject('idempotency_conflict', 'Idempotency key reused with a different submission; the original decision is preserved.');
  }

  // 4. Binding.
  const binding = validateBinding(request, payload, ctx);
  if (!binding.ok && binding.rejection) {
    return persist(reject(binding.rejection.code, binding.rejection.message));
  }

  // 4b. Catalog identity (D1/D4). The contract pins a trusted catalog (version, digest) resolved
  //     server-side at creation. Re-resolve the PINNED version here and require the contract, the
  //     server-resolved catalog, and the SIGNED payload to all agree — the caller can never supply
  //     catalog contents or an authoritative digest. A legacy 'unpinned' contract, or a pinned version
  //     that no longer resolves, fails CLOSED. Applied on both auth paths (all ingest).
  if (request.catalogVersion === UNPINNED_CATALOG_VERSION) {
    return persist(reject('catalog_unpinned', 'This contract predates catalog pinning; it cannot be verified until re-created against a pinned catalog.'));
  }
  const catalog = deps.catalog.byVersion(request.catalogVersion);
  if (!catalog) {
    return persist(reject('catalog_unavailable', `The contract's pinned catalog version '${request.catalogVersion}' can no longer be resolved.`));
  }
  if (
    catalog.digest !== request.catalogDigest ||
    payload.catalogVersion !== request.catalogVersion ||
    payload.catalogDigest !== request.catalogDigest
  ) {
    return persist(reject('catalog_mismatch', 'The evidence catalog identity does not match the contract’s pinned, server-resolved catalog.'));
  }
  // 4c. Exact command binding: a required check's reported command must equal the pinned catalog entry.
  //     OWN-property lookup only — an unapproved name (e.g. 'toString') has no catalog command, so any
  //     submitted command for it fails to match (invalid_checks).
  for (const name of request.requiredChecks) {
    const submitted = payload.checks.find((c) => c.name === name);
    if (!submitted) continue; // a missing required check is caught by the checks evaluation below
    const approved = Object.prototype.hasOwnProperty.call(catalog.commands, name) ? catalog.commands[name] : undefined;
    if (submitted.command !== approved) {
      return persist(reject('invalid_checks', `Check '${name}' reported a command that does not match the pinned catalog '${catalog.version}'.`));
    }
  }

  // 5. Required checks (declared up front). Structural defects invalidate the submission.
  const checkEvaluation = evaluateChecks(request.requiredChecks, payload.checks, payload.commitSha);
  if (checkEvaluation.problems.length > 0) {
    return persist({ ...reject('invalid_checks', `Invalid checks: ${checkEvaluation.problems.join(' ')}`), checkEvaluation });
  }

  // 6. Artifact availability (stored, retrievable, hash-matched) — and tenant-bound.
  //    A storageKey outside this tenant's partition is `forbidden` and never
  //    dereferenced, even if the supplied hash matches.
  const keyAllowed = (key: string): boolean => isCanonicalTenantKey(key, ctx);
  const artifactAvailability = await verifyArtifactAvailability(payload.artifacts, deps.artifacts, keyAllowed);
  const artifactsOk = allArtifactsAvailable(artifactAvailability);

  // 6b. Required artifacts (declared before execution). Every one must be present
  //     AND available — an empty submitted list can never bypass this.
  const availablePaths = new Set(artifactAvailability.filter((a) => a.state === 'available').map((a) => a.path));
  const missingRequired = request.requiredArtifacts.filter((p) => !availablePaths.has(p));

  // 7. Adjudicate.
  const reasons: string[] = [checkEvaluation.scope];
  let status: IngestDecision['status'];
  let deliverable = false;
  if (checkEvaluation.allRequiredPassed && artifactsOk && missingRequired.length === 0) {
    status = 'verified_complete';
    deliverable = true;
    reasons.push(
      `All ${request.requiredChecks.length} required check(s) passed and all ${request.requiredArtifacts.length} required artifact(s) confirmed available at ${payload.commitSha}.`,
    );
  } else {
    status = 'verification_failed';
    if (!checkEvaluation.allRequiredPassed) {
      reasons.push(
        `Required checks not satisfied: ${checkEvaluation.failing.map((f) => `${f.name}=${f.status}`).join(', ') || 'none declared'}.`,
      );
    }
    if (missingRequired.length > 0) {
      reasons.push(`Required artifact(s) missing or unavailable: ${missingRequired.join(', ')}.`);
    }
    if (!artifactsOk) {
      const bad = artifactAvailability.filter((a) => a.state !== 'available');
      reasons.push(`Submitted artifacts not verifiable: ${bad.map((a) => `${a.path}=${a.state}`).join(', ')}.`);
    }
  }

  const decision: IngestDecision = {
    accepted: true,
    rejection: null,
    status,
    deliverable,
    idempotencyKey: payload.idempotencyKey,
    checkEvaluation,
    artifactAvailability,
    reasons,
    decidedAt,
    replayed: false,
  };
  return persist(decision);
}
