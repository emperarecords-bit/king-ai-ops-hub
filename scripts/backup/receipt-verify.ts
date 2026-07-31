import { type KeyObject, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import { type BackupReceipt, type SignedReceipt, receiptSchema, toSignedPayload } from './receipt-schema';
import { receiptSigningBytes } from './receipt-canonical';

/**
 * G-Backup-A — receipt signing (producer/test side) + verification (release side).
 *
 * ASYMMETRIC by design (owner correction): the producer holds an Ed25519 PRIVATE key and runs OUTSIDE the
 * release container; the release process holds only PUBLIC keys and can VERIFY but CANNOT mint a receipt. A
 * release container that is fully compromised still cannot forge a receipt for a snapshot that never existed.
 *
 * `signReceipt` exists for the external producer and for tests (ephemeral keys). No real private key is
 * provisioned, stored, or committed in G-Backup-A.
 */

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** PRODUCER/TEST ONLY: sign a signed-payload with an Ed25519 private key → a full receipt. */
export function signReceipt(signed: SignedReceipt, privateKey: KeyObject): BackupReceipt {
  if (signed.signatureAlgorithm !== 'ed25519') throw new Error('only ed25519 is supported');
  const sig = cryptoSign(null, receiptSigningBytes(signed), privateKey);
  return { ...signed, signature: sig.toString('base64url') };
}

export interface VerifyContext {
  readonly now: Date;
  /** The instant migration execution begins — the snapshot MUST predate this. */
  readonly migrationStartedAt: Date;
  readonly environment: SignedReceipt['environment'];
  readonly databaseApp: string;
  readonly volumeId: string;
  readonly targetApplication: string;
  readonly sourceCommit: string;
  readonly migrationSetHash: string;
  readonly supportedReceiptVersions: ReadonlySet<string>;
  readonly supportedAlgorithms: ReadonlySet<string>;
  /** keyId → Ed25519 public key. An unknown keyId is rejected. */
  readonly keyring: Readonly<Record<string, KeyObject>>;
}

/**
 * Full verification: schema → signature (over canonical signed payload) → semantic bindings + anti-replay.
 * Signature is checked BEFORE any field is trusted for policy. Returns the FIRST failing reason.
 */
export function verifyReceipt(receiptInput: unknown, ctx: VerifyContext): VerifyResult {
  // 1) Schema (strict — unknown/secret fields rejected).
  const parsed = receiptSchema.safeParse(receiptInput);
  if (!parsed.success) return { ok: false, reason: `schema: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  const receipt: BackupReceipt = parsed.data;

  // 2) Version + algorithm supported.
  if (!ctx.supportedReceiptVersions.has(receipt.receiptVersion)) return { ok: false, reason: `unsupported receiptVersion ${receipt.receiptVersion}` };
  if (!ctx.supportedAlgorithms.has(receipt.signatureAlgorithm)) return { ok: false, reason: `unsupported signatureAlgorithm ${receipt.signatureAlgorithm}` };

  // 3) Known key id.
  const key = ctx.keyring[receipt.keyId];
  if (!key) return { ok: false, reason: `unknown keyId ${receipt.keyId}` };

  // 4) Signature valid over the canonical signed payload (nothing else is trusted until this passes).
  const signed = toSignedPayload(receipt);
  let sigOk = false;
  try {
    sigOk = cryptoVerify(null, receiptSigningBytes(signed), key, Buffer.from(receipt.signature, 'base64url'));
  } catch {
    sigOk = false;
  }
  if (!sigOk) return { ok: false, reason: 'invalid signature' };

  // 5) Deployment bindings (anti-replay across environment/db/volume/app/commit/migration-set).
  if (receipt.environment !== ctx.environment) return { ok: false, reason: 'environment mismatch' };
  if (receipt.databaseApp !== ctx.databaseApp) return { ok: false, reason: 'databaseApp mismatch' };
  if (receipt.volumeId !== ctx.volumeId) return { ok: false, reason: 'volumeId mismatch' };
  if (receipt.targetApplication !== ctx.targetApplication) return { ok: false, reason: 'targetApplication mismatch' };
  if (receipt.sourceCommit !== ctx.sourceCommit) return { ok: false, reason: 'sourceCommit mismatch' };
  if (receipt.migrationSetHash !== ctx.migrationSetHash) return { ok: false, reason: 'migrationSetHash mismatch' };

  // 6) Snapshot completeness + nonce presence.
  if (receipt.snapshotStatus !== 'complete') return { ok: false, reason: `snapshotStatus is '${receipt.snapshotStatus}', expected 'complete'` };
  if (receipt.deploymentNonce.trim().length === 0) return { ok: false, reason: 'missing deploymentNonce' };

  // 7) Time bindings: not expired, not future-created, snapshot predates migration.
  const now = ctx.now.getTime();
  if (Date.parse(receipt.expiresAt) <= now) return { ok: false, reason: 'receipt expired' };
  if (Date.parse(receipt.receiptCreatedAt) > now) return { ok: false, reason: 'receiptCreatedAt is in the future' };
  if (Date.parse(receipt.snapshotCreatedAt) >= ctx.migrationStartedAt.getTime()) {
    return { ok: false, reason: 'snapshot was created at/after migration start (must predate migration)' };
  }

  return { ok: true };
}
