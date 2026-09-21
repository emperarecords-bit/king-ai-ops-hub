import { describe, expect, it } from 'vitest';
import { S3ObjectStore } from '@/domain/documents/s3-object-store';
import { isVerificationArtifactKey } from '@/domain/documents/object-store';
import { cleanupAndVerify, makeAcceptanceKeys, makeBudgetedFetch, makeInMemoryS3, runAcceptanceScenarios, type BudgetLimits } from '../support/s3-acceptance';

/**
 * OFFLINE exercise of the LIVE acceptance harness's own logic (key selection, scenarios, budgets,
 * cleanup) against an in-memory S3 simulator — so its bugs are caught in CI without cloud access. This
 * does NOT verify the real provider; the provider guarantees remain NOT VERIFIED until the authorized run.
 */
const CFG = { endpoint: 'https://sim.test', region: 'auto', bucket: 'king-verification-acceptance-test', accessKeyId: 'AKIASIM', secretAccessKey: 'sim-secret' } as const;
const LIMITS: BudgetLimits = { maxRequests: 60, maxBytes: 30 * 1024 * 1024, cleanupReserve: 15, cleanupByteReserve: 1024 * 1024 };
const VERIFICATION_KEY = /^org\/[^/]+\/project\/[^/]+\/request\/[^/]+\/attempt\/[^/]+\/[^/]+$/;

