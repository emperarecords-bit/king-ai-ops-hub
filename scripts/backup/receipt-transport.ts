import { get as httpsGet } from 'node:https';
import {
  type ReceiptV2Expectation,
  type ReceiptV2VerifyResult,
  verifyReceiptV2Bytes,
} from './receipt-v2-verify';
import { type LocatorInput, buildReceiptLocator, validateReceiptUrl } from './receipt-v2-locator';

/**
 * G-Backup-B1 — receipt transport. Injectable fetch interface so tests use an in-process fake and never touch the
 * network or real object storage. The transport carries NO Fly deploy authority and NO credentials into the
 * release Machine; the receipt is public/signed. Ed25519 (in the verifier) is the trust anchor — the transport
 * only enforces raw safety controls (step 1). Diagnostics are deterministic and contain hashes/IDs only; the
 * receipt body and any header values are never logged.
 */

export class ReceiptTransportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ReceiptTransportError';
    this.code = code;
  }
}

export interface ReceiptFetchResult {
  readonly status: number;
  readonly bytes: Buffer;
  /** Content-Encoding header, if any. Anything other than absent/`identity` fails closed (compression ambiguity). */
  readonly contentEncoding?: string | null;
  /** True if the underlying client followed one or more redirects (must be false). */
  readonly redirected?: boolean;
}

/** Injectable single-GET fetcher. Implementations MUST perform exactly one request and never list a prefix. */
export interface ReceiptFetcher {
  fetchOnce(url: string): Promise<ReceiptFetchResult>;
}

export interface TransportControls {
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly hostAllowlist: ReadonlySet<string>;
}

/** Producer-side (external controller) write interface. Optional; the gate's integrity does NOT depend on it. */
export interface ReceiptStoreWriter {
  /** Write a receipt object only if the key is absent, where the store supports it. */
  putIfAbsent(key: string, bytes: Buffer): Promise<void>;
}

export type FetchAndVerifyResult =
  | { readonly ok: true; readonly receiptCanonicalHash: string }
  | { readonly ok: false; readonly stage: 'transport' | 'verify'; readonly code: string; readonly detail: string; readonly step?: number };

/**
 * Fetch the receipt at the deterministic locator (exactly once) and verify it. Enforces step-1 transport controls
 * before handing bytes to the verifier (steps 2–18). Fails closed on any transport or verification problem.
 */
export async function fetchAndVerifyReceiptV2(
  fetcher: ReceiptFetcher,
  locator: Omit<LocatorInput, 'hostAllowlist'>,
  controls: TransportControls,
  exp: ReceiptV2Expectation,
): Promise<FetchAndVerifyResult> {
  let url: string;
  try {
    url = buildReceiptLocator({ ...locator, hostAllowlist: controls.hostAllowlist });
    validateReceiptUrl(url, { ...locator, hostAllowlist: controls.hostAllowlist });
  } catch (e) {
    return { ok: false, stage: 'transport', code: 'locator_invalid', detail: e instanceof Error ? e.message : 'bad locator' };
  }

  let res: ReceiptFetchResult;
  try {
    res = await fetcher.fetchOnce(url);
  } catch (e) {
    const code = e instanceof ReceiptTransportError ? e.code : 'fetch_error';
    return { ok: false, stage: 'transport', code, detail: e instanceof Error ? e.message : 'fetch failed' };
  }
  if (res.redirected) return { ok: false, stage: 'transport', code: 'redirect', detail: 'redirects are not allowed' };
  if (res.status !== 200) return { ok: false, stage: 'transport', code: 'bad_status', detail: `status ${res.status}` };
  if (res.contentEncoding && res.contentEncoding.toLowerCase() !== 'identity') {
    return { ok: false, stage: 'transport', code: 'encoding_ambiguous', detail: 'unexpected content-encoding' };
  }
  if (!Buffer.isBuffer(res.bytes) || res.bytes.length === 0) return { ok: false, stage: 'transport', code: 'empty', detail: 'empty body' };
  if (res.bytes.length > controls.maxBytes) return { ok: false, stage: 'transport', code: 'oversize', detail: 'response exceeds maxBytes' };

  const v: ReceiptV2VerifyResult = verifyReceiptV2Bytes(res.bytes, exp);
  if (!v.ok) return { ok: false, stage: 'verify', code: v.code, detail: v.detail, step: v.step };
  return { ok: true, receiptCanonicalHash: v.receiptCanonicalHash };
}

/**
 * Production HTTPS fetcher: HTTPS-only, allowlisted host, NO redirects, strict timeout, streaming max-bytes cap,
 * `Accept-Encoding: identity` (rejects a compressed response), exactly one request. Not exercised in tests (tests
 * inject a fake); provided for the real release path.
 */
export function createHttpsReceiptFetcher(controls: TransportControls): ReceiptFetcher {
  return {
    fetchOnce(url: string): Promise<ReceiptFetchResult> {
      const u = new URL(url);
      if (u.protocol !== 'https:') return Promise.reject(new ReceiptTransportError('not_https', 'must be https'));
      if (!controls.hostAllowlist.has(u.hostname)) return Promise.reject(new ReceiptTransportError('host_not_allowed', 'host not allowlisted'));
      return new Promise<ReceiptFetchResult>((resolve, reject) => {
        const req = httpsGet(
          url,
          { headers: { 'accept-encoding': 'identity', accept: 'application/json' }, timeout: controls.timeoutMs },
          (resp) => {
            const status = resp.statusCode ?? 0;
            const enc = (resp.headers['content-encoding'] as string | undefined) ?? null;
            // Do NOT follow redirects.
            if (status >= 300 && status < 400) {
              resp.resume();
              resolve({ status, bytes: Buffer.alloc(0), contentEncoding: enc, redirected: true });
              return;
            }
            const chunks: Buffer[] = [];
            let total = 0;
            resp.on('data', (c: Buffer) => {
              total += c.length;
              if (total > controls.maxBytes) {
                req.destroy();
                reject(new ReceiptTransportError('oversize', 'response exceeds maxBytes'));
                return;
              }
              chunks.push(c);
            });
            resp.on('end', () => resolve({ status, bytes: Buffer.concat(chunks), contentEncoding: enc, redirected: false }));
            resp.on('error', (e) => reject(new ReceiptTransportError('stream_error', e.message)));
          },
        );
        req.on('timeout', () => {
          req.destroy();
          reject(new ReceiptTransportError('timeout', 'request timed out'));
        });
        req.on('error', (e) => reject(new ReceiptTransportError('request_error', e.message)));
      });
    },
  };
}
