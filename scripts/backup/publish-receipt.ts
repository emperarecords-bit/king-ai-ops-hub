import { createHash } from 'node:crypto';
import { type ReceiptV2Expectation, verifyReceiptV2Bytes } from './receipt-v2-verify';
import { receiptV2Schema } from './receipt-v2-schema';
import { parseStrictJsonBuffer } from './strict-json';
import { type LocatorInput, buildReceiptLocator, validateReceiptUrl } from './receipt-v2-locator';
import { type ReceiptFetcher, type TransportControls } from './receipt-transport';
import { type S3Config, EMPTY_BODY_SHA256, amzDateNow, signS3Request } from './s3-sigv4';

/**
 * G-Backup — minimum receipt PUBLISHER (deployment-control consumer).
 *
 * The signing workflows (`sign-staging-receipt` / `sign-production-receipt`) produce the signed receipt as an
 * artifact ONLY and never publish it to the gate's `GBACKUP_RECEIPT_BASE_URL`. The pre-migration gate, in turn,
 * fetches the receipt from that HTTPS locator and verifies it fail-closed. This module is the missing, separately
 * reviewable bridge: it takes an ALREADY-SIGNED receipt and publishes it to the EXACT deterministic locator the
 * gate reads, create-only, then independently re-fetches and re-verifies it anonymously — the same check the gate
 * will run — before the release proceeds.
 *
 * Trust model / non-goals:
 *  - It is a CONSUMER: it never holds, derives, or touches the Ed25519 SIGNING private key. It only re-verifies the
 *    signature with the public trust bundle (the trust anchor), exactly like the gate.
 *  - It NEVER overwrites: writes are create-only (conditional, If-None-Match:*). A key that already holds a
 *    byte-different receipt is a refusal, never a clobber.
 *  - It derives the destination ONLY from the receipt/deployment identity via the shared receipt-v2 locator
 *    (`/v2/<environment>/<targetApplication>/<deploymentNonce>.json`). No operator-supplied object key.
 *  - It enforces every binding the gate enforces (via the SAME verifier + expectation) AND, additionally, the
 *    controller-known `targetImageDigest` (which the runtime gate cannot re-check) at publish time.
 *  - It NEVER bypasses the gate and NEVER relaxes the snapshot-freshness window: publish-time verification uses the
 *    real freshness bound with `migrationStartedAt = now`, so a stale snapshot refuses here too.
 *  - It is DECOUPLED from the application document/VER-002 object store: its own least-privilege S3 config.
 *
 * All refusals throw {@link ReceiptPublishError} (fail-closed); success returns {@link PublishReceiptResult} with
 * non-secret metadata only.
 */

const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;

export class ReceiptPublishError extends Error {
  readonly code: string;
  /** When the failure came from the B1 verifier, its step number. */
  readonly step?: number;
  constructor(code: string, message: string, step?: number) {
    super(message);
    this.name = 'ReceiptPublishError';
    this.code = code;
    this.step = step;
  }
}

/** One create-only conditional write attempt. MUST never issue an unconditional PUT. */
export type CreateOnlyAttempt = 'created' | 'exists' | 'ambiguous';

/**
 * Authenticated receipt object store (the write side). Decoupled from the app document store. Implementations MUST
 * make `putIfAbsentOnce` conditional (create-only) and MUST NOT retry internally — the publisher owns the bounded
 * reconcile/retry loop so its policy is testable.
 */
export interface ReceiptObjectStore {
  putIfAbsentOnce(key: string, bytes: Buffer, contentType: string): Promise<CreateOnlyAttempt>;
  /** Authenticated existence probe used ONLY to reconcile an ambiguous write. */
  head(key: string): Promise<'present' | 'absent'>;
}

export type PublishStatus = 'created' | 'already_present_identical';

