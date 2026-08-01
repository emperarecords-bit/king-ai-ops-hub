import { type KeyObject, sign as cryptoSign } from 'node:crypto';
import { type ReceiptV2, type SignedReceiptV2 } from './receipt-v2-schema';
import { receiptV2SigningBytes } from './receipt-v2-canonical';

/**
 * G-Backup-B1 — OFFLINE / TEST receipt-v2 signer. This is the ONLY v2 module that takes a PRIVATE key. It must NOT
 * be imported by the runtime verifier, the transport, the detector, or `scripts/migrate.ts` (a static import-
 * boundary test enforces that). In production the external deployment controller signs offline with a key that
 * never reaches the release/application Machines; this exists for tests (ephemeral keys) and a producer utility.
 */
export function signReceiptV2(signed: SignedReceiptV2, privateKey: KeyObject): ReceiptV2 {
  if (signed.signatureAlgorithm !== 'ed25519') throw new Error('only ed25519 is supported');
  const sig = cryptoSign(null, receiptV2SigningBytes(signed), privateKey);
  return { ...signed, signature: sig.toString('base64url') };
}
