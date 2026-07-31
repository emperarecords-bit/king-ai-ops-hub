import { canonicalizeV1 } from '@/lib/canonical';
import { type SignedReceipt } from './receipt-schema';

/**
 * G-Backup-A — canonical receipt serialization. The signature covers the version-prefixed canonical form of the
 * signed payload (all receipt fields EXCEPT `signature`). Reuses the accepted P1a canonicalizer (`canonicalizeV1`):
 * NFC, deterministic Unicode code-point key ordering, arrays as ordered sequences. Domain-separated + versioned
 * so a receipt signature can never be confused with any other signed artifact.
 */

export const RECEIPT_SIGN_DOMAIN = 'gbackup-receipt/v1\n' as const;

/** Deterministic canonical string of the signed payload (excludes `signature`). */
export function canonicalReceiptString(signed: SignedReceipt): string {
  // `pendingMigrations` is an ORDERED sequence (not a set) — canonicalizeV1 preserves array order by default.
  return canonicalizeV1(signed);
}

/** The exact bytes that are signed / verified: domain tag + canonical signed payload. */
export function receiptSigningBytes(signed: SignedReceipt): Buffer {
  return Buffer.from(RECEIPT_SIGN_DOMAIN + canonicalReceiptString(signed), 'utf8');
}