export interface PublishReceiptResult {
  readonly status: PublishStatus;
  /** The exact HTTPS locator the gate will fetch. */
  readonly url: string;
  /** The object key written (locator path, no leading slash). */
  readonly objectKey: string;
  readonly receiptId: string;
  readonly receiptCanonicalHash: string;
  /** SHA-256 (hex) of the exact published bytes. */
  readonly receiptSha256: string;
  readonly byteLength: number;
  readonly keyId: string;
  readonly deploymentNonce: string;
  readonly pendingMigrationCount: number;
  readonly publishedAt: string;
}

export interface PublishReceiptArgs {
  /** The exact signed receipt file bytes (as produced by the signer). */
  readonly signedReceiptBytes: Buffer;
  /** The trusted release expectation — SAME shape the gate builds. `migrationStartedAt` is overridden with the
   *  publish clock, so the snapshot-freshness and receipt-expiry windows are enforced at publish time. */
  readonly expectation: ReceiptV2Expectation;
  /** Controller-known immutable image digest (`sha256:<64hex>`). Bound here because the runtime gate cannot
   *  re-check the digest (it is signed evidence, not runtime-observable). */
  readonly expectedTargetImageDigest: string;
  /** Deterministic locator inputs (no host — that comes from `controls.hostAllowlist` + baseUrl). */
  readonly locator: Omit<LocatorInput, 'hostAllowlist'>;
  /** Anonymous read-back transport controls (host allowlist, byte cap, timeout). */
  readonly controls: TransportControls;
  readonly store: ReceiptObjectStore;
  /** Anonymous HTTPS fetcher for the independent read-back (never carries credentials). */
  readonly fetcher: ReceiptFetcher;
  readonly now?: () => Date;
  /** Bounded retries when a write is ambiguous AND reconciliation shows the object absent. Default 3. */
  readonly maxWriteAttempts?: number;
}

function sha256Hex(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/**
 * Create-only write with bounded reconcile. Returns whether we created the object or it already existed. An
 * ambiguous attempt is reconciled by an authenticated HEAD: present ⇒ treat as `exists` (the subsequent read-back
 * proves identity), absent ⇒ a bounded retry of the SAME conditional write. A HEAD failure propagates (we never
 * report a silent success). Exhausting the attempts without confirmation throws (fail-closed).
 */
async function createOnlyWrite(store: ReceiptObjectStore, key: string, bytes: Buffer, maxAttempts: number): Promise<'created' | 'exists'> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await store.putIfAbsentOnce(key, bytes, 'application/json');
    if (r === 'created') return 'created';
    if (r === 'exists') return 'exists';
    // ambiguous → reconcile by HEAD (a read error throws — never a silent success).
    const present = await store.head(key);
    if (present === 'present') return 'exists';
    // absent → the write did not land; retry the SAME conditional write (bounded).
  }
  throw new ReceiptPublishError('write_unconfirmed', `create-only write could not be confirmed after ${maxAttempts} attempt(s)`);
}

/** Anonymous read-back (exactly one fetch) with the same transport safety the gate enforces. Returns the bytes. */
async function anonymousReadBack(fetcher: ReceiptFetcher, url: string, controls: TransportControls): Promise<Buffer> {
  const res = await fetcher.fetchOnce(url);
  if (res.redirected) throw new ReceiptPublishError('readback_redirect', 'read-back followed a redirect');
  if (res.status !== 200) throw new ReceiptPublishError('readback_bad_status', `read-back status ${res.status}`);
  if (res.contentEncoding && res.contentEncoding.toLowerCase() !== 'identity') {
    throw new ReceiptPublishError('readback_encoding', 'read-back returned an unexpected content-encoding');
  }
  if (!Buffer.isBuffer(res.bytes) || res.bytes.length === 0) throw new ReceiptPublishError('readback_empty', 'read-back returned an empty body');
  if (res.bytes.length > controls.maxBytes) throw new ReceiptPublishError('readback_oversize', 'read-back exceeded maxBytes');
  return res.bytes;
}

/**
 * Publish an already-signed receipt to the gate's deterministic locator, create-only, then independently re-fetch
 * and re-verify it anonymously. Throws {@link ReceiptPublishError} on ANY problem; returns non-secret metadata on
 * success.
 */
