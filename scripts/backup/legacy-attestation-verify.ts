import { type KeyObject, createPublicKey, verify as cryptoVerify } from 'node:crypto';
import {
  type LegacyEnvironment,
  type LegacyEvidenceManifest,
  type LegacyMigrationAttestation,
  type TrustKeyEntry,
  LEGACY_KEY_PURPOSE,
  LEGACY_TREATMENTS,
  legacyAttestationSchema,
  toSignedAttestationPayload,
  trustKeyEntrySchema,
} from './legacy-attestation-schema';
import { attestationSigningBytes, computeEvidenceManifestHash, deriveAttestationId } from './legacy-attestation-canonical';

/**
 * G-Backup-A2 — RUNTIME verifier + validated trust-bundle loader + bundle conflict rules. NEVER imports a signer
 * and exposes NO signing method / private-key type; it only reads PUBLIC keys via `crypto.verify`.
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
  | 'invalid_attestation_id'
  | 'approval_time_invalid';

export type AttestationVerifyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reasonCode: LegacyInvalidReason; readonly reason: string; readonly keyId: string | null };

// -- Validated trust store ----------------------------------------------------

export interface TrustedKey {
  readonly publicKey: KeyObject;
  readonly notBefore: number | null;
  readonly notAfter: number | null;
}
export interface LegacyTrustStore {
  readonly keyring: ReadonlyMap<string, TrustedKey>;
  readonly revoked: ReadonlySet<string>;
}

export type TrustBundleLoad = { readonly ok: true; readonly store: LegacyTrustStore } | { readonly ok: false; readonly reason: string };

/**
 * Validate an ORDERED array of trust-key entries and build an immutable store. Rejects (fail-closed) duplicate
 * key ids, the same id with different key material, a key that is both active and revoked, unknown status,
 * unsupported algorithm, wrong purpose, or malformed public keys — BEFORE any lookup map is built. Object
 * construction can silently overwrite duplicate keys, so a raw record is never trusted; only this loader's output
 * may be passed to the verifier.
 */
