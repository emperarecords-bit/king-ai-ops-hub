import { type KeyObject, sign as cryptoSign } from 'node:crypto';
import { type LegacyMigrationAttestation, type SignedLegacyAttestation } from './legacy-attestation-schema';
import { attestationSigningBytes } from './legacy-attestation-canonical';

/**
 * G-Backup-A2 — OFFLINE / TEST SIGNER. This is the ONLY module that takes a PRIVATE key. It must NOT be imported
 * by the runtime verifier, the migration detector, `scripts/migrate.ts`, or any future release validator — a
 * static import-boundary test enforces that. In production, signing happens OFFLINE with an owner-controlled key
 * that never reaches this process; this function exists for the isolated tests (ephemeral keys) and for a local
 * producer utility, not for the deployment/runtime path.
 */
export function signLegacyAttestation(signed: SignedLegacyAttestation, privateKey: KeyObject): LegacyMigrationAttestation {
  if (signed.signatureAlgorithm !== 'ed25519') throw new Error('only ed25519 is supported');
  const sig = cryptoSign(null, attestationSigningBytes(signed), privateKey);
  return { ...signed, signature: sig.toString('base64url') };
}