export async function publishSignedReceiptV2(args: PublishReceiptArgs): Promise<PublishReceiptResult> {
  const now = args.now ?? (() => new Date());
  const maxAttempts = args.maxWriteAttempts ?? 3;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new ReceiptPublishError('config_invalid', 'maxWriteAttempts must be a positive integer');
  if (!IMAGE_DIGEST.test(args.expectedTargetImageDigest)) throw new ReceiptPublishError('config_invalid', 'expectedTargetImageDigest is not a canonical sha256:<64hex> digest');

  // Publish-time expectation: enforce the freshness/expiry windows as of NOW (no weakening of the gate's checks).
  const publishTime = now();
  const exp: ReceiptV2Expectation = { ...args.expectation, migrationStartedAt: publishTime };

  // 1. VERIFY the receipt BEFORE publication (signature + every binding), exactly like the gate.
  const localVerify = verifyReceiptV2Bytes(args.signedReceiptBytes, exp);
  if (!localVerify.ok) throw new ReceiptPublishError(`local_verify_failed:${localVerify.code}`, `pre-publication verification failed at step ${localVerify.step}`, localVerify.step);

  // 2. Parse (strict) to read the controller-bound fields the verifier does not compare to an expectation.
  let parsedUnknown: unknown;
  try {
    parsedUnknown = parseStrictJsonBuffer(args.signedReceiptBytes);
  } catch (e) {
    throw new ReceiptPublishError('json_invalid', e instanceof Error ? e.message : 'invalid JSON');
  }
  const parsed = receiptV2Schema.safeParse(parsedUnknown);
  if (!parsed.success) throw new ReceiptPublishError('schema_invalid', parsed.error.issues[0]?.message ?? 'schema invalid');
  const receipt = parsed.data;

  // 3. Publish-time IMAGE DIGEST binding — the runtime gate cannot re-resolve the digest, so bind it here.
  if (receipt.targetImageDigest !== args.expectedTargetImageDigest) {
    throw new ReceiptPublishError('image_digest_mismatch', 'receipt targetImageDigest does not equal the expected (controller-resolved) image digest');
  }
  // Defense in depth: the signed ref must itself be bound to that digest.
  if (!receipt.targetImageRef.endsWith(`@${receipt.targetImageDigest}`)) {
    throw new ReceiptPublishError('image_ref_unbound', 'receipt targetImageRef is not bound to its targetImageDigest');
  }

  // 4. Derive the DESTINATION only from the receipt/deployment identity (no operator-supplied key).
  let url: string;
  try {
    const locatorInput: LocatorInput = { ...args.locator, hostAllowlist: args.controls.hostAllowlist };
    url = buildReceiptLocator(locatorInput);
    validateReceiptUrl(url, locatorInput);
  } catch (e) {
    throw new ReceiptPublishError('locator_invalid', e instanceof Error ? e.message : 'bad locator');
  }
  // Cross-check the locator identity equals the signed receipt's identity (no publishing to a foreign key).
  if (args.locator.environment !== receipt.environment) throw new ReceiptPublishError('locator_identity_mismatch', 'locator environment != receipt environment');
  if (args.locator.targetApplication !== receipt.targetApplication) throw new ReceiptPublishError('locator_identity_mismatch', 'locator targetApplication != receipt targetApplication');
  if (args.locator.deploymentNonce !== receipt.deploymentNonce) throw new ReceiptPublishError('locator_identity_mismatch', 'locator deploymentNonce != receipt deploymentNonce');
  const objectKey = new URL(url).pathname.replace(/^\//, '');

  const localSha256 = sha256Hex(args.signedReceiptBytes);

  // 5. Create-only write (never overwrite) with bounded ambiguous reconcile.
  const writeOutcome = await createOnlyWrite(args.store, objectKey, args.signedReceiptBytes, maxAttempts);

  // 6. Anonymous read-back from the EXACT gate URL + byte-exact + hash-exact equality.
  const remoteBytes = await anonymousReadBack(args.fetcher, url, args.controls);
  if (!remoteBytes.equals(args.signedReceiptBytes)) {
    // On an `exists` outcome this is specifically the refuse-to-overwrite signal: a DIFFERENT receipt is already
    // published at this nonce and we did not (and will not) clobber it.
    throw new ReceiptPublishError('readback_byte_mismatch', writeOutcome === 'exists' ? 'a different receipt is already published at this locator (refusing to overwrite)' : 'read-back bytes differ from the published bytes');
  }
  if (sha256Hex(remoteBytes) !== localSha256) throw new ReceiptPublishError('readback_hash_mismatch', 'read-back SHA-256 differs from the published bytes');

  // 7. Re-run the FULL verifier against the REMOTELY retrieved bytes (the same check the gate performs).
  const remoteVerify = verifyReceiptV2Bytes(remoteBytes, exp);
  if (!remoteVerify.ok) throw new ReceiptPublishError(`remote_verify_failed:${remoteVerify.code}`, `remote re-verification failed at step ${remoteVerify.step}`, remoteVerify.step);

  return {
    status: writeOutcome === 'created' ? 'created' : 'already_present_identical',
    url,
    objectKey,
    receiptId: receipt.receiptId,
    receiptCanonicalHash: remoteVerify.receiptCanonicalHash,
    receiptSha256: localSha256,
    byteLength: args.signedReceiptBytes.length,
    keyId: receipt.keyId,
    deploymentNonce: receipt.deploymentNonce,
    pendingMigrationCount: exp.pendingMigrations.length,
    publishedAt: publishTime.toISOString(),
  };
}

/**
 * Real S3-backed receipt store (the authenticated write side). NOT exercised by the offline suite (tests inject a
 * fake), mirroring how `createHttpsReceiptFetcher` is the untested real transport. Uses create-only conditional
 * PUT (`If-None-Match: *`) plus integrity headers; HEAD reconciles ambiguity. Carries ONLY the least-privilege
 * receipt-publish credential it is constructed with — never the app/VER-002 bucket credential.
 */
export function createS3ReceiptObjectStore(cfg: S3Config, fetchImpl: typeof fetch = fetch, now: () => Date = () => new Date()): ReceiptObjectStore {
  return {
    async putIfAbsentOnce(key: string, bytes: Buffer, contentType: string): Promise<CreateOnlyAttempt> {
      const payloadHash = sha256Hex(bytes);
      const contentMd5 = createHash('md5').update(bytes).digest('base64');
      const signed = signS3Request(cfg, {
        method: 'PUT',
        key,
        payloadHash,
        amzDate: amzDateNow(now),
        extraHeaders: { 'content-type': contentType, 'if-none-match': '*', 'content-md5': contentMd5 },
      });
      let res: Response;
      try {
        res = await fetchImpl(signed.url, { method: 'PUT', headers: signed.headers, body: new Uint8Array(bytes) });
      } catch {
        return 'ambiguous';
      }
      if (res.ok) return 'created';
      if (res.status === 412) return 'exists';
      if (res.status === 409) return 'ambiguous';
      if (res.status === 401 || res.status === 403) throw new ReceiptPublishError('s3_put_denied', `receipt PUT denied: ${res.status}`);
      if (res.status >= 500) return 'ambiguous';
      throw new ReceiptPublishError('s3_put_failed', `receipt PUT failed: ${res.status}`);
    },
    async head(key: string): Promise<'present' | 'absent'> {
      const signed = signS3Request(cfg, { method: 'HEAD', key, payloadHash: EMPTY_BODY_SHA256, amzDate: amzDateNow(now) });
      let res: Response;
      try {
        res = await fetchImpl(signed.url, { method: 'HEAD', headers: signed.headers });
      } catch (e) {
        throw new ReceiptPublishError('s3_head_failed', `receipt HEAD failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (res.ok) return 'present';
      if (res.status === 404) return 'absent';
      throw new ReceiptPublishError('s3_head_failed', `receipt HEAD failed: ${res.status}`);
    },
  };
}
