import { type KeyObject, verify as cryptoVerify } from 'node:crypto';
import {
  type LegacyEnvironment,
  type LegacyEvidenceManifest,
  type LegacyMigrationAttestation,
  LEGACY_TREATMENTS,
  legacyAttestationSchema,
  toSignedAttestationPayload,
} from './legacy-attestation-schema';
import { attestationSigningBytes, computeEvidenceManifestHash } from './legacy-attestation-canonical';

/**
 * G-Backup-A2 — RUNTIME verifier + trusted-bundle validator. This module must NEVER import a signer and exposes
 * NO signing method or private-key type. It only reads PUBLIC keys (`crypto.verify`). Every failure returns a
 * structured, non-secret reason code; a supplied-but-invalid attestation is explicitly reported (never silently
 * treated as absent) and remains BLOCKED.
 */

export type LegacyInvalidReason =
  | 'schema_invalid'
  | 'unsupported_version'
  | 'unsupported_algorithm'
  | 'unknown_key'
  | 'revoked_key'
  | 'invalid_signature'
  | 'scope_mismatch'
  | 'source_mismatch'
  | 'applied_hash_mismatch'
  | 'evidence_mismatch'
  | 'unsupported_treatment'
  | 'invalid_byte_claim'
  | 'unsafe_assessment'
  | 'ancestry_unverifiable';

export type AttestationVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: LegacyInvalidReason; readonly reason: string; readonly keyId: string | null };

export interface LegacyTrustStore {
  /** keyId → Ed25519 PUBLIC key. Empty in production until an owner key is onboarded via separate authorization. */
  readonly keyring: Readonly<Record<string, KeyObject>>;
  readonly revoked: ReadonlySet<string>;
}

export interface AttestationExpectation {
  // Trusted runtime scope config (never wildcard).
  readonly repositoryId: string;
  readonly applicationId: string;
  readonly environment: LegacyEnvironment;
  readonly migrationNamespace: string;
  readonly migrationPath: string;
  // Current source-manifest entry (runtime binding — NOT the reviewed commit).
  readonly migrationIndex: number;
  readonly migrationTag: string;
  readonly journalTimestamp: number;
  readonly sourceBlobHash: string;
  readonly appliedHash: string;
  readonly supportedVersions: ReadonlySet<string>;
  readonly supportedAlgorithms: ReadonlySet<string>;
  readonly evidenceManifest?: LegacyEvidenceManifest;
  /** Optional producer-side ancestry evidence: reviewedSourceCommit is an ancestor of the deployment commit.
   *  When `requireAncestry` is true and this is not confirmed, verification fails `ancestry_unverifiable`.
   *  The release image may lack `.git`, so this must come from a trusted build manifest, never a runtime claim. */
  readonly requireAncestry?: boolean;
  readonly ancestryConfirmed?: boolean;
}

const fail = (reasonCode: LegacyInvalidReason, reason: string, keyId: string | null = null): AttestationVerifyResult => ({ ok: false, reasonCode, reason, keyId });

