import { z } from 'zod';
import {
  isCanonicalDeploymentNonce,
  isCanonicalEd25519SignatureB64Url,
  isCanonicalUint64Decimal,
  isCanonicalUtcTimestamp,
} from './receipt-v2-encoding';

/**
 * G-Backup-B1 — deployment-receipt contract VERSION 2 (added in PARALLEL to v1; v1 is untouched).
 *
 * v2 binds the full non-circular deployment identity + provider-evidence timeline. Encodings are CANONICAL
 * (base64url values round-trip; timestamps are exactly `YYYY-MM-DDTHH:mm:ss.sssZ`; the PostgreSQL system id is a
 * canonical unsigned-64-bit decimal). The Fly release number is excluded from the trust decision
 * (`priorReleaseVersion` is optional audit metadata). `.strict()` + bounded patterns reject credential URIs, PEM,
 * bearer tokens, multiline, and control characters.
 */

export const RECEIPT_V2_SCHEMA_VERSION = '2' as const;
export const RECEIPT_V2_CANONICALIZATION_VERSION = 1 as const;
export const RECEIPT_V2_ALGORITHMS = ['ed25519'] as const;
export const RECEIPT_V2_ENVIRONMENTS = ['staging', 'production'] as const;
export const SNAPSHOT_DISCOVERY_METHODS = ['create-response-id', 'unambiguous-list-diff'] as const;
export type ReceiptV2Environment = (typeof RECEIPT_V2_ENVIRONMENTS)[number];
export type SnapshotDiscoveryMethod = (typeof SNAPSHOT_DISCOVERY_METHODS)[number];

const Ident = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const LowerToken = z.string().min(1).max(32).regex(/^[a-z_]+$/);
const HexCommit = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const VolumeId = z.string().min(3).max(64).regex(/^vol_[A-Za-z0-9]+$/);
const SnapshotId = z.string().min(3).max(64).regex(/^vs_[A-Za-z0-9]+$/);
const PgSystemId = z.string().refine(isCanonicalUint64Decimal, 'must be a canonical unsigned-64-bit decimal PostgreSQL system identifier');
const ReceiptId = z.string().regex(/^rcpt2_[0-9a-f]{64}$/);
const DeploymentNonce = z.string().refine(isCanonicalDeploymentNonce, 'must be a canonical 128-bit base64url(22) or hex(32) nonce');
const ImageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ImageRef = z.string().min(3).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/, 'must be a registry image reference');
const MigrationTag = z.string().min(1).max(128).regex(/^[0-9]{4}_[a-z0-9_]+$/);
const MigrationPath = z.string().min(1).max(256).regex(/^[A-Za-z0-9._/-]+$/);
const Ed25519SignatureB64Url = z.string().refine(isCanonicalEd25519SignatureB64Url, 'must be a canonical unpadded base64url Ed25519 signature');
const CanonicalUtc = z.string().refine(isCanonicalUtcTimestamp, 'must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
const Uint = z.number().int().nonnegative();

export const pendingMigrationEntrySchema = z
  .object({ migrationIndex: Uint, migrationTag: MigrationTag, migrationPath: MigrationPath, byteLength: Uint, sha256: Sha256Hex })
  .strict();
export type PendingMigrationEntry = z.infer<typeof pendingMigrationEntrySchema>;

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
    // provider evidence (raw + canonical status + normalized-fields digest + discovery)
    snapshotProvider: z.literal('fly-volumes'),
    providerSnapshotStatus: LowerToken,
    canonicalSnapshotStatus: z.literal('complete'),
    snapshotDiscoveryMethod: z.enum(SNAPSHOT_DISCOVERY_METHODS),
    snapshotId: SnapshotId,
    snapshotRequestedAt: CanonicalUtc,
    snapshotCreatedAt: CanonicalUtc,
    providerObservedAt: CanonicalUtc,
    retentionDays: Uint,
    storedSizeBytes: Uint.nullable(),
    normalizedProviderEvidenceDigest: Sha256Hex,
    /** OPTIONAL audit-only raw provider response digest — NOT part of the trust decision. */
    rawProviderResponseSha256: Sha256Hex.optional(),
    providerAdapterVersion: Ident,
    // deployment identity
    sourceCommit: HexCommit,
    targetImageRef: ImageRef,
    /** Controller-established evidence, covered by the signature; NOT independently re-resolved at runtime. */
    targetImageDigest: ImageDigest,
    deploymentNonce: DeploymentNonce,
    // migration identity (portable git-blob hash + runtime baked-file hash kept DISTINCT)
    portableMigrationSetHash: Sha256Hex,
    runtimeMigrationSetHash: Sha256Hex,
    pendingMigrations: z.array(pendingMigrationEntrySchema).min(1).max(1000),
    // time policy
    receiptCreatedAt: CanonicalUtc,
    expiresAt: CanonicalUtc,
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
