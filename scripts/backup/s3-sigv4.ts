import { createHash, createHmac } from 'node:crypto';

/**
 * G-Backup — GENERIC, dependency-free AWS SigV4 for S3-compatible object storage (path-style).
 *
 * This is a standalone signer for the DEPLOYMENT-CONTROL receipt-publication path. It is DELIBERATELY decoupled
 * from the application document/VER-002 object store (`src/domain/documents/s3-object-store.ts`, which is a
 * `server-only` module bound to the app library bucket): the receipt endpoint is a SEPARATE storage path with its
 * OWN least-privilege credential and bucket, and this module carries no `server-only` guard so it is usable from a
 * plain Node CLI and from offline tests. The signing algorithm mirrors the reference-vector-tested app signer
 * exactly (path-style canonical URI, sorted SignedHeaders, SHA-256 payload hash); it introduces no new crypto.
 *
 * It signs requests only. It holds no credentials beyond the {@link S3Config} it is handed, performs no I/O, and
 * never logs. The caller supplies the HTTP transport.
 */

export interface S3Config {
  /** e.g. https://fly.storage.tigris.dev — NO trailing slash. */
  readonly endpoint: string;
  /** e.g. auto | us-east-1 */
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface SignedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
}

/** SHA-256 hex of the empty body — the canonical payload hash for a bodyless GET/HEAD. */
export const EMPTY_BODY_SHA256 = createHash('sha256').update('').digest('hex');

function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 encoding for each path segment (S3 canonical URI). */
function encodeSegment(seg: string): string {
  return encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Path-style canonical URI: `/{bucket}/{key}` with each segment RFC-3986 encoded. */
export function canonicalKeyPath(bucket: string, key: string): string {
  const encodedKey = key.split('/').map(encodeSegment).join('/');
  return `/${encodeSegment(bucket)}/${encodedKey}`;
}

/** UTC `YYYYMMDDTHHMMSSZ`. */
export function amzDateNow(now: () => Date = () => new Date()): string {
  return now().toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * Build a path-style SigV4-signed S3 request. `amzDate` is passed in so the signer is PURE and testable. The exact
 * same canonical-request / string-to-sign / signing-key derivation as the app signer (reference-vector tested).
 */
export function signS3Request(
  cfg: S3Config,
  args: {
    readonly method: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
    readonly key: string;
    /** sha256 hex of the body (or EMPTY_BODY_SHA256 for a bodyless request). */
    readonly payloadHash: string;
    readonly amzDate: string;
    readonly extraHeaders?: Record<string, string>;
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

  const canonicalRequest = [args.method, canonicalUri, '', canonicalHeaders, signedHeaders, args.payloadHash].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', args.amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${cfg.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, cfg.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const authorization = `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { url: `${cfg.endpoint}${canonicalUri}`, headers: { ...baseHeaders, Authorization: authorization } };
}