export function loadTrustBundle(entries: readonly unknown[]): TrustBundleLoad {
  const active = new Map<string, TrustedKey>();
  const revoked = new Set<string>();
  const seenById = new Map<string, { pem: string; status: string }>();
  for (const raw of entries) {
    const parsed = trustKeyEntrySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: `trust entry schema invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
    const e: TrustKeyEntry = parsed.data;
    if (e.purpose !== LEGACY_KEY_PURPOSE) return { ok: false, reason: `key ${e.keyId} has wrong purpose` };
    const prior = seenById.get(e.keyId);
    if (prior) {
      if (prior.pem !== e.publicKeyPem) return { ok: false, reason: `duplicate keyId ${e.keyId} with different public-key material` };
      if (prior.status !== e.status) return { ok: false, reason: `keyId ${e.keyId} has conflicting status (active and revoked)` };
      return { ok: false, reason: `duplicate keyId ${e.keyId}` };
    }
    seenById.set(e.keyId, { pem: e.publicKeyPem, status: e.status });
    if (e.status === 'revoked') {
      revoked.add(e.keyId);
      continue;
    }
    let key: KeyObject;
    try {
      key = createPublicKey(e.publicKeyPem);
    } catch {
      return { ok: false, reason: `keyId ${e.keyId} has a malformed public key` };
    }
    if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: `keyId ${e.keyId} is not an ed25519 key` };
    active.set(e.keyId, {
      publicKey: key,
      notBefore: e.notBefore ? Date.parse(e.notBefore) : null,
      notAfter: e.notAfter ? Date.parse(e.notAfter) : null,
    });
  }
  // A key that appears active AND revoked anywhere → fail closed.
  for (const id of active.keys()) if (revoked.has(id)) return { ok: false, reason: `keyId ${id} is both active and revoked` };
  return { ok: true, store: { keyring: active, revoked } };
}

// -- Verification -------------------------------------------------------------

export interface AttestationExpectation {
  readonly repositoryId: string;
  readonly applicationId: string;
  readonly environment: LegacyEnvironment;
  readonly migrationNamespace: string;
  readonly migrationPath: string;
  readonly migrationIndex: number;
  readonly migrationTag: string;
  readonly journalTimestamp: number;
  readonly sourceBlobHash: string;
  readonly appliedHash: string;
  readonly supportedVersions: ReadonlySet<string>;
  readonly supportedAlgorithms: ReadonlySet<string>;
  readonly evidenceManifest?: LegacyEvidenceManifest;
  /** Deterministic verification time (supplied; used for approval-time validation). */
  readonly verificationTime: Date;
  readonly maxClockSkewMs?: number;
}

const fail = (reasonCode: LegacyInvalidReason, reason: string, keyId: string | null = null): AttestationVerifyResult => ({ ok: false, reasonCode, reason, keyId });

export function verifyLegacyAttestation(input: unknown, exp: AttestationExpectation, store: LegacyTrustStore): AttestationVerifyResult {
  const parsed = legacyAttestationSchema.safeParse(input);
  if (!parsed.success) return fail('schema_invalid', parsed.error.issues[0]?.message ?? 'invalid');
  const a: LegacyMigrationAttestation = parsed.data;

  if (!exp.supportedVersions.has(a.attestationVersion)) return fail('unsupported_version', `attestationVersion ${a.attestationVersion}`, a.keyId);
  if (!exp.supportedAlgorithms.has(a.signatureAlgorithm)) return fail('unsupported_algorithm', a.signatureAlgorithm, a.keyId);

  // Deterministic identity: the id MUST equal the derived content digest.
  if (a.attestationId !== deriveAttestationId(toSignedAttestationPayload(a))) return fail('invalid_attestation_id', 'attestationId does not match the canonical content digest', a.keyId);

  if (store.revoked.has(a.keyId)) return fail('revoked_key', `keyId ${a.keyId} is revoked`, a.keyId);
  const trusted = store.keyring.get(a.keyId);
  if (!trusted) return fail('unknown_key', `keyId ${a.keyId} is not trusted`, a.keyId);

  let sigOk = false;
  try {
    sigOk = cryptoVerify(null, attestationSigningBytes(toSignedAttestationPayload(a)), trusted.publicKey, Buffer.from(a.signature, 'base64url'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail('invalid_signature', 'signature does not verify', a.keyId);

  // Scope — exact, never wildcard/prefix/case-insensitive.
  if (a.repositoryId !== exp.repositoryId) return fail('scope_mismatch', 'repositoryId', a.keyId);
  if (a.applicationId !== exp.applicationId) return fail('scope_mismatch', 'applicationId', a.keyId);
  if (a.migrationNamespace !== exp.migrationNamespace) return fail('scope_mismatch', 'migrationNamespace', a.keyId);
  if (a.migrationPath !== exp.migrationPath) return fail('scope_mismatch', 'migrationPath', a.keyId);
  if (!a.allowedEnvironments.includes(exp.environment)) return fail('scope_mismatch', `environment ${exp.environment} not allowed`, a.keyId);

  // Runtime binding to the CURRENT source entry (reviewedSourceCommit is provenance, NOT checked here; ancestry
  // is NOT verifiable at runtime and no boolean can assert it — deferred to a signed build-provenance mechanism).
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

  // Approval-time validation.
  const now = exp.verificationTime.getTime();
  const skew = exp.maxClockSkewMs ?? 5 * 60 * 1000;
  const approvedMs = Date.parse(a.approvedAt);
  if (approvedMs > now + skew) return fail('approval_time_invalid', 'approvedAt is materially in the future', a.keyId);
  if (trusted.notBefore != null && approvedMs < trusted.notBefore) return fail('approval_time_invalid', 'approvedAt predates the key notBefore', a.keyId);
  if (trusted.notAfter != null && approvedMs > trusted.notAfter) return fail('approval_time_invalid', 'approvedAt postdates the key notAfter', a.keyId);

  return { ok: true };
}

// -- Trusted-bundle validation (duplicate / conflict, per-environment) --------

export type BundleValidation = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Fail-closed bundle validation (correction 5). Rejects any schema-invalid entry, an attestationId that is not
 * its derived content digest, a duplicate attestationId, a duplicate content digest, and — expanding each
 * attestation's `allowedEnvironments` into effective authorization keys — any two attestations that overlap on
 * the same effective key `(repo, app, namespace, path, index, tag, timestamp, sourceBlob, appliedHash, env)`,
 * regardless of id, key, timestamp, or environment superset. Disjoint environments may coexist. No first/newest/
 * key-priority tie-break.
 */
export function validateAttestationBundle(rawAttestations: readonly unknown[]): BundleValidation {
  const ids = new Set<string>();
  const digests = new Set<string>();
  const effectiveKeys = new Set<string>();
  for (const raw of rawAttestations) {
    const parsed = legacyAttestationSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: `bundle contains a schema-invalid attestation: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
    const a = parsed.data;
    const signed = toSignedAttestationPayload(a);
    const derivedId = deriveAttestationId(signed);
    if (a.attestationId !== derivedId) return { ok: false, reason: `attestation ${a.attestationId} id does not match its content digest` };
    if (ids.has(a.attestationId)) return { ok: false, reason: `duplicate attestationId ${a.attestationId}` };
    ids.add(a.attestationId);
    const digest = derivedId.slice('lma1_'.length);
    if (digests.has(digest)) return { ok: false, reason: 'duplicate attestation content digest' };
    digests.add(digest);
    for (const env of a.allowedEnvironments) {
      const key = `${a.repositoryId} ${a.applicationId} ${a.migrationNamespace} ${a.migrationPath} ${a.migrationIndex} ${a.migrationTag} ${a.journalTimestamp} ${a.sourceBlobHash} ${a.appliedExecutionHash} ${env}`;
      if (effectiveKeys.has(key)) return { ok: false, reason: `conflicting attestations overlap on the same migration+applied-hash+environment (${env})` };
      effectiveKeys.add(key);
    }
  }
  return { ok: true };
}
