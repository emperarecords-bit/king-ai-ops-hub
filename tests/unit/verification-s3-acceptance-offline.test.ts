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
const LIMITS: BudgetLimits = { maxRequests: 60, maxBytes: 30 * 1024 * 1024, cleanupReserve: 15 };
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
    expect(created.length).toBeGreaterThanOrEqual(4);
    for (const k of created) {
      expect(k, k).toMatch(VERIFICATION_KEY);
      expect(isVerificationArtifactKey(k), k).toBe(true);
      expect(k.startsWith(keys.prefix)).toBe(true);
    }
    expect(sim.objectCount()).toBe(created.length); // the rejected wrong-checksum object was NOT stored

    await cleanupAndVerify({ store, prefix: keys.prefix, created, enterCleanupPhase: budgeted.enterCleanupPhase });
    expect(sim.objectCount()).toBe(0); // cleanup removed exactly what was created
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
      const limits: BudgetLimits = { maxRequests: 5, maxBytes: 1024, cleanupReserve: 2 };
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

    it('counts BOTH upload and download bytes toward the byte budget', async () => {
      const innerBig = (async () => new Response('', { status: 200, headers: { 'content-length': '600' } })) as unknown as typeof fetch;
      const b = makeBudgetedFetch(innerBig, { maxRequests: 60, maxBytes: 1000, cleanupReserve: 5 });
      // 500 uploaded + 600 downloaded = 1100 > 1000 → byte budget exceeded (proves both are counted).
      await expect(b.fetch('https://ok.test/x', { method: 'PUT', body: new Uint8Array(500) })).rejects.toThrow(/byte budget exceeded/);
    });
  });
});
