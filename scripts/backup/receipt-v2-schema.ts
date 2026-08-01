import { z } from 'zod';
import {
  isCanonicalDeploymentNonce,
  isCanonicalEd25519SignatureB64Url,
  isCanonicalRepoPath,
  isCanonicalUtcTimestamp,
  isNonZeroCanonicalUint64Decimal,
} from './receipt-v2-encoding';

/**
 * G-Backup-B1 — deployment-receipt contract VERSION 2 (parallel to v1; v1 untouched). Encodings are CANONICAL,
 * `pendingMigrations` has exactly one canonical representation (strictly-increasing index; unique tag/path; NFC
 * POSIX paths), the PostgreSQL system id is a NONZERO canonical uint64, and the snapshot-discovery evidence is
 * bound to its method.
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
const PgSystemId = z.string().refine(isNonZeroCanonicalUint64Decimal, 'must be a NONZERO canonical unsigned-64-bit PostgreSQL system identifier');
const ReceiptId = z.string().regex(/^rcpt2_[0-9a-f]{64}$/);
const DeploymentNonce = z.string().refine(isCanonicalDeploymentNonce, 'must be a canonical 128-bit nonce');
const ImageDigest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const ImageRef = z.string().min(3).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/, 'must be a registry image reference');
const MigrationTag = z.string().min(1).max(128).regex(/^[0-9]{4}_[a-z0-9_]+$/);
const MigrationPath = z.string().refine(isCanonicalRepoPath, 'must be a canonical repo-relative POSIX path (NFC)');
const SafeUint = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Ed25519SignatureB64Url = z.string().refine(isCanonicalEd25519SignatureB64Url, 'must be a canonical unpadded base64url Ed25519 signature');
const CanonicalUtc = z.string().refine(isCanonicalUtcTimestamp, 'must be a canonical UTC timestamp (YYYY-MM-DDTHH:mm:ss.sssZ)');
const Uint = z.number().int().nonnegative();

export const pendingMigrationEntrySchema = z
  .object({ migrationIndex: SafeUint, migrationTag: MigrationTag, migrationPath: MigrationPath, byteLength: SafeUint, sha256: Sha256Hex })
  .strict();
export type PendingMigrationEntry = z.infer<typeof pendingMigrationEntrySchema>;

/** Strictly-increasing index (⇒ canonical order + unique index), unique tag, unique path. */
export function validatePendingMigrationsCanonical(entries: readonly PendingMigrationEntry[]): { ok: true } | { ok: false; reason: string } {
  const tags = new Set<string>();
  const paths = new Set<string>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    if (i > 0 && !(entries[i - 1]!.migrationIndex < e.migrationIndex)) return { ok: false, reason: 'pendingMigrations not in strictly-increasing index order' };
    if (tags.has(e.migrationTag)) return { ok: false, reason: `duplicate migrationTag ${e.migrationTag}` };
    if (paths.has(e.migrationPath)) return { ok: false, reason: `duplicate migrationPath ${e.migrationPath}` };
    tags.add(e.migrationTag);
    paths.add(e.migrationPath);
  }
  return { ok: true };
}

const pendingMigrationsSchema = z
  .array(pendingMigrationEntrySchema)
  .min(1)
  .max(1000)
  .superRefine((arr, ctx) => {
    const v = validatePendingMigrationsCanonical(arr);
    if (!v.ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message: v.reason });
  });

const snapshotDiscoveryEvidenceSchema = z
  .object({
    createResponseSnapshotId: SnapshotId.optional(),
    listedSnapshotId: SnapshotId.optional(),
    preRequestSetDigest: Sha256Hex.optional(),
    postRequestSetDigest: Sha256Hex.optional(),
    candidateCount: Uint.optional(),
    selectedCandidateId: SnapshotId.optional(),
  })
  .strict();

const baseShape = {
  schemaVersion: z.literal(RECEIPT_V2_SCHEMA_VERSION),
  canonicalizationVersion: z.literal(RECEIPT_V2_CANONICALIZATION_VERSION),
  receiptId: ReceiptId,
  environment: z.enum(RECEIPT_V2_ENVIRONMENTS),
  targetApplication: Ident,
  databaseApp: Ident,
  sourceVolumeId: VolumeId,
  databaseSystemIdentifier: PgSystemId,
  snapshotProvider: z.literal('fly-volumes'),
  providerSnapshotStatus: LowerToken,
  canonicalSnapshotStatus: z.literal('complete'),
  snapshotDiscoveryMethod: z.enum(SNAPSHOT_DISCOVERY_METHODS),
  snapshotDiscoveryEvidence: snapshotDiscoveryEvidenceSchema,
  snapshotId: SnapshotId,
  snapshotRequestedAt: CanonicalUtc,
  snapshotCreatedAt: CanonicalUtc,
  providerObservedAt: CanonicalUtc,
  retentionDays: Uint,
  storedSizeBytes: Uint.nullable(),
  normalizedProviderEvidenceDigest: Sha256Hex,
  rawProviderResponseSha256: Sha256Hex.optional(),
  providerAdapterVersion: Ident,
  sourceCommit: HexCommit,
  targetImageRef: ImageRef,
  targetImageDigest: ImageDigest,
  deploymentNonce: DeploymentNonce,
  portableMigrationSetHash: Sha256Hex,
  runtimeMigrationSetHash: Sha256Hex,
  pendingMigrations: pendingMigrationsSchema,
  receiptCreatedAt: CanonicalUtc,
  expiresAt: CanonicalUtc,
  signatureAlgorithm: z.enum(RECEIPT_V2_ALGORITHMS),
  keyId: Ident,
  priorReleaseVersion: Ident.optional(),
} as const;

function discoveryRefine(r: { snapshotDiscoveryMethod: string; snapshotDiscoveryEvidence: z.infer<typeof snapshotDiscoveryEvidenceSchema> }, ctx: z.RefinementCtx): void {
  const ev = r.snapshotDiscoveryEvidence;
  if (r.snapshotDiscoveryMethod === 'create-response-id') {
    if (ev.createResponseSnapshotId === undefined || ev.listedSnapshotId === undefined || ev.preRequestSetDigest !== undefined || ev.postRequestSetDigest !== undefined || ev.candidateCount !== undefined || ev.selectedCandidateId !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'create-response-id evidence must carry exactly createResponseSnapshotId + listedSnapshotId' });
    }
  } else if (ev.preRequestSetDigest === undefined || ev.postRequestSetDigest === undefined || ev.candidateCount === undefined || ev.selectedCandidateId === undefined || ev.createResponseSnapshotId !== undefined || ev.listedSnapshotId !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unambiguous-list-diff evidence must carry pre/post digests + candidateCount + selectedCandidateId' });
  }
}

export const signedReceiptV2Schema = z.object(baseShape).strict().superRefine(discoveryRefine);
export type SignedReceiptV2 = z.infer<typeof signedReceiptV2Schema>;

export const receiptV2Schema = z.object({ ...baseShape, signature: Ed25519SignatureB64Url }).strict().superRefine(discoveryRefine);
export type ReceiptV2 = z.infer<typeof receiptV2Schema>;

export function toSignedReceiptV2(receipt: ReceiptV2): SignedReceiptV2 {
  const { signature: _sig, ...signed } = receipt;
  void _sig;
  return signed;
}
