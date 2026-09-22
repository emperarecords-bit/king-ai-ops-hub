import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { S3ObjectStore } from '@/domain/documents/s3-object-store';
import { s3ExclusiveArtifactWriter } from '@/domain/verification/runtime-adapters';

/**
 * HERMETIC tests for the VER-002 PR-5 S3 create-only publish. A simulated fetch drives every S3 response
 * (2xx / 412 / 409 / 401 / 403 / 5xx / network throw), so these prove the ADAPTER guarantees offline:
 * the request shape (conditional create-only header, exact bytes, base64-of-RAW-digest checksum), the
 * never-an-unconditional-PUT rule, and the conflict/ambiguous/auth/read-failure handling and reconcile.
 * They do NOT and CANNOT prove PROVIDER enforcement — that is the authorized live acceptance run.
 */
const CFG = { endpoint: 'https://s3.test', region: 'auto', bucket: 'test-bucket', accessKeyId: 'AKIATEST', secretAccessKey: 'secret-key' } as const;
const KEY = `org/${randomUUID()}/project/${randomUUID()}/request/${randomUUID()}/attempt/att-1/${randomUUID()}`;
const BODY = Buffer.from('{"passed":true,"pr5":"hermetic"}', 'utf8');
const RAW_B64 = createHash('sha256').update(BODY).digest('base64'); // base64 of the RAW 32-byte digest
const RAW_HEX = createHash('sha256').update(BODY).digest('hex');
const MD5_B64 = createHash('md5').update(BODY).digest('base64'); // base64 of the RAW MD5 digest (Content-MD5)

type Call = { method: string; headers: Record<string, string>; body: Uint8Array | null };
type Step = { status: number; headers?: Record<string, string> } | { throw: true };

