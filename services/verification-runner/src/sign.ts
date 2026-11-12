/**
 * Evidence signing. HMAC-SHA256 (hex) over the canonical payload, under the project's runner
 * secret — the same construction the Hub recomputes in `verifyEvidenceSignature`.
 *
 * The signing key is NOT the bearer credential. The bearer credential authenticates the HTTP call;
 * the signature authenticates the payload. Design §6.4 is explicit that this proves *who signed*
 * and *that the bytes are unaltered* — it does NOT prove the execution was truthful. Truthfulness
 * comes from the harness (§2.2), which is why this module refuses to sign records that the harness
 * did not vouch for; see `attest/build-submission.ts`.
 */
import { createHmac } from 'node:crypto';
import { canonicalJson } from './canonical';
import type { EvidenceSubmission, SignedEnvelope } from './contract';

/** The only signing-key version the Hub accepts today (`SUPPORTED_SIGNING_VERSIONS`). */
export const SIGNING_KEY_VERSION = 'v1';

export function signEvidence(secret: string, payload: EvidenceSubmission): string {
  if (!secret) throw new Error('signEvidence: empty signing secret');
  return createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
}

/**
 * Build the envelope actually POSTed. `signingKeyVersion` is always set explicitly rather than
 * relying on the Hub's "absent ⇒ v1" compatibility default: being explicit means a future key
 * rotation is a visible one-line change here, not a silent reinterpretation of old envelopes.
 */
export function sealEnvelope(secret: string, payload: EvidenceSubmission): SignedEnvelope {
  return {
    runnerId: payload.runnerId,
    payload,
    signature: signEvidence(secret, payload),
    signingKeyVersion: SIGNING_KEY_VERSION,
  };
}
