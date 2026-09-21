/**
 * Shared VER-002 PR-5 acceptance logic, used by BOTH the strict opt-in live harness
 * (tests/integration/verification-s3-acceptance.int.test.ts) and the offline simulation
 * (tests/unit/verification-s3-acceptance-offline.test.ts). Extracting it means the live harness's
 * key-selection and cleanup behaviour is exercised against a simulated provider WITHOUT cloud access, so
 * those bugs are caught in CI rather than only when the live run is authorized.
 */
import { createHash, randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { signS3Request, type S3Config, type S3ObjectStore } from '@/domain/documents/s3-object-store';

const rawChecksumB64 = (b: Buffer): string => createHash('sha256').update(b).digest('base64');
const sha256Hex = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const amzDateNow = (): string => new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');

/** Parse the `<Code>…</Code>` from an S3 XML error body, or null if none. */
export function parseS3ErrorCode(body: string): string | null {
  return body.match(/<Code>([^<]+)<\/Code>/)?.[1]?.trim() ?? null;
}

/** The EXPLICIT allow-list of S3 error codes that DOCUMENT rejection of a wrong `x-amz-checksum-sha256`
 *  VALUE (the checksum header PG3 deliberately corrupts), compared case-insensitively:
 *    - `BadDigest`     — the checksum sent did not match what the server computed for the body.
 *    - `InvalidDigest` — the checksum value sent is not a valid digest.
 *  DELIBERATELY EXCLUDED: `XAmzContentSHA256Mismatch` is a PAYLOAD-SIGNING error (the SigV4
 *  `x-amz-content-sha256` request hash), not a rejection of the checksum header, so it must NOT count as a
 *  PG3 pass. Any other code — a payload-signing error, an auth/5xx/unsupported response, or an
 *  unconfirmed/invented code — FAILS CLOSED, even with a 4xx status. */
export const CHECKSUM_MISMATCH_CODES: readonly string[] = ['BadDigest', 'InvalidDigest'];
const isChecksumMismatchCode = (code: string | null): boolean =>
  code !== null && CHECKSUM_MISMATCH_CODES.some((c) => c.toLowerCase() === code.toLowerCase());

/**
 * A PRODUCTION-SHAPED verification artifact key factory: keys are `org/<o>/project/<p>/request/<r>/attempt/
 * <a>/<obj>` — the exact shape production uses — under a run-scoped random tenant, so acceptance exercises
 * real key selection (and the `put` verification-key guard) inside the disposable bucket. `prefix` is the
 * run's LIST prefix for cleanup verification.
 */
export function makeAcceptanceKeys(): { prefix: string; key: (attempt: string) => string } {
  const prefix = `org/${randomUUID()}/project/${randomUUID()}/request/${randomUUID()}`;
  return { prefix, key: (attempt: string) => `${prefix}/attempt/${attempt}/${randomUUID()}` };
}

export interface BudgetLimits {
  readonly maxRequests: number;
  readonly maxBytes: number; // upload + download combined
  readonly cleanupReserve: number; // requests reserved so cleanup always fits within maxRequests
  readonly cleanupByteReserve: number; // BYTES reserved so cleanup has a FINITE allowance (never unlimited)
}

/**
 * Wrap a fetch with: request budget (reserving `cleanupReserve` for the cleanup phase), combined
 * upload+download byte budget, HTTPS enforcement, and redirect rejection.
 */
export function makeBudgetedFetch(inner: typeof fetch, limits: BudgetLimits) {
  let requests = 0;
  let uploadBytes = 0;
  let downloadBytes = 0;
  let cleanupPhase = false;
  const total = (): number => uploadBytes + downloadBytes;
  const fetchImpl = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = String(url);
    if (!u.startsWith('https://')) throw new Error(`live acceptance refuses a non-HTTPS URL: ${u}`);
    // Check the request ceiling BEFORE counting, so a request rejected for exceeding the budget does not
    // itself consume budget (the reserved cleanup capacity stays intact even after a failure).
    const ceiling = cleanupPhase ? limits.maxRequests : limits.maxRequests - limits.cleanupReserve;
    if (requests + 1 > ceiling) throw new Error(`request budget exceeded (phase=${cleanupPhase ? 'cleanup' : 'test'}, ceiling=${ceiling})`);
    const method = String(init.method ?? 'GET');
    const body = init.body as Uint8Array | undefined;
    const bodyLen = body?.byteLength ?? 0;
    // The byte ceiling for THIS phase. Cleanup keeps a FINITE allowance (maxBytes), not unlimited; the test
    // phase reserves `cleanupByteReserve` so cleanup can still transfer after a test-phase budget failure.
    const byteCeiling = cleanupPhase ? limits.maxBytes : limits.maxBytes - limits.cleanupByteReserve;
    // Reject an oversized OUTGOING body BEFORE calling fetch (never send bytes we cannot afford).
    if (bodyLen > 0 && total() + bodyLen > byteCeiling) {
      throw new Error(`outgoing body would exceed the byte budget (received ${total()}, +${bodyLen} > ${byteCeiling})`);
    }
    requests += 1;
    uploadBytes += bodyLen;
    const res = await inner(u, { ...init, redirect: 'error' }); // never follow a redirect to another host
    if (res.status >= 300 && res.status < 400) throw new Error(`live acceptance rejects a redirect (${res.status})`);
    // Count ACTUAL response-body bytes AS THEY ARE CONSUMED into the SHARED counter (do not trust
    // Content-Length; it may be missing). Each chunk is accounted BEFORE the check, so bytes already
    // received — even on a failed or cancelled read — are counted HONESTLY. The check uses the LIVE shared
    // total, so concurrent responses share one budget. HEAD carries no body; its content-length is the
    // OBJECT size (metadata) and must NOT be counted. We consume the original (a clone/tee would deadlock)
    // and rebuild an equivalent Response so the caller can still read it.
    if (method !== 'HEAD' && res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read(); // a rejected read propagates with bytes already counted
        if (done) break;
        if (value) {
          downloadBytes += value.byteLength; // account as consumed, into the shared counter
          chunks.push(value);
          if (total() > byteCeiling) {
            await reader.cancel(); // stop pulling more; the received bytes stay counted (honest)
            throw new Error(`byte budget exceeded (received ${total()} > ${byteCeiling})`);
          }
        }
      }
      const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return new Response(merged.byteLength ? new Uint8Array(merged) : null, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  }) as unknown as typeof fetch;
  return {
    fetch: fetchImpl,
    enterCleanupPhase: (): void => {
      cleanupPhase = true;
    },
    stats: (): { requests: number; uploadBytes: number; downloadBytes: number } => ({ requests, uploadBytes, downloadBytes }),
  };
}

