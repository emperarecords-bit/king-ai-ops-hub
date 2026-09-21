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
  const fetchImpl = (async (url: string, init: RequestInit = {}): Promise<Response> => {
    const u = String(url);
    if (!u.startsWith('https://')) throw new Error(`live acceptance refuses a non-HTTPS URL: ${u}`);
    // Check the ceiling BEFORE counting, so a request rejected for exceeding the budget does not itself
    // consume budget (leaving the reserved cleanup capacity intact).
    const ceiling = cleanupPhase ? limits.maxRequests : limits.maxRequests - limits.cleanupReserve;
    if (requests + 1 > ceiling) throw new Error(`request budget exceeded (phase=${cleanupPhase ? 'cleanup' : 'test'}, ceiling=${ceiling})`);
    requests += 1;
    const body = init.body as Uint8Array | undefined;
    if (body) uploadBytes += body.byteLength ?? 0;
    const res = await inner(u, { ...init, redirect: 'error' }); // never follow a redirect to another host
    if (res.status >= 300 && res.status < 400) throw new Error(`live acceptance rejects a redirect (${res.status})`);
    downloadBytes += Number(res.headers.get('content-length') ?? 0) || 0;
    if (uploadBytes + downloadBytes > limits.maxBytes) throw new Error(`byte budget exceeded (${limits.maxBytes})`);
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

  // PG3 — present-but-WRONG checksum is REJECTED by the provider. A low-level probe that deliberately
  // sends a checksum that does not match the body (normal putIfAbsent always sends the correct one).
  const k3 = key('pg3');
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
  if (wrongRes.ok) track(k3); // if the provider WRONGLY accepted it, still clean it up
  expect(wrongRes.ok, 'provider must reject a body whose checksum does not match').toBe(false);

  // PG5 — immutability, with the two mechanisms kept SEPARATE:
  const k5 = key('pg5');
  track(k5);
  const b5 = Buffer.from('{"pg5":"immutable"}', 'utf8');
  await store.putIfAbsent(k5, b5, 'application/json');
  // (a) ADAPTER overwrite-prevention (no provider needed): ordinary put refuses a verification-shaped key.
  await expect(store.put(k5, Buffer.from('{"pg5":"tampered"}', 'utf8'), 'application/json')).rejects.toThrow(/verification artifact object/);
  // (b) CREDENTIAL/PROVIDER enforcement: a second conditional create-only is rejected by the provider.
  expect(await store.putIfAbsent(k5, Buffer.from('{"pg5":"tampered"}', 'utf8'), 'application/json')).toBe('exists');
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
export function makeInMemoryS3(cfg: S3Config): { fetch: typeof fetch; objectCount: () => number } {
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
      // Checksum verification (a mismatch is a hard reject — models provider PG3).
      const declared = headers['x-amz-checksum-sha256'];
      if (declared && declared !== createHash('sha256').update(body).digest('base64')) {
        return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400 });
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