describe('VER-002 PR-5 — acceptance harness offline (simulated provider)', () => {
  it('runs all scenarios, uses PRODUCTION-SHAPED keys, tracks them, and cleans up to empty', async () => {
    const sim = makeInMemoryS3(CFG);
    const budgeted = makeBudgetedFetch(sim.fetch, LIMITS);
    const store = new S3ObjectStore(CFG, budgeted.fetch);
    const keys = makeAcceptanceKeys();
    const created: string[] = [];

    await runAcceptanceScenarios({ store, cfg: CFG, fetchImpl: budgeted.fetch, key: keys.key, track: (k) => created.push(k) });

    // Every tracked key is a production-shaped verification artifact key (would trip the `put` guard).
    expect(created.length).toBeGreaterThanOrEqual(5); // PG1, PG1-concurrent, PG2, PG3 (rejected but tracked), PG5
    for (const k of created) {
      expect(k, k).toMatch(VERIFICATION_KEY);
      expect(isVerificationArtifactKey(k), k).toBe(true);
      expect(k.startsWith(keys.prefix)).toBe(true);
    }
    // The rejected wrong-checksum probe (PG3) is tracked but was NOT stored, so ≤ created.length landed.
    expect(sim.objectCount()).toBeLessThanOrEqual(created.length);
    expect(sim.objectCount()).toBeGreaterThan(0);

    await cleanupAndVerify({ store, prefix: keys.prefix, created, enterCleanupPhase: budgeted.enterCleanupPhase });
    expect(sim.objectCount()).toBe(0); // cleanup removed everything created (deletes of the never-stored probe are no-ops)
    expect(budgeted.stats().requests).toBeLessThanOrEqual(LIMITS.maxRequests);
  });

  it('cleanup verification FAILS when a created key is not tracked (catches a tracking bug)', async () => {
    const sim = makeInMemoryS3(CFG);
    const store = new S3ObjectStore(CFG, makeBudgetedFetch(sim.fetch, LIMITS).fetch);
    const keys = makeAcceptanceKeys();
    // Create an object but DON'T track it — cleanup must then leave it behind and the LIST assertion fails.
    await store.putIfAbsent(keys.key('untracked'), Buffer.from('x'), 'application/json');
    await expect(cleanupAndVerify({ store, prefix: keys.prefix, created: [] })).rejects.toThrow();
    expect(sim.objectCount()).toBe(1); // proof the leak was real
  });

  describe('negative: the acceptance assertions CATCH a mishandled wrong-checksum (PG3)', () => {
    it.each([
      ['an auth failure (401)', { checksumMismatchStatus: 401 }],
      ['an auth failure (403)', { checksumMismatchStatus: 403 }],
      ['a 5xx (503)', { checksumMismatchStatus: 503 }],
      ['an unsupported op (405)', { checksumMismatchStatus: 405 }],
      // The decisive regression for finding 1: a 400 whose <Code> is NOT a checksum-mismatch code
      // ('NotAChecksumError' — note it CONTAINS the substring "Checksum"). The status alone would pass, so
      // the allow-list parse must FAIL CLOSED. A substring test would have wrongly passed this.
      ['a 400 with a NON-checksum <Code> (NotAChecksumError)', { checksumMismatchStatus: 400 }],
      // The narrowed allow-list must FAIL CLOSED on the PAYLOAD-SIGNING code: XAmzContentSHA256Mismatch is
      // about the SigV4 x-amz-content-sha256 request hash, NOT a rejection of the x-amz-checksum-sha256
      // VALUE, so a 400 carrying it must not count as a PG3 pass.
      ['a 400 payload-signing code (XAmzContentSHA256Mismatch)', { mismatchCode: 'XAmzContentSHA256Mismatch' }],
      ['a WRONGLY-ACCEPTED body (200)', { acceptWrongChecksum: true }],
    ])('fails PG3 when a wrong checksum yields %s', async (_label, faults) => {
      const sim = makeInMemoryS3(CFG, faults);
      const bf = makeBudgetedFetch(sim.fetch, LIMITS);
      const store = new S3ObjectStore(CFG, bf.fetch);
      const keys = makeAcceptanceKeys();
      await expect(
        runAcceptanceScenarios({ store, cfg: CFG, fetchImpl: bf.fetch, key: keys.key, track: () => {} }),
      ).rejects.toThrow();
    });
  });

  describe('budgeted fetch', () => {
    const inner200 = (async () => new Response('x', { status: 200, headers: { 'content-length': '1' } })) as unknown as typeof fetch;

    it('enforces HTTPS', async () => {
      const b = makeBudgetedFetch(inner200, LIMITS);
      await expect(b.fetch('http://insecure.test/x')).rejects.toThrow(/non-HTTPS/);
    });

    it('rejects redirects', async () => {
      const inner302 = (async () => new Response('', { status: 302, headers: { location: 'https://evil.test' } })) as unknown as typeof fetch;
      const b = makeBudgetedFetch(inner302, LIMITS);
      await expect(b.fetch('https://ok.test/x')).rejects.toThrow(/redirect/);
    });

    it('reserves cleanup capacity: the test phase stops short of the reserve, cleanup uses it', async () => {
      const limits: BudgetLimits = { maxRequests: 5, maxBytes: 1024, cleanupReserve: 2, cleanupByteReserve: 0 };
      const b = makeBudgetedFetch(inner200, limits);
      await b.fetch('https://ok.test/1');
      await b.fetch('https://ok.test/2');
      await b.fetch('https://ok.test/3'); // test-phase ceiling = maxRequests - reserve = 3
      await expect(b.fetch('https://ok.test/4')).rejects.toThrow(/request budget exceeded \(phase=test/);
      b.enterCleanupPhase();
      await b.fetch('https://ok.test/cleanup-4');
      await b.fetch('https://ok.test/cleanup-5'); // up to maxRequests = 5
      await expect(b.fetch('https://ok.test/6')).rejects.toThrow(/request budget exceeded \(phase=cleanup/);
    });

    it('counts ACTUAL response-body bytes with NO Content-Length header toward the byte budget', async () => {
      // A response with a real 1200-byte body and NO content-length must still be counted by actual bytes
      // and blow a 1000-byte budget (proves missing-Content-Length is handled by reading the body).
      const innerNoCl = (async () => new Response(new Uint8Array(1200), { status: 200 })) as unknown as typeof fetch;
      const b = makeBudgetedFetch(innerNoCl, { maxRequests: 60, maxBytes: 1000, cleanupReserve: 5, cleanupByteReserve: 0 });
      await expect(b.fetch('https://ok.test/x')).rejects.toThrow(/byte budget exceeded/);
      // The bytes already received are reported honestly (counted before the cancellation).
      expect(b.stats().downloadBytes).toBeGreaterThanOrEqual(1000);
    });

    it('enforces SHARED accounting across concurrent responses (one budget, cancel on exhaustion)', async () => {
      // Two concurrent 600-byte responses total 1200 > the 1000-byte test ceiling; the shared counter makes
      // at least one exceed and cancel, and the received bytes are reported honestly.
      const inner600 = (async () => new Response(new Uint8Array(600), { status: 200 })) as unknown as typeof fetch;
      const b = makeBudgetedFetch(inner600, { maxRequests: 60, maxBytes: 1000, cleanupReserve: 5, cleanupByteReserve: 0 });
      const results = await Promise.allSettled([b.fetch('https://ok.test/a'), b.fetch('https://ok.test/b')]);
      expect(results.some((r) => r.status === 'rejected')).toBe(true);
      expect(b.stats().downloadBytes).toBeGreaterThan(1000); // honest: includes the over-threshold bytes
    });

    it('keeps a FINITE cleanup byte allowance (cleanup is not unlimited)', async () => {
      const inner = (async () => new Response(new Uint8Array(200), { status: 200 })) as unknown as typeof fetch;
      const b = makeBudgetedFetch(inner, { maxRequests: 60, maxBytes: 100, cleanupReserve: 5, cleanupByteReserve: 50 });
      b.enterCleanupPhase();
      // Even in cleanup, a 200-byte response exceeds the finite maxBytes (100) → rejected.
      await expect(b.fetch('https://ok.test/cleanup-big')).rejects.toThrow(/byte budget exceeded/);
    });

    it('excludes HEAD object-size metadata from the byte budget', async () => {
      // HEAD carries no body; its content-length is the OBJECT size (metadata) and must not be counted.
      const innerHead = (async () => new Response(null, { status: 200, headers: { 'content-length': '9999999' } })) as unknown as typeof fetch;
      const b = makeBudgetedFetch(innerHead, { maxRequests: 60, maxBytes: 1000, cleanupReserve: 5, cleanupByteReserve: 0 });
      await b.fetch('https://ok.test/x', { method: 'HEAD' });
      expect(b.stats().downloadBytes).toBe(0);
    });

    it('rejects an oversized OUTGOING body BEFORE calling fetch', async () => {
      let innerCalled = 0;
      const inner = (async () => {
        innerCalled += 1;
        return new Response('', { status: 200, headers: { 'content-length': '0' } });
      }) as unknown as typeof fetch;
      const b = makeBudgetedFetch(inner, { maxRequests: 60, maxBytes: 100, cleanupReserve: 5, cleanupByteReserve: 0 });
      await expect(b.fetch('https://ok.test/x', { method: 'PUT', body: new Uint8Array(200) })).rejects.toThrow(/outgoing body would exceed/);
      expect(innerCalled).toBe(0); // never sent
    });

    it('preserves cleanup capacity after a byte-budget failure', async () => {
      const inner = (async () => new Response('x', { status: 200, headers: { 'content-length': '1' } })) as unknown as typeof fetch;
      const b = makeBudgetedFetch(inner, { maxRequests: 60, maxBytes: 100, cleanupReserve: 5, cleanupByteReserve: 0 });
      await expect(b.fetch('https://ok.test/big', { method: 'PUT', body: new Uint8Array(200) })).rejects.toThrow(/outgoing body would exceed/);
      // Cleanup keeps the reserved allowance: a no-body DELETE still fits and completes after the failure.
      b.enterCleanupPhase();
      await expect(b.fetch('https://ok.test/cleanup', { method: 'DELETE' })).resolves.toBeDefined();
    });
  });
});
