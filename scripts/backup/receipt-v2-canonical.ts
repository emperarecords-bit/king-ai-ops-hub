import { createHash } from 'node:crypto';
import { canonicalizeV1 } from '@/lib/canonical';
import { type SignedReceiptV2 } from './receipt-v2-schema';
import { isCanonicalDeploymentNonce } from './receipt-v2-encoding';

/**
 * G-Backup-B1 — v2 canonicalization, deterministic receipt-id derivation, and signing bytes. Domain-separated and
 * versioned so a v2 receipt signature can never be confused with a v1 receipt, a legacy attestation, or any other
 * signed artifact. Reuses the accepted `canonicalizeV1` (NFC, code-point key order, arrays as ordered sequences).
 */

export const RECEIPT_V2_SIGN_DOMAIN = 'gbackup-receipt/v2\n' as const;
export const RECEIPT_V2_ID_DOMAIN = 'gbackup-receipt-id/v2\n' as const;

/** Canonical string of the signed payload EXCLUDING `receiptId` — the identity basis. */
export function receiptV2IdContentString(signed: SignedReceiptV2): string {
  const { receiptId: _id, ...rest } = signed;
  void _id;
  return canonicalizeV1(rest);
}

/** Deterministic receipt id = `rcpt2_<sha256(id-domain + canonical payload minus receiptId)>`. */
export function deriveReceiptV2Id(signed: SignedReceiptV2): string {
  const digest = createHash('sha256').update(RECEIPT_V2_ID_DOMAIN, 'utf8').update(receiptV2IdContentString(signed), 'utf8').digest('hex');
  return `rcpt2_${digest}`;
}

/** Set `receiptId` to its derived value (producer/test helper; pure). */
export function finalizeReceiptV2Id(signed: SignedReceiptV2): SignedReceiptV2 {
  return { ...signed, receiptId: deriveReceiptV2Id(signed) };
}

/** The exact bytes signed/verified: sign-domain + canonical signed payload (INCLUDING the derived receiptId). */
export function receiptV2SigningBytes(signed: SignedReceiptV2): Buffer {
  return Buffer.from(RECEIPT_V2_SIGN_DOMAIN + canonicalizeV1(signed), 'utf8');
}

/** The canonical hash of the full signed payload, exposed for audit (NOT the trust anchor). */
export function receiptV2CanonicalHash(signed: SignedReceiptV2): string {
  return createHash('sha256').update(RECEIPT_V2_SIGN_DOMAIN, 'utf8').update(canonicalizeV1(signed), 'utf8').digest('hex');
}

/** 128-bit deployment nonce — CANONICAL base64url(22) or lowercase hex(32) (see receipt-v2-encoding). */
export function isValidDeploymentNonce(s: unknown): s is string {
  return isCanonicalDeploymentNonce(s);
}
