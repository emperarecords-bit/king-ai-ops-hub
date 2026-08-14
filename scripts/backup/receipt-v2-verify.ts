import { verify as cryptoVerify } from 'node:crypto';
import {
  type PendingMigrationEntry,
  type ReceiptV2,
  type ReceiptV2Environment,
  receiptV2Schema,
  toSignedReceiptV2,
  validatePendingMigrationsCanonical,
} from './receipt-v2-schema';
import { deriveReceiptV2Id, receiptV2CanonicalHash, receiptV2SigningBytes } from './receipt-v2-canonical';
import { isCanonicalEd25519SignatureB64Url } from './receipt-v2-encoding';
import {
  type NormalizedProviderEvidence,
  CANONICAL_SNAPSHOT_COMPLETE,
  FLY_VOLUMES_PROVIDER,
  PROVIDER_RAW_STATUS_CREATED,
  computeNormalizedProviderEvidenceDigest,
} from './provider-fly-volumes';
import { type ReceiptKeyStore } from './receipt-key-bundle';
import { parseStrictJsonBuffer } from './strict-json';

/**
 * G-Backup-B1 — RUNTIME receipt-v2 verifier. Verify-only. Time is derived from ONE authoritative input,
 * `migrationStartedAt`, plus the signed receipt timestamps — no independent host clock. The signed
 * `targetImageDigest` is CONTROLLER-established evidence covered by the signature and is NOT re-resolved at runtime.
 */

export type ReceiptV2FailCode =
  | 'json_invalid'
  | 'schema_invalid'
  | 'canonicalization_error'
  | 'receipt_id_mismatch'
  | 'unknown_key'
  | 'revoked_key'
  | 'inactive_key'
  | 'not_yet_valid_at_receipt'
  | 'not_yet_valid_at_migration'
  | 'expired_at_receipt'
  | 'expired_at_migration'
  | 'unsupported_version'
  | 'unsupported_algorithm'
  | 'invalid_signature'
  | 'environment_mismatch'
  | 'application_mismatch'
  | 'nonce_mismatch'
  | 'image_ref_mismatch'
  | 'source_commit_mismatch'
  | 'migration_set_mismatch'
  | 'pending_migration_mismatch'
  | 'db_identity_mismatch'
  | 'provider_evidence_invalid'
  | 'snapshot_time_invalid'
  | 'receipt_expired'
  | 'production_rejected';

export interface ImageTrustDiagnostics {
  readonly image_ref_verified_runtime: boolean;
  readonly image_digest_verified_controller: boolean;
  readonly image_digest_signed_but_not_runtime_observable: boolean;
}

export type ReceiptV2VerifyResult =
  | { readonly ok: true; readonly receiptCanonicalHash: string; readonly imageTrust: ImageTrustDiagnostics }
  | { readonly ok: false; readonly step: number; readonly code: ReceiptV2FailCode; readonly detail: string };

export interface ReceiptV2Expectation {
  readonly environment: ReceiptV2Environment;
  /**
   * Gate 3 (owner-approved 2026-08-14): production receipts verify ONLY when the verifying side EXPLICITLY opts
   * in. Absent/false (every pre-Gate-3 caller) preserves the original hard exclusion, and the environment-equality
   * check (step 8) still requires the expectation itself to be production — two independent switches, both
   * explicit, before a production receipt can pass.
   */
  readonly allowProductionEnvironment?: boolean;
  readonly targetApplication: string;
  readonly databaseApp: string;
  readonly sourceVolumeId: string;
  readonly databaseSystemIdentifier: string;
  readonly snapshotProvider: typeof FLY_VOLUMES_PROVIDER;
  readonly providerAdapterVersion: string;
  readonly minRetentionDays: number;
  readonly maxSnapshotAgeMs: number;
  readonly sourceCommit: string;
  /** Runtime-observed image reference (FLY_IMAGE_REF). Digest is NOT re-resolved at runtime. */
  readonly targetImageRef: string;
  readonly deploymentNonce: string;
  readonly portableMigrationSetHash: string;
  readonly runtimeMigrationSetHash: string;
  /** The exact canonical pending-migration entries recomputed by the release (strictly-increasing index). */
  readonly pendingMigrations: readonly PendingMigrationEntry[];
  /** The SINGLE authoritative time (DDL start). All time checks derive from this + signed timestamps. */
  readonly migrationStartedAt: Date;
  readonly supportedSchemaVersions: ReadonlySet<string>;
  readonly supportedAlgorithms: ReadonlySet<string>;
  readonly keyStore: ReceiptKeyStore;
}

const fail = (step: number, code: ReceiptV2FailCode, detail: string): ReceiptV2VerifyResult => ({ ok: false, step, code, detail });

/** Element-wise equality in the given (canonical) order — NO sorting. */
function equalPending(a: readonly PendingMigrationEntry[], b: readonly PendingMigrationEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.migrationIndex !== y.migrationIndex || x.migrationTag !== y.migrationTag || x.migrationPath !== y.migrationPath || x.byteLength !== y.byteLength || x.sha256 !== y.sha256) return false;
  }
  return true;
}