/**
 * Run the provider acceptance scenarios against a store (real or simulated). Every CREATED object key is
 * reported through `track` so cleanup can delete exactly what was made. Proves PG1 (create-only + 412),
 * PG1-concurrent (exactly one create), PG2 (round-trip), PG3 (present-but-WRONG checksum rejected), and
 * PG5 (immutability: ADAPTER overwrite-prevention SEPARATED from CREDENTIAL/provider enforcement).
 */
export async function runAcceptanceScenarios(args: {
  store: S3ObjectStore;
  cfg: S3Config;
  fetchImpl: typeof fetch;
  key: (attempt: string) => string;
  track: (key: string) => void;
}): Promise<void> {
  const { store, cfg, fetchImpl, key, track } = args;

  // PG1 — create when absent; a second create-only is rejected as exists (never a silent overwrite).
  const k1 = key('pg1');
  track(k1);
  const b1 = Buffer.from('{"pg1":true}', 'utf8');
  expect(await store.putIfAbsent(k1, b1, 'application/json')).toBe('created');
  expect(await store.putIfAbsent(k1, Buffer.from('{"pg1":"different"}', 'utf8'), 'application/json')).toBe('exists');

  // PG1-concurrent — two concurrent create-only to the SAME key ⇒ exactly one 'created', one 'exists'.
  const kC = key('pg1-concurrent');
  track(kC);
  const [rc1, rc2] = await Promise.all([
    store.putIfAbsent(kC, b1, 'application/json'),
    store.putIfAbsent(kC, b1, 'application/json'),
  ]);
  expect([rc1, rc2].filter((r) => r === 'created')).toHaveLength(1);
  expect([rc1, rc2].filter((r) => r === 'exists')).toHaveLength(1);

  // PG2 — GET/HEAD round-trip correctness; an absent key reads as absent.
  const k2 = key('pg2');
  track(k2);
  const b2 = Buffer.from('{"pg2":"round-trip"}', 'utf8');
  await store.putIfAbsent(k2, b2, 'application/json');
  expect((await store.head(k2))?.size).toBe(b2.length);
  expect((await store.get(k2)).equals(b2)).toBe(true);
  expect(await store.head(key('pg2-absent'))).toBeNull(); // never created ⇒ nothing to track

  // PG3 — a present-but-WRONG checksum must be rejected by the provider with a CHECKSUM-SPECIFIC error.
  // A low-level probe deliberately sends a checksum that does not match the body (the normal putIfAbsent
  // always sends the correct one). Track the probe key BEFORE sending (so a wrongly-accepted object is
  // still cleaned up), and verify the object is ABSENT afterward. Auth failures (401/403), 5xx, and
  // unsupported (405) must NOT count as a pass — the rejection must specifically be about the checksum.
  const k3 = key('pg3');
  track(k3);
  const b3 = Buffer.from('{"pg3":"bytes"}', 'utf8');
  const wrongChecksum = rawChecksumB64(Buffer.from('completely different bytes', 'utf8'));
  const signed = signS3Request(cfg, {
    method: 'PUT',
    key: k3,
    payloadHash: sha256Hex(b3),
    amzDate: amzDateNow(),
    extraHeaders: { 'content-type': 'application/json', 'if-none-match': '*', 'x-amz-checksum-sha256': wrongChecksum },
  });
  const wrongRes = await fetchImpl(signed.url, { method: 'PUT', headers: signed.headers, body: new Uint8Array(b3) });
  const status = wrongRes.status;
  const errorBody = await wrongRes.text().catch(() => '');
  const code = parseS3ErrorCode(errorBody);
  // Must be a CHECKSUM-SPECIFIC 4xx: the status is a checksum client error AND the parsed provider error
  // code is on the explicit allow-list. Auth (401/403), 5xx, unsupported (405), and any UNKNOWN error code
  // (e.g. a generic 400) all FAIL CLOSED here.
  expect([400, 422], `PG3: expected a checksum 4xx (got ${status})`).toContain(status);
  expect(isChecksumMismatchCode(code), `PG3: error code '${code}' is not an allow-listed checksum-mismatch code`).toBe(true);
  expect(await store.head(k3), 'PG3: a wrong-checksum object must never land').toBeNull();

  // PG5 — immutability, with the two mechanisms it actually proves kept SEPARATE and accurately labelled:
  //   (a) ADAPTER overwrite-prevention: the Hub's ordinary `put` refuses a verification-shaped key (no
  //       provider involved), so the Hub has no unconditional-overwrite code path.
  //   (b) PROVIDER conditional-write enforcement: a second conditional create-only PUT is rejected.
  // What is NOT proven here (remains NOT VERIFIED): a CREDENTIAL-LEVEL prohibition of an unconditional
  // overwrite — i.e. that the credential itself would be DENIED a raw PUT without If-None-Match. That
  // needs a bucket policy / Object Lock and is out of PR-5's scope.
  const k5 = key('pg5');
  track(k5);
  const b5 = Buffer.from('{"pg5":"immutable"}', 'utf8');
  await store.putIfAbsent(k5, b5, 'application/json');
  await expect(store.put(k5, Buffer.from('{"pg5":"tampered"}', 'utf8'), 'application/json')).rejects.toThrow(/verification artifact object/); // (a)
  expect(await store.putIfAbsent(k5, Buffer.from('{"pg5":"tampered"}', 'utf8'), 'application/json')).toBe('exists'); // (b)
  expect((await store.get(k5)).equals(b5)).toBe(true); // original bytes intact
}

