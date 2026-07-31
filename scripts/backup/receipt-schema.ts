import { z } from 'zod';

/**
 * G-Backup-A — deployment-backup receipt contract. A receipt attests that a verified managed snapshot exists
 * for a specific deployment. It is produced OUTSIDE the release container (G-Backup-B) by a holder of the
 * Ed25519 PRIVATE key; the release process holds only the PUBLIC key and can VERIFY but never MINT one.
 *
 * The schema is `.strict()`, so the receipt can carry ONLY the fields below — it is structurally impossible to
 * include a database URL, password, token, private key, or customer/project data.
 */

export const RECEIPT_VERSIONS = ['1'] as const;
export const SIGNATURE_ALGORITHMS = ['ed25519'] as const;
export const RECEIPT_ENVIRONMENTS = ['staging', 'production'] as const;

const IsoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO-8601 timestamp');
const Hex = z.string().regex(/^[0-9a-f]+$/, 'must be lowercase hex');
const NonEmpty = z.string().min(1);

/** Fields that are covered by the signature (everything except `signature`). */
export const signedReceiptSchema = z
  .object({
    receiptVersion: z.enum(RECEIPT_VERSIONS),
    environment: z.enum(RECEIPT_ENVIRONMENTS),
    databaseApp: NonEmpty,
    volumeId: NonEmpty,
    snapshotId: NonEmpty,
    snapshotStatus: NonEmpty,
    snapshotCreatedAt: IsoDate,
    receiptCreatedAt: IsoDate,
    expiresAt: IsoDate,
    sourceCommit: NonEmpty,
    sourceRelease: NonEmpty,
    targetApplication: NonEmpty,
    pendingMigrations: z.array(NonEmpty),
    migrationSetHash: Hex,
    deploymentNonce: NonEmpty,
    verificationResult: NonEmpty,
    signatureAlgorithm: z.enum(SIGNATURE_ALGORITHMS),
    keyId: NonEmpty,
  })
  .strict();

export type SignedReceipt = z.infer<typeof signedReceiptSchema>;

/** The full receipt = signed fields + the detached signature (base64url). */
export const receiptSchema = signedReceiptSchema
  .extend({ signature: NonEmpty })
  .strict();

export type BackupReceipt = z.infer<typeof receiptSchema>;

/** The exact ordered field list covered by the signature (for documentation + canonicalization reference). */
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

/** Strip the signature to obtain the signed payload object. */
export function toSignedPayload(receipt: BackupReceipt): SignedReceipt {
  const { signature: _signature, ...signed } = receipt;
  void _signature;
  return signed;
}
