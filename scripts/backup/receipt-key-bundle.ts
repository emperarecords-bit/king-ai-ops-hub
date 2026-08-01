import { type KeyObject, createHash, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { isCanonicalUtcTimestamp } from './receipt-v2-encoding';

/**
 * G-Backup-B1 correction — deployment-receipt key trust bundle. A DEPLOYMENT-RECEIPT key must be distinct in
 * PURPOSE from a legacy migration-attestation key. Duplicate detection is by CANONICAL cryptographic identity (the
 * DER-SubjectPublicKeyInfo SHA-256 fingerprint), never PEM text, so the same key under a second id is rejected even
 * across line-wrapping / CRLF-vs-LF / trailing-whitespace / alternate PEM spellings.
 *
 * Every rejection returns a STABLE STRUCTURED CODE (never a generic exception, never PEM contents). Private-key
 * input is rejected FIRST, before any parse could derive a public key from a private container — for ALL private
 * PEM spellings (PKCS#8, encrypted PKCS#8, PKCS#1 RSA, SEC1 EC, OpenSSH), each of which carries the `PRIVATE KEY`
 * banner. The store retains the parsed public key + fingerprint so verification never reinterprets ambiguous text.
 */

export const RECEIPT_KEY_PURPOSE = 'deployment_backup_receipt' as const;
export const RECEIPT_KEY_ALGORITHMS = ['ed25519'] as const;
/** DER SubjectPublicKeyInfo length for an Ed25519 public key (12-byte prefix + 32-byte key). */
export const ED25519_SPKI_DER_LEN = 44;
/** Substring common to EVERY private-key PEM banner: PKCS#8, ENCRYPTED PKCS#8, RSA (PKCS#1), EC (SEC1), OPENSSH. */
export const PRIVATE_KEY_MARKER = 'PRIVATE KEY';

const Ident = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const CanonicalUtc = z.string().refine(isCanonicalUtcTimestamp, 'must be a canonical UTC timestamp');

// `purpose` and `algorithm` are parsed as free strings so a WRONG value yields a distinct structured code
// (`wrong_key_purpose` / `wrong_key_algorithm`) rather than collapsing into a generic `schema_invalid`.
export const receiptKeyEntrySchema = z
  .object({
    keyId: Ident,
    algorithm: z.string().min(1).max(32),
    publicKeyPem: z.string().min(1).max(4096),
    purpose: z.string().min(1).max(64),
    status: z.enum(['active', 'revoked', 'inactive']),
    notBefore: CanonicalUtc.optional(),
    notAfter: CanonicalUtc.optional(),
  })
  .strict();
export type ReceiptKeyEntry = z.infer<typeof receiptKeyEntrySchema>;

export type ReceiptKeyLoadFailCode =
  | 'schema_invalid'
  | 'wrong_key_purpose'
  | 'wrong_key_algorithm'
  | 'wrong_key_type'
  | 'malformed_public_key'
  | 'private_key_material_rejected'
  | 'duplicate_key_id'
  | 'duplicate_key_fingerprint'
  | 'invalid_validity_window';

export interface TrustedReceiptKeyEntry {
  readonly publicKey: KeyObject;
  readonly fingerprintSha256: string;
  readonly notBefore: number | null;
  readonly notAfter: number | null;
}
export interface ReceiptKeyDiagnostic {
  readonly keyId: string;
  readonly purpose: string;
  readonly status: string;
  readonly derSpkiByteLength: number;
  readonly fingerprintSha256: string;
  readonly notBefore: string | null;
  readonly notAfter: string | null;
}
export interface ReceiptKeyStore {
  readonly keyring: ReadonlyMap<string, TrustedReceiptKeyEntry>;
  readonly revoked: ReadonlySet<string>;
  readonly inactive: ReadonlySet<string>;
  readonly diagnostics: readonly ReceiptKeyDiagnostic[];
}
export type ReceiptKeyBundleLoad =
  | { readonly ok: true; readonly store: ReceiptKeyStore }
  | { readonly ok: false; readonly code: ReceiptKeyLoadFailCode; readonly keyId: string | null };

const failCode = (code: ReceiptKeyLoadFailCode, keyId: string | null): ReceiptKeyBundleLoad => ({ ok: false, code, keyId });

export function loadReceiptKeyBundle(entries: readonly unknown[]): ReceiptKeyBundleLoad {
  const active = new Map<string, TrustedReceiptKeyEntry>();
  const revoked = new Set<string>();
  const inactive = new Set<string>();
  const diagnostics: ReceiptKeyDiagnostic[] = [];
  const seenIds = new Set<string>();
  const fingerprintToId = new Map<string, string>();
  for (const raw of entries) {
    const parsed = receiptKeyEntrySchema.safeParse(raw);
    if (!parsed.success) return failCode('schema_invalid', null);
    const e = parsed.data;

    // Reject private-key containers BEFORE any parse could derive a public key from them (all PEM spellings).
    if (e.publicKeyPem.includes(PRIVATE_KEY_MARKER)) return failCode('private_key_material_rejected', e.keyId);
    if (e.purpose !== RECEIPT_KEY_PURPOSE) return failCode('wrong_key_purpose', e.keyId);
    if (!(RECEIPT_KEY_ALGORITHMS as readonly string[]).includes(e.algorithm)) return failCode('wrong_key_algorithm', e.keyId);
    if (seenIds.has(e.keyId)) return failCode('duplicate_key_id', e.keyId);
    seenIds.add(e.keyId);

    let key: KeyObject;
    try {
      key = createPublicKey(e.publicKeyPem);
    } catch {
      return failCode('malformed_public_key', e.keyId);
    }
    if (key.type !== 'public') return failCode('malformed_public_key', e.keyId);
    if (key.asymmetricKeyType !== 'ed25519') return failCode('wrong_key_type', e.keyId);
    const der = key.export({ type: 'spki', format: 'der' });
    if (der.length !== ED25519_SPKI_DER_LEN) return failCode('malformed_public_key', e.keyId);
    const fingerprint = createHash('sha256').update(der).digest('hex');

    const otherId = fingerprintToId.get(fingerprint);
    if (otherId && otherId !== e.keyId) return failCode('duplicate_key_fingerprint', e.keyId);
    fingerprintToId.set(fingerprint, e.keyId);

    const nb = e.notBefore ? Date.parse(e.notBefore) : null;
    const na = e.notAfter ? Date.parse(e.notAfter) : null;
    if (nb != null && na != null && !(nb < na)) return failCode('invalid_validity_window', e.keyId);

    diagnostics.push({ keyId: e.keyId, purpose: e.purpose, status: e.status, derSpkiByteLength: der.length, fingerprintSha256: fingerprint, notBefore: e.notBefore ?? null, notAfter: e.notAfter ?? null });
    if (e.status === 'revoked') { revoked.add(e.keyId); continue; }
    if (e.status === 'inactive') { inactive.add(e.keyId); continue; }
    active.set(e.keyId, { publicKey: key, fingerprintSha256: fingerprint, notBefore: nb, notAfter: na });
  }
  return { ok: true, store: { keyring: active, revoked, inactive, diagnostics } };
}