/** A simulated `fetch`: records each call and returns scripted responses (by call order) or a default. */
function simFetch(steps: Step[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fn = (async (_url: string, init: RequestInit = {}): Promise<Response> => {
    const method = String(init.method ?? 'GET');
    const headers = (init.headers ?? {}) as Record<string, string>;
    const body = (init.body ?? null) as Uint8Array | null;
    calls.push({ method, headers, body });
    const step = steps[i++] ?? { status: 200 };
    if ('throw' in step) throw new Error('simulated network error');
    return new Response(step.status === 404 ? null : '', { status: step.status, headers: step.headers });
  }) as unknown as typeof fetch;
  return { fetch: fn, calls };
}

const puts = (calls: Call[]): Call[] => calls.filter((c) => c.method === 'PUT');
const heads = (calls: Call[]): Call[] => calls.filter((c) => c.method === 'HEAD');
/** EVERY put must carry the create-only precondition — never an unconditional PUT. */
const allPutsAreConditional = (calls: Call[]): boolean => puts(calls).every((c) => c.headers['if-none-match'] === '*');

describe('VER-002 PR-5 — S3 create-only publish (adapter, hermetic)', () => {
  it('AG1: the PUT is conditional create-only with exact bytes + base64-of-RAW-digest checksum + Content-MD5', async () => {
    const { fetch, calls } = simFetch([{ status: 200 }]);
    const store = new S3ObjectStore(CFG, fetch);
    expect(await store.putIfAbsent(KEY, BODY, 'application/json')).toBe('created');
    const put = puts(calls)[0]!;
    expect(put.headers['if-none-match']).toBe('*');
    expect(put.headers['x-amz-checksum-sha256']).toBe(RAW_B64);
    expect(put.headers['x-amz-checksum-sha256']).not.toBe(RAW_HEX); // must be base64, not hex
    expect(put.headers['content-md5']).toBe(MD5_B64); // additional integrity-at-write (base64 of raw MD5)
    expect(put.headers['content-type']).toBe('application/json');
    expect(Buffer.from(put.body!).equals(BODY)).toBe(true); // exact bytes ⇒ exact Content-Length
    expect(heads(calls).length).toBe(0); // a clean create needs no reconcile
  });

  it('created (2xx) → "created"; a 412 precondition failure → "exists" (definitive); never an unconditional PUT', async () => {
    for (const [status, expected] of [[200, 'created'], [412, 'exists']] as const) {
      const { fetch, calls } = simFetch([{ status }]);
      const store = new S3ObjectStore(CFG, fetch);
      expect(await store.putIfAbsent(KEY, BODY, 'application/json')).toBe(expected);
      expect(allPutsAreConditional(calls)).toBe(true);
      expect(heads(calls).length).toBe(0); // 412 is definitive — no reconcile needed
    }
  });

  it('auth/permission denied (401/403) throws and is NOT retried', async () => {
    for (const status of [401, 403]) {
      const { fetch, calls } = simFetch([{ status }]);
      const store = new S3ObjectStore(CFG, fetch);
      await expect(store.putIfAbsent(KEY, BODY, 'application/json')).rejects.toThrow(/denied/);
      expect(puts(calls).length).toBe(1); // no retry
    }
  });

  it('other 4xx (400) throws and is NOT retried', async () => {
    const { fetch, calls } = simFetch([{ status: 400 }]);
    const store = new S3ObjectStore(CFG, fetch);
    await expect(store.putIfAbsent(KEY, BODY, 'application/json')).rejects.toThrow(/failed: 400/);
    expect(puts(calls).length).toBe(1);
  });

  it('ambiguous (5xx) then a PRESENT object on reconcile → "exists" (no overwrite)', async () => {
    const { fetch, calls } = simFetch([{ status: 503 }, { status: 200, headers: { 'content-length': String(BODY.length) } }]);
    const store = new S3ObjectStore(CFG, fetch);
    expect(await store.putIfAbsent(KEY, BODY, 'application/json')).toBe('exists');
    expect(heads(calls).length).toBe(1); // reconciled by HEAD
    expect(puts(calls).length).toBe(1); // did NOT re-PUT once the object was found present
  });

  it('ambiguous (network throw) then ABSENT then a retry → "created"; every PUT stays conditional', async () => {
    const { fetch, calls } = simFetch([{ throw: true }, { status: 404 }, { status: 200 }]);
    const store = new S3ObjectStore(CFG, fetch);
    expect(await store.putIfAbsent(KEY, BODY, 'application/json')).toBe('created');
    expect(puts(calls).length).toBe(2); // one failed, one retried — both conditional
    expect(allPutsAreConditional(calls)).toBe(true);
  });

  it('persistently ambiguous + absent → throws after bounded attempts; all PUTs conditional', async () => {
    const { fetch, calls } = simFetch([
      { status: 500 }, { status: 404 },
      { status: 500 }, { status: 404 },
      { status: 500 }, { status: 404 },
    ]);
    const store = new S3ObjectStore(CFG, fetch);
    await expect(store.putIfAbsent(KEY, BODY, 'application/json')).rejects.toThrow(/ambiguous after/);
    expect(puts(calls).length).toBe(3); // bounded
    expect(allPutsAreConditional(calls)).toBe(true);
  });

  it('a read failure during reconciliation throws (outcome unconfirmed) — never a silent success', async () => {
    const { fetch } = simFetch([{ status: 500 }, { status: 503 }]); // HEAD 503 → head() throws
    const store = new S3ObjectStore(CFG, fetch);
    await expect(store.putIfAbsent(KEY, BODY, 'application/json')).rejects.toThrow(/reconcile HEAD failed/);
  });

  describe('a 409 Conflict is RECONCILED (not assumed to mean exists)', () => {
    it('409 then a PRESENT object on reconcile → "exists"', async () => {
      const { fetch, calls } = simFetch([{ status: 409 }, { status: 200, headers: { 'content-length': String(BODY.length) } }]);
      const store = new S3ObjectStore(CFG, fetch);
      expect(await store.putIfAbsent(KEY, BODY, 'application/json')).toBe('exists');
      expect(puts(calls).length).toBe(1);
      expect(heads(calls).length).toBe(1); // reconciled by HEAD, not assumed
    });

    it('409 then ABSENT → a bounded, still-conditional retry → "created"', async () => {
      const { fetch, calls } = simFetch([{ status: 409 }, { status: 404 }, { status: 200 }]);
      const store = new S3ObjectStore(CFG, fetch);
      expect(await store.putIfAbsent(KEY, BODY, 'application/json')).toBe('created');
      expect(puts(calls).length).toBe(2);
      expect(allPutsAreConditional(calls)).toBe(true);
    });

    it('409 then a reconcile READ error → throws (outcome unconfirmed)', async () => {
      const { fetch } = simFetch([{ status: 409 }, { status: 503 }]); // HEAD 503 → head() throws
      const store = new S3ObjectStore(CFG, fetch);
      await expect(store.putIfAbsent(KEY, BODY, 'application/json')).rejects.toThrow(/reconcile HEAD failed/);
    });

    it('409 then ABSENT past the grant deadline → NOT retried (expiry-bounded)', async () => {
      const { fetch, calls } = simFetch([{ status: 409 }, { status: 404 }, { status: 200 }]);
      const store = new S3ObjectStore(CFG, fetch);
      await expect(store.putIfAbsent(KEY, BODY, 'application/json', { deadline: new Date(Date.now() - 1000) })).rejects.toThrow(/grant expired/);
      expect(puts(calls).length).toBe(1); // reconciled once, then the expired grant blocked the retry
    });
  });

  it('grant expiry is enforced BEFORE an internal retry — an ambiguous+absent outcome is not retried past the deadline', async () => {
    const { fetch, calls } = simFetch([{ status: 500 }, { status: 404 }]); // ambiguous, then absent (would retry)
    const store = new S3ObjectStore(CFG, fetch);
    const pastDeadline = new Date(Date.now() - 1000);
    await expect(store.putIfAbsent(KEY, BODY, 'application/json', { deadline: pastDeadline })).rejects.toThrow(/grant expired/);
    expect(puts(calls).length).toBe(1); // the first attempt ran; the retry was refused because the grant expired
    expect(heads(calls).length).toBe(1); // it reconciled once (absent) before the deadline blocked the retry
  });
});

describe('VER-002 PR-5 — S3 create-only writer + fail-closed factory gate', () => {
  it('the S3 exclusive writer streams into a bounded buffer and publishes via putIfAbsent', async () => {
    const { fetch, calls } = simFetch([{ status: 200 }]);
    const store = new S3ObjectStore(CFG, fetch);
    const writer = s3ExclusiveArtifactWriter(store);
    const staged = await writer.stage(KEY);
    await staged.append(BODY.subarray(0, 5));
    await staged.append(BODY.subarray(5));
    expect(await staged.publish('application/json')).toBe('created');
    await staged.discard();
    expect(Buffer.from(puts(calls)[0]!.body!).equals(BODY)).toBe(true);
  });

  it('the S3 writer aborts a stream that exceeds the per-artifact cap', async () => {
    const { fetch } = simFetch([{ status: 200 }]);
    const staged = await s3ExclusiveArtifactWriter(new S3ObjectStore(CFG, fetch)).stage(KEY);
    await expect(staged.append(Buffer.alloc(26 * 1024 * 1024))).rejects.toThrow(/per-artifact cap/);
  });

  describe('factory gate', () => {
    beforeEach(() => {
      // serverEnv() validates the whole environment; give the minimum valid, non-production values.
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('DATABASE_URL', 'postgresql://u:p@localhost:5432/db');
      vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai');
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
      vi.stubEnv('APP_ENCRYPTION_KEY', 'nEX663P2IcY+6NtCNY+TQv++9YWvHn0v8gOcs5AawYw=');
    });
    afterEach(() => {
      vi.unstubAllEnvs();
      vi.resetModules();
    });

    it('exclusiveArtifactWriter FAILS CLOSED for the S3 driver when VERIFICATION_RUNNER_UPLOAD_S3_ENABLED is off', async () => {
      vi.resetModules();
      vi.stubEnv('VERIFICATION_RUNNER_UPLOAD_S3_ENABLED', '0');
      const { exclusiveArtifactWriter: freshFactory } = await import('@/domain/verification/runtime-adapters');
      const { S3ObjectStore: FreshS3 } = await import('@/domain/documents/s3-object-store');
      const writer = await freshFactory(new FreshS3(CFG, simFetch([]).fetch));
      // Cross-module-instance identity (resetModules) makes `instanceof` unreliable; assert the type by
      // its name + message instead.
      await expect(writer.stage(KEY)).rejects.toThrow(/does not support atomic create-only/);
    });

    it('the fail-closed error is an UnsupportedExclusiveWriteError', async () => {
      vi.resetModules();
      vi.stubEnv('VERIFICATION_RUNNER_UPLOAD_S3_ENABLED', '0');
      const { exclusiveArtifactWriter: freshFactory } = await import('@/domain/verification/runtime-adapters');
      const { S3ObjectStore: FreshS3 } = await import('@/domain/documents/s3-object-store');
      const writer = await freshFactory(new FreshS3(CFG, simFetch([]).fetch));
      const err = await writer.stage(KEY).then(() => null).catch((e: Error) => e);
      expect(err?.name).toBe('UnsupportedExclusiveWriteError');
    });

    it('exclusiveArtifactWriter returns the S3 create-only writer when the gate is explicitly on', async () => {
      vi.resetModules();
      vi.stubEnv('VERIFICATION_RUNNER_UPLOAD_S3_ENABLED', '1');
      const { exclusiveArtifactWriter: freshFactory } = await import('@/domain/verification/runtime-adapters');
      const { S3ObjectStore: FreshS3 } = await import('@/domain/documents/s3-object-store');
      const { fetch, calls } = simFetch([{ status: 200 }]);
      const writer = await freshFactory(new FreshS3(CFG, fetch));
      const staged = await writer.stage(KEY);
      await staged.append(BODY);
      expect(await staged.publish('application/json')).toBe('created');
      expect(allPutsAreConditional(calls)).toBe(true);
    });
  });
});
