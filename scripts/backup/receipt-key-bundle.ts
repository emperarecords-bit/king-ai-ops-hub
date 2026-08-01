import { type KeyObject, createHash, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { isCanonicalUtcTimestamp } from './receipt-v2-encoding';

/**
 * G-Backup-B1 correction — deployment-receipt key trust bundle. A DEPLOYMENT-RECEIPT key must be distinct in
 * PURPOSE from a legacy migration-attestation key. Duplicate detection is by CANONICAL cryptographic identity (the
 * DER-SubjectPublicKeyInfo SHA-256 fingerprint), never PEM text, so the same key under a second id is rejected even
 * across line-wrapping / CRLF-vs-LF / trailing-whitespace / alternate PEM spellings. Private-key input is rejected
 * explicitly (createPublicKey would otherwise DERIVE a public key from a private PEM). The store retains the parsed
 * public key + fingerprint so verification never reinterprets ambiguous text.
 */

export const RECEIPT_KEY_PURPOSE = 'deployment_backup_receipt' as const;
export const RECEIPT_KEY_ALGORITHMS = ['ed25519'] as const;
/** DER SubjectPublicKeyInfo length for an Ed25519 public key (12-byte prefix + 32-byte key). */
export const ED25519_SPKI_DER_LEN = 44;

const Ident = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const CanonicalUtc = z.string().refine(isCanonicalUtcTimestamp, 'must be a canonical UTC timestamp');

export const receiptKeyEntrySchema = z
  .object({
    keyId: Ident,
    algorithm: z.enum(RECEIPT_KEY_ALGORITHMS),
    publicKeyPem: z.string().min(1).max(4096),
    purpose: z.literal(RECEIPT_KEY_PURPOSE),
    status: z.enum(['active', 'revoked', 'inactive']),
    notBefore: CanonicalUtc.optional(),
    notAfter: CanonicalUtc.optional(),
  })
  .strict();
export type ReceiptKeyEntry = z.infer<typeof receiptKeyEntrySchema>;

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
export type ReceiptKeyBundleLoad = { readonly ok: true; readonly store: ReceiptKeyStore } | { readonly ok: false; readonly reason: string };

const PRIVATE_KEY_MARKER = 'PRIVATE KEY';

export function loadReceiptKeyBundle(entries: readonly unknown[]): ReceiptKeyBundleLoad {
  const active = new Map<string, TrustedReceiptKeyEntry>();
  const revoked = new Set<string>();
  const inactive = new Set<string>();
  const diagnostics: ReceiptKeyDiagnostic[] = [];
  const seenById = new Map<string, { pem: string; status: string }>();
  const fingerprintToId = new Map<string, string>();
  for (const raw of entries) {
    const parsed = receiptKeyEntrySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: `receipt key entry schema invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
    const e = parsed.data;
    if (e.purpose !== RECEIPT_KEY_PURPOSE) return { ok: false, reason: `key ${e.keyId} has wrong purpose` };
    if (e.publicKeyPem.includes(PRIVATE_KEY_MARKER)) return { ok: false, reason: `key ${e.keyId} supplied private-key material` };

    const prior = seenById.get(e.keyId);
    if (prior) {
      if (prior.pem !== e.publicKeyPem) return { ok: false, reason: `duplicate keyId ${e.keyId} with different public-key material` };
      if (prior.status !== e.status) return { ok: false, reason: `keyId ${e.keyId} has conflicting status` };
      return { ok: false, reason: `duplicate keyId ${e.keyId}` };
    }
    seenById.set(e.keyId, { pem: e.publicKeyPem, status: e.status });

    let key: KeyObject;
    try {
      key = createPublicKey(e.publicKeyPem);
    } catch {
      return { ok: false, reason: `keyId ${e.keyId} has a malformed public key` };
    }
    if (key.type !== 'public') return { ok: false, reason: `keyId ${e.keyId} is not a public key` };
    if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: `keyId ${e.keyId} actual key type is not ${e.algorithm}` };
    const der = key.export({ type: 'spki', format: 'der' });
    if (der.length !== ED25519_SPKI_DER_LEN) return { ok: false, reason: `keyId ${e.keyId} has an unexpected DER-SPKI length ${der.length}` };
    const fingerprint = createHash('sha256').update(der).digest('hex');

    const otherId = fingerprintToId.get(fingerprint);
    if (otherId && otherId !== e.keyId) return { ok: false, reason: `public key already trusted under a different keyId (${otherId})` };
    fingerprintToId.set(fingerprint, e.keyId);

    const nb = e.notBefore ? Date.parse(e.notBefore) : null;
    const na = e.notAfter ? Date.parse(e.notAfter) : null;
    if (nb != null && na != null && !(nb < na)) return { ok: false, reason: `keyId ${e.keyId} has notBefore >= notAfter` };

    diagnostics.push({ keyId: e.keyId, purpose: e.purpose, status: e.status, derSpkiByteLength: der.length, fingerprintSha256: fingerprint, notBefore: e.notBefore ?? null, notAfter: e.notAfter ?? null });
    if (e.status === 'revoked') { revoked.add(e.keyId); continue; }
    if (e.status === 'inactive') { inactive.add(e.keyId); continue; }
    active.set(e.keyId, { publicKey: key, fingerprintSha256: fingerprint, notBefore: nb, notAfter: na });
  }
  for (const id of active.keys()) if (revoked.has(id) || inactive.has(id)) return { ok: false, reason: `keyId ${id} has conflicting status` };
  return { ok: true, store: { keyring: active, revoked, inactive, diagnostics } };
}
