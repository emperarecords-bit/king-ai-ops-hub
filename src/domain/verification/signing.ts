/**
 * Authentication for the local-runner evidence source.
 *
 * A runner signs the canonical JSON of its submission with a per-project shared
 * secret (stored encrypted in `integration_secrets`, name `verification_runner_hmac`).
 * The Hub recomputes the HMAC and rejects any mismatch. This is the smallest
 * authenticated connection: no inbound network trust, no bearer tokens on disk,
 * and pasted agent prose (which carries no valid signature) can never enter.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { EvidenceSubmission } from './ingest-types';

/**
 * Supported signing-key versions. Only `v1` exists (the version baked into the server-side key
 * derivation, `verification-runner:v1:org:project`). An envelope declaring any other version is
 * rejected on BOTH the machine and human ingestion paths. This is signing-key *retirement*, kept
 * deliberately separate from bearer-credential revocation.
 */
export const SUPPORTED_SIGNING_VERSIONS = ['v1'] as const;
export type SigningKeyVersion = (typeof SUPPORTED_SIGNING_VERSIONS)[number];
/** Envelopes signed before the version field existed are treated as this original version. */
export const DEFAULT_SIGNING_VERSION: SigningKeyVersion = 'v1';

export function isSupportedSigningVersion(version: string | undefined): boolean {
  return (SUPPORTED_SIGNING_VERSIONS as readonly string[]).includes(version ?? DEFAULT_SIGNING_VERSION);
}

/** Canonical content digest of a submission — the identity used for idempotency:
 *  an identical retry has the same digest; any change produces a different one. */
export function submissionDigest(payload: EvidenceSubmission): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/** Deterministic JSON with sorted keys so signer and verifier agree byte-for-byte. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortDeep((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

export function signEvidence(secret: string, payload: EvidenceSubmission): string {
  return createHmac('sha256', secret).update(canonicalJson(payload)).digest('hex');
}

/** Constant-time signature verification. Returns false on any shape/secret error. */
export function verifyEvidenceSignature(secret: string, payload: EvidenceSubmission, signature: string): boolean {
  if (!secret || !signature) return false;
  let expected: Buffer;
  let got: Buffer;
  try {
    expected = Buffer.from(signEvidence(secret, payload), 'hex');
    got = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== got.length || expected.length === 0) return false;
  return timingSafeEqual(expected, got);
}