/** Delete every tracked object, then LIST the run prefix and assert nothing remains. */
export async function cleanupAndVerify(args: { store: S3ObjectStore; prefix: string; created: readonly string[]; enterCleanupPhase?: () => void }): Promise<void> {
  args.enterCleanupPhase?.();
  for (const key of args.created) {
    try {
      await args.store.delete(key);
    } catch {
      /* best effort — a bucket lifecycle-expiry rule is the backstop */
    }
  }
  const remaining = typeof args.store.list === 'function' ? await args.store.list(args.prefix) : [];
  expect(remaining, `leftover objects under ${args.prefix}`).toEqual([]);
}

/**
 * An in-memory S3 provider simulator (a fetch impl) for OFFLINE exercise of the acceptance logic. It
 * models the guarantees under test: create-only via `If-None-Match: *` (412 on an existing key),
 * checksum verification (400 on a mismatch), byte-exact GET/HEAD/absent, DELETE, and prefix LIST. It is
 * NOT a substitute for the live provider run — it only lets the harness's OWN key-selection/cleanup/budget
 * logic be tested without cloud access.
 */
export function makeInMemoryS3(
  cfg: S3Config,
  faults: { checksumMismatchStatus?: number; acceptWrongChecksum?: boolean; mismatchCode?: string } = {},
): { fetch: typeof fetch; objectCount: () => number } {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  const bucketPath = `/${encodeURIComponent(cfg.bucket)}`;
  const decodeKey = (pathname: string): string =>
    pathname
      .slice(bucketPath.length + 1)
      .split('/')
      .map((seg) => decodeURIComponent(seg))
      .join('/');

  const fetchImpl = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = new URL(String(url));
    const method = String(init.method ?? 'GET');
    const headers = (init.headers ?? {}) as Record<string, string>;

    // Bucket-level LIST (ListObjectsV2).
    if (u.pathname === bucketPath && u.searchParams.get('list-type') === '2') {
      const prefix = u.searchParams.get('prefix') ?? '';
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix));
      const xml = `<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`;
      return new Response(xml, { status: 200, headers: { 'content-length': String(Buffer.byteLength(xml)) } });
    }

    const key = decodeKey(u.pathname);
    if (method === 'PUT') {
      const body = Buffer.from((init.body as Uint8Array) ?? new Uint8Array());
      // Checksum verification (a mismatch is a hard reject — models provider PG3). Fault injection lets the
      // OFFLINE negative tests model a provider that mis-handles a mismatch (auth/5xx/unsupported, or a
      // wrongly-accepted body) so the PG3 assertions are shown to catch those.
      const declared = headers['x-amz-checksum-sha256'];
      if (declared && declared !== createHash('sha256').update(body).digest('base64')) {
        if (faults.acceptWrongChecksum) {
          objects.set(key, { body, contentType: headers['content-type'] ?? 'application/octet-stream' });
          return new Response('', { status: 200, headers: { 'content-length': '0' } });
        }
        // Emit a SPECIFIC error code (e.g. the payload-signing code XAmzContentSHA256Mismatch) with a 4xx
        // status, so a PG3 negative test can prove that code fails closed despite a checksum-class status.
        if (faults.mismatchCode) {
          const xml = `<Error><Code>${faults.mismatchCode}</Code></Error>`;
          return new Response(xml, { status: faults.checksumMismatchStatus ?? 400, headers: { 'content-length': String(xml.length) } });
        }
        if (faults.checksumMismatchStatus) {
          return new Response('<Error><Code>NotAChecksumError</Code></Error>', { status: faults.checksumMismatchStatus });
        }
        return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400, headers: { 'content-length': String('<Error><Code>BadDigest</Code></Error>'.length) } });
      }
      // Create-only: If-None-Match:* fails if the key exists (models provider PG1).
      if (headers['if-none-match'] === '*' && objects.has(key)) {
        return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
      }
      objects.set(key, { body, contentType: headers['content-type'] ?? 'application/octet-stream' });
      return new Response('', { status: 200, headers: { 'content-length': '0' } });
    }
    if (method === 'HEAD') {
      const o = objects.get(key);
      return o
        ? new Response(null, { status: 200, headers: { 'content-length': String(o.body.length), 'content-type': o.contentType } })
        : new Response(null, { status: 404 });
    }
    if (method === 'GET') {
      const o = objects.get(key);
      return o
        ? new Response(new Uint8Array(o.body), { status: 200, headers: { 'content-length': String(o.body.length), 'content-type': o.contentType } })
        : new Response(null, { status: 404 });
    }
    if (method === 'DELETE') {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 405 });
  }) as unknown as typeof fetch;

  return { fetch: fetchImpl, objectCount: () => objects.size };
}
