import { z } from 'zod';

/**
 * G-Backup-B1 — deployment-receipt contract VERSION 2 (added in PARALLEL to v1; v1 is untouched).
 *
 * v2 binds the full non-circular deployment identity: environment/app/db-app/volume/PostgreSQL system id, the
 * fly-volumes provider evidence (raw + canonical status + digest), source commit, image REF and DIGEST (distinct),
 * deployment nonce, BOTH migration-set hashes (portable git-blob + runtime baked-file), the exact pending
 * migration entries with byte digests, and time policy. The Fly release number is intentionally excluded from the
 * trust decision (`priorReleaseVersion` is optional audit metadata only). `.strict()` + bounded field patterns
 * reject credential URIs, PEM, bearer tokens, multiline, and control characters structurally.
 */

export const RECEIPT_V2_SCHEMA_VERSION = '2' as const;
export const RECEIPT_V2_CANONICALIZATION_VERSION = 1 as const;
export const RECEIPT_V2_ALGORITHMS = ['ed25519'] as const;
export const RECEIPT_V2_ENVIRONMENTS = ['staging', 'production'] as const;
export type ReceiptV2Environment = (typeof RECEIPT_V2_ENVIRONMENTS)[number];

const Ident = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const LowerToken = z.string().min(1).max(32).regex(/^[a-z_]+$/);
const HexCommit = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const VolumeId = z.string().min(3).max(64).regex(/^vol_[A-Za-z0-9]+$/);
const SnapshotId = z.string().min(3).max(64).regex(/^vs_[A-Za-z0-9]+$/);
/** PostgreSQL control-file system identifier: a 64-bit decimal (pg_control_system().system_identifier). */
const PgSystemId = z.string().regex(/^[0-9]{1,20}$/, 'must be a decimal PostgreSQL system identifier');
/** Deterministic receipt id derived from the canonical unsigned payload. */
const ReceiptId = z.string().regex(/^rcpt2_[0-9a-f]{64}$/);
/** 128-bit nonce as unpadded base64url (22 chars) OR lowercase hex (32 chars) — exact length only. */
const DeploymentNonce = z.string().regex(/^(?:[0-9a-f]{32}|[A-Za-z0-9_-]{22})$/, 'must be a 128-bit base64url(22) or hex(32) nonce');
/** OCI image digest. */
const ImageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
/** A registry image reference, e.g. registry.fly.io/app:deployment-XXXX (no whitespace/control). */
const ImageRef = z.string().min(3).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/, 'must be a registry image reference');
const MigrationTag = z.string().min(1).max(128).regex(/^[0-9]{4}_[a-z0-9_]+$/);
const MigrationPath = z.string().min(1).max(256).regex(/^[A-Za-z0-9._/-]+$/);
const Ed25519SignatureB64Url = z.string().min(80).max(120).regex(/^[A-Za-z0-9_-]+$/);
const IsoUtc = z
  .string()
  .max(40)
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/, 'must be normalized UTC (…Z)')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'invalid timestamp');
const Uint = z.number().int().nonnegative();

export const pendingMigrationEntrySchema = z
  .object({
    migrationIndex: Uint,
    migrationTag: MigrationTag,
    migrationPath: MigrationPath,
    byteLength: Uint,
    sha256: Sha256Hex,
  })
  .strict();
export type PendingMigrationEntry = z.infer<typeof pendingMigrationEntrySchema>;

/** The SIGNED payload (everything except `signature`). `receiptId` is part of the signed payload but is derived
 *  from the canonical form of the payload EXCLUDING `receiptId` itself (see receipt-v2-canonical). */
export const signedReceiptV2Schema = z
  .object({
    schemaVersion: z.literal(RECEIPT_V2_SCHEMA_VERSION),
    canonicalizationVersion: z.literal(RECEIPT_V2_CANONICALIZATION_VERSION),
    receiptId: ReceiptId,
    // scope
    environment: z.enum(RECEIPT_V2_ENVIRONMENTS),
    targetApplication: Ident,
    databaseApp: Ident,
    sourceVolumeId: VolumeId,
    databaseSystemIdentifier: PgSystemId,
    // provider evidence (raw + canonical + digest)
    snapshotProvider: z.literal('fly-volumes'),
    providerSnapshotStatus: LowerToken,
    canonicalSnapshotStatus: z.literal('complete'),
    snapshotId: SnapshotId,
    snapshotCreatedAt: IsoUtc,
    providerObservedAt: IsoUtc,
    retentionDays: Uint,
    storedSizeBytes: Uint.nullable(),
    providerEvidenceCanonicalDigest: Sha256Hex,
    providerAdapterVersion: Ident,
    // deployment identity
    sourceCommit: HexCommit,
    targetImageRef: ImageRef,
    targetImageDigest: ImageDigest,
    deploymentNonce: DeploymentNonce,
    // migration identity (portable git-blob hash + runtime baked-file hash kept DISTINCT)
    portableMigrationSetHash: Sha256Hex,
    runtimeMigrationSetHash: Sha256Hex,
    pendingMigrations: z.array(pendingMigrationEntrySchema).min(1).max(1000),
    // time policy
    receiptCreatedAt: IsoUtc,
    expiresAt: IsoUtc,
    // key
    signatureAlgorithm: z.enum(RECEIPT_V2_ALGORITHMS),
    keyId: Ident,
    // OPTIONAL audit-only; never affects validity
    priorReleaseVersion: Ident.optional(),
  })
  .strict();
export type SignedReceiptV2 = z.infer<typeof signedReceiptV2Schema>;

export const receiptV2Schema = signedReceiptV2Schema.extend({ signature: Ed25519SignatureB64Url }).strict();
export type ReceiptV2 = z.infer<typeof receiptV2Schema>;

export function toSignedReceiptV2(receipt: ReceiptV2): SignedReceiptV2 {
  const { signature: _sig, ...signed } = receipt;
  void _sig;
  return signed;
}
