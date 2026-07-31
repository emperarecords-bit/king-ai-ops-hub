import { z } from 'zod';

/**
 * G-Backup-A — deployment-backup receipt contract with constrained field content (correction 5).
 *
 * Signatures are Ed25519-asymmetric: the producer (outside the release container) signs; the release process
 * verifies with a public key and cannot mint. `.strict()` blocks unknown fields, and each field carries a
 * bounded character set / length so a database URL, bearer token, PEM private key, multiline value, or control
 * character cannot be smuggled into an allowed string field. This is STRUCTURAL + PATTERN-BASED protection — it
 * does not prove no secret can ever be embedded, but it rejects every representative form.
 *
 * `migrationSetHash` MEANS the portable `sourceMigrationSetHash` (Git-blob-derived, OS-stable) — never the
 * working-tree drizzle execution hash.
 */

export const RECEIPT_VERSIONS = ['1'] as const;
export const SIGNATURE_ALGORITHMS = ['ed25519'] as const;
export const RECEIPT_ENVIRONMENTS = ['staging', 'production'] as const;

// Bounded identifier/name: alphanumerics + a few safe separators. Excludes ':' '/' '@' space newline control,
// so credential URIs (`postgres://u:p@h`), PEM (`-----BEGIN ...`), and `Bearer <t>` are rejected by construction.
const Ident = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/, 'must be a bounded safe identifier');
const LowerToken = z.string().min(1).max(32).regex(/^[a-z_]+$/, 'must be a lowercase token');
const HexCommit = z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/, 'must be a git commit hex (40 or 64)');
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 hex');
const Nonce = z.string().min(16).max(128).regex(/^[A-Za-z0-9_-]+$/, 'must be bounded high-entropy base64url/hex');
// Ed25519 signature is 64 bytes → 86 base64url chars (no padding).
const SignatureB64Url = z.string().min(80).max(120).regex(/^[A-Za-z0-9_-]+$/, 'must be base64url');
const MigrationTag = z.string().min(1).max(128).regex(/^[0-9]{4}_[a-z0-9_]+$/, 'must be a drizzle migration tag');
const IsoTimestamp = z
  .string()
  .max(40)
  .regex(/^[0-9T:.\-+Z]+$/, 'must be a normalized ISO timestamp')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'must be a valid timestamp');

/** Fields covered by the signature (everything except `signature`). */
export const signedReceiptSchema = z
  .object({
    receiptVersion: z.enum(RECEIPT_VERSIONS),
    environment: z.enum(RECEIPT_ENVIRONMENTS),
    databaseApp: Ident,
    volumeId: Ident,
    snapshotId: Ident,
    snapshotStatus: LowerToken,
    snapshotCreatedAt: IsoTimestamp,
    receiptCreatedAt: IsoTimestamp,
    expiresAt: IsoTimestamp,
    sourceCommit: HexCommit,
    sourceRelease: Ident,
    targetApplication: Ident,
    pendingMigrations: z.array(MigrationTag).max(1000),
    migrationSetHash: Sha256Hex,
    deploymentNonce: Nonce,
    verificationResult: LowerToken,
    signatureAlgorithm: z.enum(SIGNATURE_ALGORITHMS),
    keyId: Ident,
  })
  .strict();

export type SignedReceipt = z.infer<typeof signedReceiptSchema>;

export const receiptSchema = signedReceiptSchema.extend({ signature: SignatureB64Url }).strict();
export type BackupReceipt = z.infer<typeof receiptSchema>;

export const SIGNED_FIELD_NAMES: readonly (keyof SignedReceipt)[] = [
  'receiptVersion',
  'environment',
  'databaseApp',
  'volumeId',
  'snapshotId',
  'snapshotStatus',
  'snapshotCreatedAt',
  'receiptCreatedAt',
  'expiresAt',
  'sourceCommit',
  'sourceRelease',
  'targetApplication',
  'pendingMigrations',
  'migrationSetHash',
  'deploymentNonce',
  'verificationResult',
  'signatureAlgorithm',
  'keyId',
];

export function toSignedPayload(receipt: BackupReceipt): SignedReceipt {
  const { signature: _signature, ...signed } = receipt;
  void _signature;
  return signed;
}
