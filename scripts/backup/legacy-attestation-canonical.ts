import { createHash } from 'node:crypto';
import { canonicalizeV1, hashCanonicalString } from '@/lib/canonical';
import { type LegacyEvidenceManifest, type SignedLegacyAttestation } from './legacy-attestation-schema';

/**
 * G-Backup-A2 — deterministic canonicalization for legacy attestations (no signing here). Domain-separated.
 */

export const LEGACY_SIGN_DOMAIN = 'gbackup-legacy-migration-attestation/v1\n' as const;
export const LEGACY_EVIDENCE_DOMAIN = 'gbackup-legacy-evidence/v1\n' as const;

/** SHA-256 over the domain-prefixed canonical evidence manifest. */
export function computeEvidenceManifestHash(manifest: LegacyEvidenceManifest): string {
  return hashCanonicalString(LEGACY_EVIDENCE_DOMAIN + canonicalizeV1(manifest), 1);
}

/** The exact bytes that are signed / verified: domain tag + canonical signed payload. */
export function attestationSigningBytes(signed: SignedLegacyAttestation): Buffer {
  return Buffer.from(LEGACY_SIGN_DOMAIN + canonicalizeV1(signed), 'utf8');
}

export const LEGACY_CONTENT_DOMAIN = 'gbackup-legacy-migration-attestation-content/v1\n' as const;

/**
 * Deterministic content digest over the canonical payload EXCLUDING `attestationId` (and the signature, which is
 * not part of `SignedLegacyAttestation`). This is the identity basis: `attestationId = lma1_<digest>`, so one id
 * can never refer to two payloads and two ids can never refer to one payload.
 */
export function attestationContentDigest(signed: SignedLegacyAttestation): string {
  const { attestationId: _id, ...rest } = signed;
  void _id;
  return createHash('sha256').update(LEGACY_CONTENT_DOMAIN + canonicalizeV1(rest), 'utf8').digest('hex');
}

/** The deterministic attestation id derived from the content digest. */
export function deriveAttestationId(signed: SignedLegacyAttestation): string {
  return `lma1_${attestationContentDigest(signed)}`;
}

/** PRODUCER/TEST helper (pure, no crypto): set `attestationId` to its derived value. */
export function finalizeAttestationId(signed: SignedLegacyAttestation): SignedLegacyAttestation {
  return { ...signed, attestationId: deriveAttestationId(signed) };
}
