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
import { verifyEvidenceSignature } from './signing';

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

  // 2. Authenticated signature (per-project runner secret; prose has no signature).
  const secret = await deps.secrets.getRunnerSecret(ctx.orgId, ctx.projectId);
  if (!secret || !verifyEvidenceSignature(secret, payload, envelope.signature)) {
    return reject('unauthenticated', 'Evidence signature is missing or invalid for this project runner secret.');
  }

  // 3. Replay/idempotency — a duplicate key returns the ORIGINAL decision, unchanged.
  const prior = await deps.store.findDecisionByIdempotencyKey(ctx.orgId, ctx.projectId, payload.idempotencyKey);
  if (prior) return { ...prior, replayed: true };

  // 4. Binding.
  const binding = validateBinding(request, payload, ctx);
  if (!binding.ok && binding.rejection) {
    const rejected = reject(binding.rejection.code, binding.rejection.message);
    return deps.store.saveEvidence(ctx.orgId, ctx.projectId, payload, rejected);
  }

  // 5. Required checks (declared up front on the contract).
  const checkEvaluation = evaluateChecks(request.requiredChecks, payload.checks, payload.commitSha);

  // 6. Artifact availability (stored, retrievable, hash-matched).
  const artifactAvailability = await verifyArtifactAvailability(payload.artifacts, deps.artifacts);
  const artifactsOk = allArtifactsAvailable(artifactAvailability);

  // 7. Adjudicate.
  const reasons: string[] = [checkEvaluation.scope];
  let status: IngestDecision['status'];
  let deliverable = false;
  if (checkEvaluation.allRequiredPassed && artifactsOk) {
    status = 'verified_complete';
    deliverable = true;
    reasons.push(
      `All ${request.requiredChecks.length} required check(s) passed and ${artifactAvailability.length} artifact(s) confirmed available at ${payload.commitSha}.`,
    );
  } else {
    status = 'verification_failed';
    if (!checkEvaluation.allRequiredPassed) {
      reasons.push(
        `Required checks not satisfied: ${checkEvaluation.failing.map((f) => `${f.name}=${f.status}`).join(', ') || 'none declared'}.`,
      );
    }
    if (!artifactsOk) {
      const bad = artifactAvailability.filter((a) => a.state !== 'available');
      reasons.push(`Artifacts not verifiable: ${bad.map((a) => `${a.path}=${a.state}`).join(', ')}.`);
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
  return deps.store.saveEvidence(ctx.orgId, ctx.projectId, payload, decision);
}