export function verifyLegacyAttestation(input: unknown, exp: AttestationExpectation, store: LegacyTrustStore): AttestationVerifyResult {
  const parsed = legacyAttestationSchema.safeParse(input);
  if (!parsed.success) return fail('schema_invalid', parsed.error.issues[0]?.message ?? 'invalid');
  const a: LegacyMigrationAttestation = parsed.data;

  if (!exp.supportedVersions.has(a.attestationVersion)) return fail('unsupported_version', `attestationVersion ${a.attestationVersion}`, a.keyId);
  if (!exp.supportedAlgorithms.has(a.signatureAlgorithm)) return fail('unsupported_algorithm', a.signatureAlgorithm, a.keyId);

  if (store.revoked.has(a.keyId)) return fail('revoked_key', `keyId ${a.keyId} is revoked`, a.keyId);
  const key = store.keyring[a.keyId];
  if (!key) return fail('unknown_key', `keyId ${a.keyId} is not trusted`, a.keyId);

  let sigOk = false;
  try {
    sigOk = cryptoVerify(null, attestationSigningBytes(toSignedAttestationPayload(a)), key, Buffer.from(a.signature, 'base64url'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail('invalid_signature', 'signature does not verify', a.keyId);

  // Scope — exact, never wildcard.
  if (a.repositoryId !== exp.repositoryId) return fail('scope_mismatch', 'repositoryId', a.keyId);
  if (a.applicationId !== exp.applicationId) return fail('scope_mismatch', 'applicationId', a.keyId);
  if (a.migrationNamespace !== exp.migrationNamespace) return fail('scope_mismatch', 'migrationNamespace', a.keyId);
  if (a.migrationPath !== exp.migrationPath) return fail('scope_mismatch', 'migrationPath', a.keyId);
  if (!a.allowedEnvironments.includes(exp.environment)) return fail('scope_mismatch', `environment ${exp.environment} not in allowedEnvironments`, a.keyId);

  // Runtime binding to the CURRENT source entry (reviewedSourceCommit is provenance, NOT checked here).
  if (a.migrationIndex !== exp.migrationIndex) return fail('scope_mismatch', 'migrationIndex', a.keyId);
  if (a.migrationTag !== exp.migrationTag) return fail('scope_mismatch', 'migrationTag', a.keyId);
  if (a.journalTimestamp !== exp.journalTimestamp) return fail('scope_mismatch', 'journalTimestamp', a.keyId);
  if (a.sourceBlobHash !== exp.sourceBlobHash) return fail('source_mismatch', 'current source blob differs from attested sourceBlobHash', a.keyId);
  if (a.appliedExecutionHash !== exp.appliedHash) return fail('applied_hash_mismatch', 'applied hash differs', a.keyId);

  if (exp.evidenceManifest && computeEvidenceManifestHash(exp.evidenceManifest) !== a.evidenceManifestHash) {
    return fail('evidence_mismatch', 'evidenceManifestHash does not match the supplied manifest', a.keyId);
  }

  if (!LEGACY_TREATMENTS.includes(a.approvedTreatment)) return fail('unsupported_treatment', a.approvedTreatment, a.keyId);
  if (a.approverRole.trim().length === 0 || a.approverId.trim().length === 0) return fail('scope_mismatch', 'missing approval identity', a.keyId);

  if (a.differenceType !== 'eol_only') return fail('invalid_byte_claim', 'unsupported differenceType', a.keyId);
  if (a.deletedByteCount !== 0 || a.substitutedByteCount !== 0) return fail('invalid_byte_claim', 'deleted/substituted must be 0', a.keyId);
  if (a.insertedByteCount !== a.insertedCrBeforeLfCount) return fail('invalid_byte_claim', 'inserted bytes must all be CR-before-LF', a.keyId);
  if (a.appliedByteLength !== a.sourceByteLength + a.insertedByteCount) return fail('invalid_byte_claim', 'lengths inconsistent', a.keyId);
  if (a.changedLineIndexes.length !== a.insertedCrBeforeLfCount) return fail('invalid_byte_claim', 'changed-line count mismatch', a.keyId);

  if (a.sqlContextAssessment !== 'outside_sensitive_content') return fail('unsafe_assessment', 'sqlContextAssessment not outside_sensitive_content', a.keyId);
  if (a.databaseEffectAssessment !== 'local_staging_agree') return fail('unsafe_assessment', 'databaseEffectAssessment not local_staging_agree', a.keyId);

  if (exp.requireAncestry && !exp.ancestryConfirmed) return fail('ancestry_unverifiable', 'reviewedSourceCommit ancestry not confirmed by a trusted build manifest', a.keyId);

  return { ok: true };
}

// -- Trusted-bundle validation (duplicate / conflict rules) -------------------

export type BundleValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Fail-closed bundle validation (correction 5). Rejects duplicate attestationId, more than one attestation for
 * the same (repositoryId, applicationId, migrationTag, appliedExecutionHash) scope (regardless of key), and any
 * schema-invalid entry. `attestationId` uniqueness is enforced; two entries sharing an id are rejected even if
 * identical (fail-closed — no "first file wins").
 */
export function validateAttestationBundle(rawAttestations: readonly unknown[]): BundleValidation {
  const ids = new Set<string>();
  const scopeKeys = new Set<string>();
  for (const raw of rawAttestations) {
    const parsed = legacyAttestationSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: `bundle contains a schema-invalid attestation: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
    const a = parsed.data;
    if (ids.has(a.attestationId)) return { ok: false, reason: `duplicate attestationId ${a.attestationId}` };
    ids.add(a.attestationId);
    const scope = `${a.repositoryId} ${a.applicationId} ${a.migrationTag} ${a.appliedExecutionHash}`;
    if (scopeKeys.has(scope)) return { ok: false, reason: `conflicting/duplicate attestations for the same repository/application/migration/applied-hash scope` };
    scopeKeys.add(scope);
  }
  return { ok: true };
}
