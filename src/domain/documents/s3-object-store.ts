import 'server-only';
import { createHash, createHmac } from 'node:crypto';
import { isCanonicalObjectKey, isVerificationArtifactKey, type ObjectStore, ObjectNotFoundError, type StoredObjectHead, VerificationObjectWriteError } from './object-store';

/**
 * S3-compatible ObjectStore with dependency-free AWS SigV4 (O-23). Works with
 * any S3 endpoint — Fly Tigris, Cloudflare R2, MinIO, AWS — using PATH-STYLE
 * addressing (`https://endpoint/bucket/key`) so no bucket-in-host DNS is needed.
 *
 * Credentials live only here (server-side). No presigned URLs are issued: every
 * GET/PUT/DELETE is made by the server/worker with these credentials, so there
 * are no public or guessable object URLs.
 *
 * The signer is unit-tested against the AWS SigV4 reference vector
 * (tests/unit/sigv4.test.ts) so a signing regression fails CI, not production.
 */

export interface S3Config {
  endpoint: string; // e.g. https://fly.storage.tigris.dev  (no trailing slash)
  region: string; // e.g. auto | us-east-1
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const UNSIGNED = 'UNSIGNED-PAYLOAD';

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 encoding for each path segment (S3 canonical URI). */
function encodeSegment(seg: string): string {
  return encodeURIComponent(seg).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

export function canonicalKeyPath(bucket: string, key: string): string {
  const encodedKey = key.split('/').map(encodeSegment).join('/');
  return `/${encodeSegment(bucket)}/${encodedKey}`;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Build a SigV4-signed request. `amzDate` (YYYYMMDDTHHMMSSZ) is passed in so the
 * signer is pure and testable; production passes `new Date()`.
 */
export function signS3Request(
  cfg: S3Config,
  args: {
    method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
    key: string;
    payloadHash: string; // sha256 hex of body, or UNSIGNED
    amzDate: string;
    extraHeaders?: Record<string, string>;
    /** Canonical query parameters (e.g. ListObjectsV2). Omitted ⇒ empty query, byte-for-byte the same
     *  signing as before (the SigV4 reference vector test exercises this default path). */
    query?: Record<string, string>;
    /** Bucket-level operation (ListObjectsV2): canonical URI is `/{bucket}`, not a key path. */
    bucketLevel?: boolean;
  },
): SignedRequest {
  const host = new URL(cfg.endpoint).host;
  const canonicalUri = args.bucketLevel ? `/${encodeSegment(cfg.bucket)}` : canonicalKeyPath(cfg.bucket, args.key);
  // Canonical query string: params sorted by encoded key, each key and value RFC-3986 encoded.
  const canonicalQuery = args.query
    ? Object.keys(args.query)
        .map(encodeSegment)
        .sort()
        .map((k) => {
          const rawKey = Object.keys(args.query!).find((o) => encodeSegment(o) === k)!;
          return `${k}=${encodeSegment(args.query![rawKey]!)}`;
        })
        .join('&')
    : '';
  const dateStamp = args.amzDate.slice(0, 8);
  const scope = `${dateStamp}/${cfg.region}/s3/aws4_request`;

  const baseHeaders: Record<string, string> = {
    host,
    'x-amz-content-sha256': args.payloadHash,
    'x-amz-date': args.amzDate,
    ...(args.extraHeaders ?? {}),
  };
  const signedHeaderNames = Object.keys(baseHeaders)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders = signedHeaderNames
    .map((h) => `${h}:${String(baseHeaders[Object.keys(baseHeaders).find((k) => k.toLowerCase() === h)!]).trim()}\n`)
    .join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    args.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    args.payloadHash,
  ].join('\n');

  const stringToSign = [
    'AWS4-HMAC-SHA256',
    args.amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `${cfg.endpoint}${canonicalUri}${canonicalQuery ? `?${canonicalQuery}` : ''}`,
    headers: { ...baseHeaders, Authorization: authorization },
  };
}

/** Decode the handful of XML entities that can appear in an S3 <Key>. */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function amzDateNow(): string {
  // Date.now via new Date() is fine here (runtime, not a workflow script).
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/** The outcome of a create-only publish. `ambiguous` is never returned — it is resolved internally by
 *  reconciliation (HEAD) into created/exists, or surfaced as a thrown error when it cannot be resolved. */
export type CreateOnlyResult = 'created' | 'exists';

export class S3ObjectStore implements ObjectStore {
  readonly driver = 's3' as const;
  /** `fetchImpl` is injectable ONLY so hermetic tests can drive simulated S3 responses; production uses
   *  the global fetch. It changes nothing about signing or request shape. */
  constructor(
    private readonly cfg: S3Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static fromEnv(): S3ObjectStore {
    // S3_* is the documented contract; managed platforms (Fly/Tigris) inject the
    // same credentials under AWS_* names, and Fly secrets are write-only so they
    // cannot be copied into S3_* by hand — accept AWS_* as a fallback. This does
    // not change storage behavior, only where config is read (O-23 acceptance).
    const cfg: S3Config = {
      endpoint: (process.env.S3_ENDPOINT ?? process.env.AWS_ENDPOINT_URL_S3 ?? '').replace(/\/+$/, ''),
      region: process.env.S3_REGION ?? process.env.AWS_REGION ?? 'auto',
      bucket: process.env.S3_BUCKET ?? process.env.BUCKET_NAME ?? '',
      accessKeyId: process.env.S3_ACCESS_KEY_ID ?? process.env.AWS_ACCESS_KEY_ID ?? '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? process.env.AWS_SECRET_ACCESS_KEY ?? '',
    };
    const missing = (Object.keys(cfg) as (keyof S3Config)[]).filter((k) => !cfg[k]);
    if (missing.length > 0) {
      throw new Error(`S3 storage misconfigured — missing: ${missing.join(', ')}`);
    }
    return new S3ObjectStore(cfg);
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    // Reject non-canonical keys BEFORE classification so no alias can dodge the verification-object guard.
    if (!isCanonicalObjectKey(key)) throw new Error('non-canonical object key');
    // Ordinary put MUST NOT overwrite (or create) a verification artifact object (VER-002 PR-4) — those
    // are written only through the create-only exclusive publisher. Fail closed rather than clobber one.
    if (isVerificationArtifactKey(key)) throw new VerificationObjectWriteError(key);
    const signed = signS3Request(this.cfg, {
      method: 'PUT',
      key,
      payloadHash: sha256Hex(body),
      amzDate: amzDateNow(),
      extraHeaders: { 'content-type': contentType },
    });
    const res = await this.fetchImpl(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: new Uint8Array(body),
    });
    if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status}`);
  }

  /**
   * Create-only publish for a verification artifact (VER-002 PR-5). Issues a CONDITIONAL PUT
   * (`If-None-Match: *`) with the EXACT body and a provider-verified `x-amz-checksum-sha256` (policy P-A:
   * the adapter ALWAYS sends the checksum, so a missing checksum cannot occur on the write path). Returns
   * `'created'` (2xx) or `'exists'` (412/409 precondition failed). It NEVER issues an unconditional PUT.
   *
   * Ambiguous outcomes (network error / timeout / 5xx) are RECONCILED by HEAD before any retry: a PRESENT
   * object ⇒ `'exists'` (the caller re-validates it against the grant's size+digest); an ABSENT object ⇒ a
   * bounded retry of the SAME conditional PUT. Auth/permission failures (401/403) and other 4xx are
   * non-retryable and throw. A read failure during reconciliation throws — the outcome cannot be confirmed,
   * so it is never reported as a silent success, and the object is never overwritten.
   *
   * ADAPTER guarantee (offline-testable, here): the request shape and the no-unconditional-PUT + reconcile
   * logic. Whether the PROVIDER actually ENFORCES `If-None-Match`/the checksum (credential-enforced
   * immutability) is NOT VERIFIED here — that is the authorized live acceptance run.
   */
  async putIfAbsent(
    key: string,
    body: Buffer,
    contentType: string,
    opts: { deadline?: Date; now?: () => Date } = {},
  ): Promise<CreateOnlyResult> {
    if (!isCanonicalObjectKey(key)) throw new Error('non-canonical object key');
    const now = opts.now ?? (() => new Date());
    const checksum = createHash('sha256').update(body).digest('base64'); // base64 of the RAW digest (NOT hex)
    const attemptOnce = async (): Promise<CreateOnlyResult | 'ambiguous'> => {
      let res: Response;
      try {
        const signed = signS3Request(this.cfg, {
          method: 'PUT',
          key,
          payloadHash: sha256Hex(body),
          amzDate: amzDateNow(),
          // Both headers are SIGNED (signS3Request folds extraHeaders into SignedHeaders), so the provider
          // is asked to enforce create-only AND the checksum.
          extraHeaders: { 'content-type': contentType, 'if-none-match': '*', 'x-amz-checksum-sha256': checksum },
        });
        res = await this.fetchImpl(signed.url, { method: 'PUT', headers: signed.headers, body: new Uint8Array(body) });
      } catch {
        return 'ambiguous'; // network error / timeout — we do not know whether it landed
      }
      if (res.ok) return 'created';
      // 412 Precondition Failed is the standard If-None-Match:* conflict; some S3-compatible providers use
      // 409 Conflict for the same condition. Both mean the key already exists — handled explicitly.
      if (res.status === 412) return 'exists';
      if (res.status === 409) return 'exists';
      if (res.status === 401 || res.status === 403) throw new Error(`S3 create-only ${key} denied: ${res.status}`);
      if (res.status >= 500) return 'ambiguous';
      throw new Error(`S3 create-only ${key} failed: ${res.status}`); // other 4xx — non-retryable
    };

    const MAX_ATTEMPTS = 3;
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      // Enforce the grant's expiry BEFORE any internal retry — a retry (i>0) after the deadline is a NEW
      // create attempt the grant no longer authorizes, so stop rather than keep trying past expiry.
      if (i > 0 && opts.deadline && now().getTime() > opts.deadline.getTime()) {
        throw new Error(`S3 create-only ${key} not retried: grant expired before the next attempt`);
      }
      const outcome = await attemptOnce();
      if (outcome !== 'ambiguous') return outcome;
      // Ambiguous ⇒ reconcile by HEAD before any retry; a retry is ONLY ever the same conditional PUT.
      let head: StoredObjectHead | null;
      try {
        head = await this.head(key);
      } catch (err) {
        throw new Error(`S3 create-only ${key} ambiguous and reconcile HEAD failed: ${(err as Error).message}`);
      }
      if (head) return 'exists'; // it landed (ours or a concurrent writer) — the caller re-validates it
      // absent ⇒ the write did not land; loop and retry the SAME conditional create-only PUT (bounded).
    }
    throw new Error(`S3 create-only ${key} outcome remained ambiguous after ${MAX_ATTEMPTS} attempts`);
  }

  async get(key: string): Promise<Buffer> {
    const signed = signS3Request(this.cfg, {
      method: 'GET',
      key,
      payloadHash: UNSIGNED,
      amzDate: amzDateNow(),
    });
    const res = await this.fetchImpl(signed.url, { method: 'GET', headers: signed.headers });
    if (res.status === 404) throw new ObjectNotFoundError(key);
    if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async head(key: string): Promise<StoredObjectHead | null> {
    const signed = signS3Request(this.cfg, {
      method: 'HEAD',
      key,
      payloadHash: UNSIGNED,
      amzDate: amzDateNow(),
    });
    const res = await this.fetchImpl(signed.url, { method: 'HEAD', headers: signed.headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`S3 HEAD ${key} failed: ${res.status}`);
    const len = res.headers.get('content-length');
    return { size: len ? Number(len) : 0, contentType: res.headers.get('content-type') };
  }

  async delete(key: string): Promise<void> {
    const signed = signS3Request(this.cfg, {
      method: 'DELETE',
      key,
      payloadHash: UNSIGNED,
      amzDate: amzDateNow(),
    });
    const res = await this.fetchImpl(signed.url, { method: 'DELETE', headers: signed.headers });
    // S3 returns 204 on delete; treat 404 as already-gone (idempotent).
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
  }

  /** ListObjectsV2 under a prefix, following continuation tokens. READ-ONLY (backfill orphan scan). */
  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = { 'list-type': '2', prefix };
      if (token) query['continuation-token'] = token;
      const signed = signS3Request(this.cfg, {
        method: 'GET',
        key: '',
        payloadHash: UNSIGNED,
        amzDate: amzDateNow(),
        query,
        bucketLevel: true,
      });
      const res = await this.fetchImpl(signed.url, { method: 'GET', headers: signed.headers });
      if (!res.ok) throw new Error(`S3 LIST ${prefix} failed: ${res.status}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) keys.push(decodeXmlEntities(m[1]!));
      const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
      const next = xml.match(/<NextContinuationToken>([^<]*)<\/NextContinuationToken>/);
      token = truncated && next ? decodeXmlEntities(next[1]!) : undefined;
    } while (token);
    return keys;
  }
}
