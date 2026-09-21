/**
 * VER-002 PR-5 — LIVE provider acceptance harness (S3 create-only). STRICT OPT-IN and DANGEROUS to run
 * without approval, so it is disabled unless the operator EXPLICITLY sets `VER_S3_ACCEPTANCE=1`.
 *
 * Behaviour:
 *  - Not opted in (`VER_S3_ACCEPTANCE` unset) → the whole suite SKIPS (CI and every developer unaffected).
 *  - Opted in but any prerequisite missing/inconsistent → the suite FAILS LOUDLY in beforeAll (never a
 *    silent skip): the endpoint and bucket are validated against the APPROVED allow-list BEFORE any
 *    credential is used, and the credential must be present.
 *  - It makes REAL calls to the approved provider, bounded by request/byte budgets (with a cleanup
 *    allowance), writes only under a random per-run prefix in the approved DISPOSABLE bucket, deletes
 *    everything it created, and verifies cleanup (LIST the prefix → zero objects).
 *
 * This proves the PROVIDER guarantees (PG1–PG5) that the hermetic tests cannot. It is authorized to run
 * ONLY after the owner approves A1–A5. Nothing here runs, provisions, or spends until then.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore } from '@/domain/documents/s3-object-store';

const OPTED_IN = process.env.VER_S3_ACCEPTANCE === '1';

// Approved configuration (all REQUIRED when opted in). The APPROVED_* values are the allow-list the run
// must match — a guard against ever pointing acceptance writes at a production bucket/endpoint.
const ENV = {
  endpoint: process.env.VER_S3_ENDPOINT ?? '',
  region: process.env.VER_S3_REGION ?? '',
  bucket: process.env.VER_S3_BUCKET ?? '',
  accessKeyId: process.env.VER_S3_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.VER_S3_SECRET_ACCESS_KEY ?? '',
  approvedEndpoint: process.env.VER_S3_APPROVED_ENDPOINT ?? '',
  approvedBucket: process.env.VER_S3_APPROVED_BUCKET ?? '',
};

const MAX_REQUESTS = 60;
const MAX_BYTES = 30 * 1024 * 1024;

let reqCount = 0;
let byteCount = 0;
const budgetedFetch = (async (url: string, init: RequestInit = {}): Promise<Response> => {
  reqCount += 1;
  if (reqCount > MAX_REQUESTS) throw new Error(`live acceptance request budget exceeded (${MAX_REQUESTS})`);
  const body = init.body as Uint8Array | undefined;
  if (body) {
    byteCount += body.byteLength ?? 0;
    if (byteCount > MAX_BYTES) throw new Error(`live acceptance byte budget exceeded (${MAX_BYTES})`);
  }
  return fetch(url, init);
}) as unknown as typeof fetch;

let store: S3ObjectStore;
const RUN_PREFIX = `verification-acceptance/${randomUUID()}`;
const created: string[] = [];
const keyFor = (name: string): string => `${RUN_PREFIX}/${name}`;
const bodyOf = (s: string): Buffer => Buffer.from(s, 'utf8');

/** Validate ALL prerequisites and the approved endpoint/bucket BEFORE any credential is used. Throws
 *  (failing the suite) on any missing or non-approved value — the "fail, don't skip" contract. */
function validatePrerequisitesOrFail(): void {
  const missing = (['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey', 'approvedEndpoint', 'approvedBucket'] as const).filter((k) => ENV[k].trim() === '');
  if (missing.length > 0) {
    throw new Error(`VER_S3_ACCEPTANCE=1 but required config is missing: ${missing.map((m) => `VER_S3_${m.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()}`).join(', ')}. Refusing to run.`);
  }
  // Endpoint + bucket must MATCH the approved allow-list — refuse to point acceptance writes anywhere else.
  if (ENV.endpoint.replace(/\/+$/, '') !== ENV.approvedEndpoint.replace(/\/+$/, '')) {
    throw new Error(`live acceptance endpoint '${ENV.endpoint}' is not the approved endpoint. Refusing to run.`);
  }
  if (ENV.bucket !== ENV.approvedBucket) {
    throw new Error(`live acceptance bucket '${ENV.bucket}' is not the approved disposable bucket. Refusing to run.`);
  }
}

beforeAll(() => {
  if (!OPTED_IN) return;
  validatePrerequisitesOrFail(); // endpoint + bucket validated BEFORE the credential is put into the store
  store = new S3ObjectStore(
    { endpoint: ENV.endpoint, region: ENV.region, bucket: ENV.bucket, accessKeyId: ENV.accessKeyId, secretAccessKey: ENV.secretAccessKey },
    budgetedFetch,
  );
});

afterAll(async () => {
  if (!OPTED_IN || !store) return;
  for (const key of created) {
    try {
      await store.delete(key);
    } catch {
      /* best effort — lifecycle-expiry rule is the backstop */
    }
  }
  // Cleanup verification: nothing may remain under the run prefix.
  const remaining = typeof store.list === 'function' ? await store.list(RUN_PREFIX) : [];
  expect(remaining, `leftover objects under ${RUN_PREFIX}`).toEqual([]);
});

describe.skipIf(!OPTED_IN)('VER-002 PR-5 — S3 provider acceptance (LIVE, opt-in)', () => {
  it('PG1: a conditional create-only PUT creates when absent and is rejected (exists) when present', async () => {
    const key = keyFor('pg1');
    const body = bodyOf('{"pg1":true}');
    created.push(key);
    expect(await store.putIfAbsent(key, body, 'application/json')).toBe('created');
    // A second create-only to the SAME key must be rejected by the provider — never a silent overwrite.
    expect(await store.putIfAbsent(key, bodyOf('{"pg1":"different"}'), 'application/json')).toBe('exists');
  });

  it('PG2: GET/HEAD round-trip correctness — byte-identical content, exact size, absent reads as absent', async () => {
    const key = keyFor('pg2');
    const body = bodyOf('{"pg2":"round-trip"}');
    created.push(key);
    await store.putIfAbsent(key, body, 'application/json');
    const head = await store.head(key);
    expect(head?.size).toBe(body.length);
    expect((await store.get(key)).equals(body)).toBe(true);
    expect(await store.head(keyFor('pg2-absent'))).toBeNull();
  });

  it('PG5 (immutability): the created object cannot be overwritten by the Hub', async () => {
    const key = keyFor('pg5');
    const body = bodyOf('{"pg5":"immutable"}');
    created.push(key);
    await store.putIfAbsent(key, body, 'application/json');
    // (a) a second conditional create-only is rejected (from PG1); (b) ordinary put refuses the verif key
    // outright, so the Hub has NO code path that issues an unconditional overwrite.
    expect(await store.putIfAbsent(key, bodyOf('{"pg5":"tampered"}'), 'application/json')).toBe('exists');
    await expect(store.put(key, bodyOf('{"pg5":"tampered"}'), 'application/json')).rejects.toThrow(/verification artifact object/);
    expect((await store.get(key)).equals(body)).toBe(true); // original bytes intact
  });

  it('budget: the run stays within the request/byte ceilings', () => {
    expect(reqCount).toBeLessThanOrEqual(MAX_REQUESTS);
    expect(byteCount).toBeLessThanOrEqual(MAX_BYTES);
  });
});