const IMAGE_TRUST: ImageTrustDiagnostics = { image_ref_verified_runtime: true, image_digest_verified_controller: false, image_digest_signed_but_not_runtime_observable: true };

export function verifyReceiptV2Parsed(input: unknown, exp: ReceiptV2Expectation): ReceiptV2VerifyResult {
  // 3. schema (canonical encodings + pending canonical order + discovery-evidence shape enforced here)
  const parsed = receiptV2Schema.safeParse(input);
  if (!parsed.success) return fail(3, 'schema_invalid', parsed.error.issues[0]?.message ?? 'invalid');
  const r: ReceiptV2 = parsed.data;

  // 4. canonicalization + version
  let signingBytes: Buffer;
  let canonicalHash: string;
  try {
    const signed = toSignedReceiptV2(r);
    signingBytes = receiptV2SigningBytes(signed);
    canonicalHash = receiptV2CanonicalHash(signed);
  } catch (e) {
    return fail(4, 'canonicalization_error', e instanceof Error ? e.message : 'canonicalization failed');
  }
  if (!exp.supportedSchemaVersions.has(r.schemaVersion)) return fail(4, 'unsupported_version', r.schemaVersion);
  if (!exp.supportedAlgorithms.has(r.signatureAlgorithm)) return fail(6, 'unsupported_algorithm', r.signatureAlgorithm);

  // 5. derived receipt-id
  if (deriveReceiptV2Id(toSignedReceiptV2(r)) !== r.receiptId) return fail(5, 'receipt_id_mismatch', 'receiptId != derived');

  // 6. key lookup + policy (distinct codes; all times from migrationStartedAt + signed receiptCreatedAt)
  if (exp.keyStore.revoked.has(r.keyId)) return fail(6, 'revoked_key', 'key revoked');
  if (exp.keyStore.inactive.has(r.keyId)) return fail(6, 'inactive_key', 'key inactive');
  const key = exp.keyStore.keyring.get(r.keyId);
  if (!key) return fail(6, 'unknown_key', 'keyId not a trusted deployment-receipt key');
  const createdMs = Date.parse(r.receiptCreatedAt);
  const migStart = exp.migrationStartedAt.getTime();
  if (key.notBefore != null && createdMs < key.notBefore) return fail(6, 'not_yet_valid_at_receipt', 'receiptCreatedAt precedes key notBefore');
  if (key.notBefore != null && migStart < key.notBefore) return fail(6, 'not_yet_valid_at_migration', 'migrationStartedAt precedes key notBefore');
  if (key.notAfter != null && createdMs >= key.notAfter) return fail(6, 'expired_at_receipt', 'receiptCreatedAt at/after key notAfter');
  if (key.notAfter != null && migStart >= key.notAfter) return fail(6, 'expired_at_migration', 'migrationStartedAt at/after key notAfter');

  // 7. Ed25519 signature (canonical encoding + cryptographic validity)
  if (!isCanonicalEd25519SignatureB64Url(r.signature)) return fail(7, 'invalid_signature', 'noncanonical signature encoding');
  let sigOk = false;
  try {
    sigOk = cryptoVerify(null, signingBytes, key.publicKey, Buffer.from(r.signature, 'base64url'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return fail(7, 'invalid_signature', 'signature does not verify');

  // 8. environment + application
  if (r.environment !== exp.environment) return fail(8, 'environment_mismatch', 'environment');
  if (r.targetApplication !== exp.targetApplication) return fail(8, 'application_mismatch', 'targetApplication');

  // 9. deployment nonce
  if (r.deploymentNonce !== exp.deploymentNonce) return fail(9, 'nonce_mismatch', 'deploymentNonce');

  // 10. image REFERENCE only (runtime-observable). Digest is controller evidence, covered by the signature.
  if (r.targetImageRef !== exp.targetImageRef) return fail(10, 'image_ref_mismatch', 'targetImageRef');

  // 11. source commit
  if (r.sourceCommit !== exp.sourceCommit) return fail(11, 'source_commit_mismatch', 'sourceCommit');

  // 12. runtime + portable migration-set (distinct)
  if (r.runtimeMigrationSetHash !== exp.runtimeMigrationSetHash) return fail(12, 'migration_set_mismatch', 'runtimeMigrationSetHash');
  if (r.portableMigrationSetHash !== exp.portableMigrationSetHash) return fail(12, 'migration_set_mismatch', 'portableMigrationSetHash');

  // 13. exact canonical pending migrations (no reorder ambiguity — element-wise equality in canonical order)
  const canon = validatePendingMigrationsCanonical(r.pendingMigrations);
  if (!canon.ok) return fail(13, 'pending_migration_mismatch', canon.reason);
  if (!equalPending(r.pendingMigrations, exp.pendingMigrations)) return fail(13, 'pending_migration_mismatch', 'pendingMigrations');

  // 14. db app / volume / system identifier (all distinct)
  if (r.databaseApp !== exp.databaseApp) return fail(14, 'db_identity_mismatch', 'databaseApp');
  if (r.sourceVolumeId !== exp.sourceVolumeId) return fail(14, 'db_identity_mismatch', 'sourceVolumeId');
  if (r.databaseSystemIdentifier !== exp.databaseSystemIdentifier) return fail(14, 'db_identity_mismatch', 'databaseSystemIdentifier');

  // 15. provider evidence + discovery audit + digest over signed normalized fields
  if (r.snapshotProvider !== exp.snapshotProvider) return fail(15, 'provider_evidence_invalid', 'snapshotProvider');
  if (r.providerAdapterVersion !== exp.providerAdapterVersion) return fail(15, 'provider_evidence_invalid', 'providerAdapterVersion');
  if (r.providerSnapshotStatus !== PROVIDER_RAW_STATUS_CREATED) return fail(15, 'provider_evidence_invalid', 'providerSnapshotStatus');
  if (r.canonicalSnapshotStatus !== CANONICAL_SNAPSHOT_COMPLETE) return fail(15, 'provider_evidence_invalid', 'canonicalSnapshotStatus');
  if (r.retentionDays < exp.minRetentionDays) return fail(15, 'provider_evidence_invalid', 'retentionDays below minimum');
  const ev = r.snapshotDiscoveryEvidence;
  if (r.snapshotDiscoveryMethod === 'create-response-id') {
    if (ev.createResponseSnapshotId !== ev.listedSnapshotId || ev.listedSnapshotId !== r.snapshotId) return fail(15, 'provider_evidence_invalid', 'create-response discovery mismatch');
  } else {
    if (ev.candidateCount !== 1 || ev.selectedCandidateId !== r.snapshotId) return fail(15, 'provider_evidence_invalid', 'list-diff discovery mismatch');
  }
  const evidence: NormalizedProviderEvidence = {
    snapshotProvider: FLY_VOLUMES_PROVIDER,
    providerAdapterVersion: r.providerAdapterVersion,
    snapshotDiscoveryMethod: r.snapshotDiscoveryMethod,
    snapshotDiscoveryEvidence: ev as NormalizedProviderEvidence['snapshotDiscoveryEvidence'],
    snapshotId: r.snapshotId,
    sourceVolumeId: r.sourceVolumeId,
    databaseApp: r.databaseApp,
    providerSnapshotStatus: r.providerSnapshotStatus,
    canonicalSnapshotStatus: CANONICAL_SNAPSHOT_COMPLETE,
    snapshotRequestedAt: r.snapshotRequestedAt,
    snapshotCreatedAt: r.snapshotCreatedAt,
    providerObservedAt: r.providerObservedAt,
    retentionDays: r.retentionDays,
    storedSizeBytes: r.storedSizeBytes,
  };
  if (computeNormalizedProviderEvidenceDigest(evidence) !== r.normalizedProviderEvidenceDigest) return fail(15, 'provider_evidence_invalid', 'normalizedProviderEvidenceDigest');

  // 16. strict timeline (all relative to the authoritative migrationStartedAt + signed timestamps)
  const req = Date.parse(r.snapshotRequestedAt);
  const created = Date.parse(r.snapshotCreatedAt);
  const observed = Date.parse(r.providerObservedAt);
  const expires = Date.parse(r.expiresAt);
  if (!(req <= created)) return fail(16, 'snapshot_time_invalid', 'snapshotRequestedAt after snapshotCreatedAt');
  if (!(created <= observed)) return fail(16, 'snapshot_time_invalid', 'snapshotCreatedAt after providerObservedAt');
  if (!(observed <= createdMs)) return fail(16, 'snapshot_time_invalid', 'providerObservedAt after receiptCreatedAt');
  if (!(createdMs <= migStart)) return fail(16, 'snapshot_time_invalid', 'receiptCreatedAt after migrationStartedAt');
  if (!(created < migStart)) return fail(16, 'snapshot_time_invalid', 'snapshot did not predate migration start');
  if (migStart - created > exp.maxSnapshotAgeMs) return fail(16, 'snapshot_time_invalid', 'snapshot older than the freshness window');

  // 17. receipt expiry relative to migration execution
  if (!(migStart < expires)) return fail(17, 'receipt_expired', 'receipt expired at migration start');

  // 18. production policy — excluded unless the verifying side explicitly opted in (Gate 3).
  if (r.environment === 'production' && exp.allowProductionEnvironment !== true) {
    return fail(18, 'production_rejected', 'production is excluded by policy');
  }

  return { ok: true, receiptCanonicalHash: canonicalHash, imageTrust: IMAGE_TRUST };
}

export function verifyReceiptV2Bytes(buf: Buffer, exp: ReceiptV2Expectation): ReceiptV2VerifyResult {
  let parsed: unknown;
  try {
    parsed = parseStrictJsonBuffer(buf);
  } catch (e) {
    return fail(2, 'json_invalid', e instanceof Error ? e.message : 'invalid JSON');
  }
  return verifyReceiptV2Parsed(parsed, exp);
}
