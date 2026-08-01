import { type KeyObject, verify as cryptoVerify } from 'node:crypto';
import {
  type PendingMigrationEntry,
  type ReceiptV2,
  type ReceiptV2Environment,
  receiptV2Schema,
  toSignedReceiptV2,
} from './receipt-v2-schema';
import { deriveReceiptV2Id, receiptV2CanonicalHash, receiptV2SigningBytes } from './receipt-v2-canonical';
import {
  type NormalizedProviderEvidence,
  CANONICAL_SNAPSHOT_COMPLETE,
  FLY_VOLUMES_PROVIDER,
  PROVIDER_RAW_STATUS_CREATED,
  computeProviderEvidenceDigest,
} from './provider-fly-volumes';
import { parseStrictJsonBuffer } from './strict-json';

/**
 * G-Backup-B1 — RUNTIME receipt-v2 verifier. Verify-only: no private key, no signer import, no Fly/DB/network
 * access. Fails closed in the exact authorized order and returns a STRUCTURED failure code + step number without
 * exposing receipt contents.
 */

export type ReceiptV2FailCode =
  | 'json_invalid'
  | 'schema_invalid'
  | 'canonicalization_error'
  | 'receipt_id_mismatch'
  | 'unknown_key'
  | 'key_policy'
  | 'unsupported_version'
  | 'unsupported_algorithm'
  | 'invalid_signature'
  | 'environment_mismatch'
  | 'application_mismatch'
  | 'nonce_mismatch'
  | 'image_ref_mismatch'
  | 'image_digest_mismatch'
  | 'source_commit_mismatch'
  | 'migration_set_mismatch'
  | 'pending_migration_mismatch'
  | 'db_identity_mismatch'
  | 'provider_evidence_invalid'
  | 'snapshot_time_invalid'
  | 'receipt_expired'
  | 'production_rejected';

export type ReceiptV2VerifyResult =
  | { readonly ok: true; readonly receiptCanonicalHash: string }
  | { readonly ok: false; readonly step: number; readonly code: ReceiptV2FailCode; readonly detail: string };

export interface TrustedReceiptKey {
  readonly publicKey: KeyObject;
  readonly notBefore?: number | null;
  readonly notAfter?: number | null;
}

export interface ReceiptV2Expectation {
  readonly environment: ReceiptV2Environment;
  readonly targetApplication: string;
  readonly databaseApp: string;
  readonly sourceVolumeId: string;
  /** PostgreSQL system identifier queried read-only from the target DB before DDL (a fixture in B1). */
  readonly databaseSystemIdentifier: string;
  readonly snapshotProvider: typeof FLY_VOLUMES_PROVIDER;
  readonly providerAdapterVersion: string;
  readonly minRetentionDays: number;
  readonly maxSnapshotAgeMs: number;
  readonly sourceCommit: string;
  /** Runtime-observed image reference (FLY_IMAGE_REF). */
  readonly targetImageRef: string;
  /** Externally-established image digest baked at build time (evidence, not runtime-resolved). */
  readonly expectedImageDigest: string;
  /** The deployment nonce the release Machine reads from its baked non-secret artifact. */
  readonly deploymentNonce: string;
  /** Portable git-blob migration-set hash baked at build (the release cannot recompute it without `.git`). */
  readonly portableMigrationSetHash: string;
  /** Runtime migration-set hash recomputed by the release from the baked migration files. */
  readonly runtimeMigrationSetHash: string;
  /** The exact pending-migration entries recomputed by the release. */
  readonly pendingMigrations: readonly PendingMigrationEntry[];
  readonly verificationTime: Date;
  readonly migrationStartedAt: Date;
  readonly maxClockSkewMs?: number;
  readonly supportedSchemaVersions: ReadonlySet<string>;
  readonly supportedAlgorithms: ReadonlySet<string>;
  readonly keyring: ReadonlyMap<string, TrustedReceiptKey>;
}

