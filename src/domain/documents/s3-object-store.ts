import 'server-only';
import { createHash, createHmac } from 'node:crypto';
import { type ObjectStore, ObjectNotFoundError, type StoredObjectHead } from './object-store';

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
  },
): SignedRequest {
  const host = new URL(cfg.endpoint).host;
  const canonicalUri = canonicalKeyPath(cfg.bucket, args.key);
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
    '', // canonical query string (none)
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
    url: `${cfg.endpoint}${canonicalUri}`,
    headers: { ...baseHeaders, Authorization: authorization },
  };
}

function amzDateNow(): string {
  // Date.now via new Date() is fine here (runtime, not a workflow script).
  return new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
}

export class S3ObjectStore implements ObjectStore {
  readonly driver = 's3' as const;
  constructor(private readonly cfg: S3Config) {}

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
    const signed = signS3Request(this.cfg, {
      method: 'PUT',
      key,
      payloadHash: sha256Hex(body),
      amzDate: amzDateNow(),
      extraHeaders: { 'content-type': contentType },
    });
    const res = await fetch(signed.url, {
      method: 'PUT',
      headers: signed.headers,
      body: new Uint8Array(body),
    });
    if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status}`);
  }

  async get(key: string): Promise<Buffer> {
    const signed = signS3Request(this.cfg, {
      method: 'GET',
      key,
      payloadHash: UNSIGNED,
      amzDate: amzDateNow(),
    });
    const res = await fetch(signed.url, { method: 'GET', headers: signed.headers });
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
    const res = await fetch(signed.url, { method: 'HEAD', headers: signed.headers });
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
    const res = await fetch(signed.url, { method: 'DELETE', headers: signed.headers });
    // S3 returns 204 on delete; treat 404 as already-gone (idempotent).
    if (!res.ok && res.status !== 404) throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
  }
}
