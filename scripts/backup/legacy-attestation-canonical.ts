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

/** Content digest of the signed payload (excludes the signature). Used for duplicate/conflict detection. */
export function attestationContentDigest(signed: SignedLegacyAttestation): string {
  return createHash('sha256').update(LEGACY_SIGN_DOMAIN + canonicalizeV1(signed), 'utf8').digest('hex');
}