const fail = (step: number, code: ReceiptV2FailCode, detail: string): ReceiptV2VerifyResult => ({ ok: false, step, code, detail });

function samePending(a: readonly PendingMigrationEntry[], b: readonly PendingMigrationEntry[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort((x, y) => x.migrationIndex - y.migrationIndex);
  const sb = [...b].sort((x, y) => x.migrationIndex - y.migrationIndex);
  for (let i = 0; i < sa.length; i++) {
    const x = sa[i]!;
    const y = sb[i]!;
    if (x.migrationIndex !== y.migrationIndex || x.migrationTag !== y.migrationTag || x.migrationPath !== y.migrationPath || x.byteLength !== y.byteLength || x.sha256 !== y.sha256) return false;
  }
  return true;
}

/** Verify a parsed (unknown) receipt object — steps 3–18. */
export function verifyReceiptV2Parsed(input: unknown, exp: ReceiptV2Expectation): ReceiptV2VerifyResult {
  // 3. schema
  const parsed = receiptV2Schema.safeParse(input);
  if (!parsed.success) return fail(3, 'schema_invalid', parsed.error.issues[0]?.message ?? 'invalid');
  const r: ReceiptV2 = parsed.data;

  // 4. canonicalization (must not throw)
  let signingBytes: Buffer;
  let canonicalHash: string;
  try {
    const signed = toSignedReceiptV2(r);
    signingBytes = receiptV2SigningBytes(signed);
    canonicalHash = receiptV2CanonicalHash(signed);
  } catch (e) {
    return fail(4, 'canonicalization_error', e instanceof Error ? e.message : 'canonicalization failed');
  }

  // version + algorithm supported (part of key/version policy)
  if (!exp.supportedSchemaVersions.has(r.schemaVersion)) return fail(4, 'unsupported_version', r.schemaVersion);
  if (!exp.supportedAlgorithms.has(r.signatureAlgorithm)) return fail(6, 'unsupported_algorithm', r.signatureAlgorithm);

  // 5. derived receipt-id
  if (deriveReceiptV2Id(toSignedReceiptV2(r)) !== r.receiptId) return fail(5, 'receipt_id_mismatch', 'receiptId != derived');

  // 6. key lookup + policy
  const key = exp.keyring.get(r.keyId);
  if (!key) return fail(6, 'unknown_key', 'keyId not trusted');
  const createdMs = Date.parse(r.receiptCreatedAt);
  if (key.notBefore != null && createdMs < key.notBefore) return fail(6, 'key_policy', 'receiptCreatedAt precedes key notBefore');
  if (key.notAfter != null && createdMs > key.notAfter) return fail(6, 'key_policy', 'receiptCreatedAt postdates key notAfter');

  // 7. Ed25519 signature
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

  // 10. image ref + digest
  if (r.targetImageRef !== exp.targetImageRef) return fail(10, 'image_ref_mismatch', 'targetImageRef');
  if (r.targetImageDigest !== exp.expectedImageDigest) return fail(10, 'image_digest_mismatch', 'targetImageDigest');

  // 11. source commit
  if (r.sourceCommit !== exp.sourceCommit) return fail(11, 'source_commit_mismatch', 'sourceCommit');

  // 12. runtime + portable migration-set
  if (r.runtimeMigrationSetHash !== exp.runtimeMigrationSetHash) return fail(12, 'migration_set_mismatch', 'runtimeMigrationSetHash');
  if (r.portableMigrationSetHash !== exp.portableMigrationSetHash) return fail(12, 'migration_set_mismatch', 'portableMigrationSetHash');

  // 13. exact pending migrations
  if (!samePending(r.pendingMigrations, exp.pendingMigrations)) return fail(13, 'pending_migration_mismatch', 'pendingMigrations');

  // 14. db app / volume / system identifier (all three distinct)
  if (r.databaseApp !== exp.databaseApp) return fail(14, 'db_identity_mismatch', 'databaseApp');
  if (r.sourceVolumeId !== exp.sourceVolumeId) return fail(14, 'db_identity_mismatch', 'sourceVolumeId');
  if (r.databaseSystemIdentifier !== exp.databaseSystemIdentifier) return fail(14, 'db_identity_mismatch', 'databaseSystemIdentifier');

  // 15. provider evidence
  if (r.snapshotProvider !== exp.snapshotProvider) return fail(15, 'provider_evidence_invalid', 'snapshotProvider');
  if (r.providerAdapterVersion !== exp.providerAdapterVersion) return fail(15, 'provider_evidence_invalid', 'providerAdapterVersion');
  if (r.providerSnapshotStatus !== PROVIDER_RAW_STATUS_CREATED) return fail(15, 'provider_evidence_invalid', 'providerSnapshotStatus');
  if (r.canonicalSnapshotStatus !== CANONICAL_SNAPSHOT_COMPLETE) return fail(15, 'provider_evidence_invalid', 'canonicalSnapshotStatus');
  if (r.retentionDays < exp.minRetentionDays) return fail(15, 'provider_evidence_invalid', 'retentionDays below minimum');
  const snapCreated = Date.parse(r.snapshotCreatedAt);
  const observed = Date.parse(r.providerObservedAt);
  if (observed < snapCreated) return fail(15, 'provider_evidence_invalid', 'providerObservedAt precedes snapshotCreatedAt');
  const skew = exp.maxClockSkewMs ?? 5 * 60 * 1000;
  if (observed > exp.verificationTime.getTime() + skew) return fail(15, 'provider_evidence_invalid', 'providerObservedAt in the future');
  const evidence: NormalizedProviderEvidence = {
    snapshotProvider: FLY_VOLUMES_PROVIDER,
    providerAdapterVersion: r.providerAdapterVersion,
    snapshotId: r.snapshotId,
    sourceVolumeId: r.sourceVolumeId,
    databaseApp: r.databaseApp,
    providerSnapshotStatus: r.providerSnapshotStatus,
    canonicalSnapshotStatus: CANONICAL_SNAPSHOT_COMPLETE,
    snapshotCreatedAt: r.snapshotCreatedAt,
    providerObservedAt: r.providerObservedAt,
    retentionDays: r.retentionDays,
    storedSizeBytes: r.storedSizeBytes,
  };
  if (computeProviderEvidenceDigest(evidence) !== r.providerEvidenceCanonicalDigest) return fail(15, 'provider_evidence_invalid', 'providerEvidenceCanonicalDigest');

  // 16. snapshot age + timestamps
  const migStart = exp.migrationStartedAt.getTime();
  if (snapCreated >= migStart) return fail(16, 'snapshot_time_invalid', 'snapshot did not predate migration start');
  if (migStart - snapCreated > exp.maxSnapshotAgeMs) return fail(16, 'snapshot_time_invalid', 'snapshot older than the freshness window');

  // 17. receipt expiration
  const now = exp.verificationTime.getTime();
  if (createdMs > now + skew) return fail(17, 'receipt_expired', 'receiptCreatedAt in the future');
  if (Date.parse(r.expiresAt) <= now) return fail(17, 'receipt_expired', 'receipt expired');

  // 18. production policy
  if (r.environment === 'production') return fail(18, 'production_rejected', 'production is excluded by policy');

  return { ok: true, receiptCanonicalHash: canonicalHash };
}

/** Verify raw receipt BYTES (step 2 strict JSON parse, then 3–18). */
export function verifyReceiptV2Bytes(buf: Buffer, exp: ReceiptV2Expectation): ReceiptV2VerifyResult {
  let parsed: unknown;
  try {
    parsed = parseStrictJsonBuffer(buf);
  } catch (e) {
    return fail(2, 'json_invalid', e instanceof Error ? e.message : 'invalid JSON');
  }
  return verifyReceiptV2Parsed(parsed, exp);
}
