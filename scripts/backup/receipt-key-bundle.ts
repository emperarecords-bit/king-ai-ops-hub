import { type KeyObject, createPublicKey } from 'node:crypto';
import { z } from 'zod';
import { isCanonicalUtcTimestamp } from './receipt-v2-encoding';

/**
 * G-Backup-B1 correction — deployment-receipt key trust bundle. A DEPLOYMENT-RECEIPT key must be distinct in
 * PURPOSE from a legacy migration-attestation key: an Ed25519 key that is merely active is NOT acceptable. This
 * loader validates an ordered key array and builds an immutable store, failing closed (like the legacy loader) on
 * duplicate ids, same id / different material, active+revoked conflict, wrong purpose, wrong algorithm, malformed
 * key, or the same public-key material introduced under a second (unauthorized) id.
 */

export const RECEIPT_KEY_PURPOSE = 'deployment_backup_receipt' as const;
export const RECEIPT_KEY_ALGORITHMS = ['ed25519'] as const;

const Ident = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/);
const CanonicalUtc = z.string().refine(isCanonicalUtcTimestamp, 'must be a canonical UTC timestamp');

export const receiptKeyEntrySchema = z
  .object({
    keyId: Ident,
    algorithm: z.enum(RECEIPT_KEY_ALGORITHMS),
    publicKeyPem: z.string().min(1).max(4096),
    purpose: z.literal(RECEIPT_KEY_PURPOSE),
    status: z.enum(['active', 'revoked']),
    notBefore: CanonicalUtc.optional(),
    notAfter: CanonicalUtc.optional(),
  })
  .strict();
export type ReceiptKeyEntry = z.infer<typeof receiptKeyEntrySchema>;

export interface TrustedReceiptKeyEntry {
  readonly publicKey: KeyObject;
  readonly notBefore: number | null;
  readonly notAfter: number | null;
}
export interface ReceiptKeyStore {
  readonly keyring: ReadonlyMap<string, TrustedReceiptKeyEntry>;
  readonly revoked: ReadonlySet<string>;
}
export type ReceiptKeyBundleLoad = { readonly ok: true; readonly store: ReceiptKeyStore } | { readonly ok: false; readonly reason: string };

/** Canonical SPKI-DER of a public key, for same-material detection under a different id. */
function derFingerprint(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function loadReceiptKeyBundle(entries: readonly unknown[]): ReceiptKeyBundleLoad {
  const active = new Map<string, TrustedReceiptKeyEntry>();
  const revoked = new Set<string>();
  const seenById = new Map<string, { pem: string; status: string }>();
  const materialToId = new Map<string, string>();
  for (const raw of entries) {
    const parsed = receiptKeyEntrySchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: `receipt key entry schema invalid: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
    const e = parsed.data;
    if (e.purpose !== RECEIPT_KEY_PURPOSE) return { ok: false, reason: `key ${e.keyId} has wrong purpose` };
    const prior = seenById.get(e.keyId);
    if (prior) {
      if (prior.pem !== e.publicKeyPem) return { ok: false, reason: `duplicate keyId ${e.keyId} with different public-key material` };
      if (prior.status !== e.status) return { ok: false, reason: `keyId ${e.keyId} has conflicting status (active and revoked)` };
      return { ok: false, reason: `duplicate keyId ${e.keyId}` };
    }
    seenById.set(e.keyId, { pem: e.publicKeyPem, status: e.status });
    let key: KeyObject;
    try {
      key = createPublicKey(e.publicKeyPem);
    } catch {
      return { ok: false, reason: `keyId ${e.keyId} has a malformed public key` };
    }
    if (key.asymmetricKeyType !== 'ed25519') return { ok: false, reason: `keyId ${e.keyId} is not an ed25519 key` };
    // Same public-key material must not appear under a second (unauthorized) id.
    const fp = derFingerprint(key);
    const otherId = materialToId.get(fp);
    if (otherId && otherId !== e.keyId) return { ok: false, reason: `public key already trusted under a different keyId (${otherId})` };
    materialToId.set(fp, e.keyId);
    if (e.status === 'revoked') {
      revoked.add(e.keyId);
      continue;
    }
    active.set(e.keyId, { publicKey: key, notBefore: e.notBefore ? Date.parse(e.notBefore) : null, notAfter: e.notAfter ? Date.parse(e.notAfter) : null });
  }
  for (const id of active.keys()) if (revoked.has(id)) return { ok: false, reason: `keyId ${id} is both active and revoked` };
  return { ok: true, store: { keyring: active, revoked } };
}
