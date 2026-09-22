import { describe, expect, it } from 'vitest';
import { S3ObjectStore } from '@/domain/documents/s3-object-store';
import { isVerificationArtifactKey } from '@/domain/documents/object-store';
import { createHash } from 'node:crypto';
import { buildN2SignedRequest, cleanupAndReport, cleanupAndVerify, makeAcceptanceKeys, makeBudgetedFetch, makeInMemoryS3, runAcceptanceScenarios, runDiagAOriginalWrongChecksum, runDiagBAddedSdkAlgo, runDiagCCorrectControl, runN1WrongContentMd5, runN2WrongPayloadHash, runP1ContentMd5Control, runP2PayloadHashControl, runPG1Concurrent, runPG3, runPG5, type AcceptanceCtx, type BudgetLimits, type DiagEvidence, type RunTotals } from '../support/s3-acceptance';

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
    expect(created.length).toBeGreaterThanOrEqual(8); // PG1, PG1-concurrent, PG2, PG5, N1, P1, N2, P2
    for (const k of created) {
      expect(k, k).toMatch(VERIFICATION_KEY);
      expect(isVerificationArtifactKey(k), k).toBe(true);
      expect(k.startsWith(keys.prefix)).toBe(true);
    }
    // The rejected N1 (wrong Content-MD5) and N2 (wrong payload hash) are tracked but NOT stored, so the
    // number of landed objects is ≤ created.length.
    expect(sim.objectCount()).toBeLessThanOrEqual(created.length);
    expect(sim.objectCount()).toBeGreaterThan(0);

    await cleanupAndVerify({ store, prefix: keys.prefix, created, enterCleanupPhase: budgeted.enterCleanupPhase });
    expect(sim.objectCount()).toBe(0); // cleanup removed everything created (deletes of the never-stored negatives are no-ops)
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

  describe('provider-verified integrity-at-write — Content-MD5 (N1/P1) + payload-hash (N2/P2)', () => {
    const freshCtx = (faults?: Parameters<typeof makeInMemoryS3>[1]) => {
      const sim = makeInMemoryS3(CFG, faults);
      const bf = makeBudgetedFetch(sim.fetch, LIMITS);
      const store = new S3ObjectStore(CFG, bf.fetch);
      const keys = makeAcceptanceKeys();
      const created: string[] = [];
      const ctx: AcceptanceCtx = { store, cfg: CFG, fetchImpl: bf.fetch, key: keys.key, track: (k) => created.push(k) };
      return { sim, bf, store, keys, created, ctx };
    };

    it('N1 rejects a wrong Content-MD5 (400 BadDigest, absent); P1 correct is stored + read back', async () => {
      const { sim, bf, store, keys, created, ctx } = freshCtx();
      await expect(runN1WrongContentMd5(ctx)).resolves.toBeUndefined();
      await expect(runP1ContentMd5Control(ctx)).resolves.toBeUndefined();
      expect(sim.objectCount()).toBe(1); // only P1 landed; N1 rejected
      await cleanupAndVerify({ store, prefix: keys.prefix, created, enterCleanupPhase: bf.enterCleanupPhase });
      expect(sim.objectCount()).toBe(0);
    });

    it('N2 rejects a wrong x-amz-content-sha256 (400 XAmzContentSHA256Mismatch, absent); P2 correct is stored + read back', async () => {
      const { sim, bf, store, keys, created, ctx } = freshCtx();
      await expect(runN2WrongPayloadHash(ctx)).resolves.toBeUndefined();
      await expect(runP2PayloadHashControl(ctx)).resolves.toBeUndefined();
      expect(sim.objectCount()).toBe(1); // only P2 landed; N2 rejected
      await cleanupAndVerify({ store, prefix: keys.prefix, created, enterCleanupPhase: bf.enterCleanupPhase });
      expect(sim.objectCount()).toBe(0);
    });

    it('N1 passes ONLY on its own 400 BadDigest — a provider that accepts a wrong Content-MD5 (200) fails N1', async () => {
      const { ctx } = freshCtx({ acceptWrongContentMd5: true });
      await expect(runN1WrongContentMd5(ctx)).rejects.toThrow(/N1: expected HTTP 400/);
    });

    it('N2 passes ONLY on its own 400 XAmzContentSHA256Mismatch — a provider that accepts a wrong hash (200) fails N2', async () => {
      const { ctx } = freshCtx({ acceptWrongPayloadHash: true });
      await expect(runN2WrongPayloadHash(ctx)).rejects.toThrow(/N2: expected HTTP 400/);
    });

    it('offline signing verification: N2 is signed OVER the wrong hash (self-consistent), not a broken signature', () => {
      const keys = makeAcceptanceKeys();
      const b = buildN2SignedRequest(CFG, keys.key('n2-sign'));
      const auth = b.headers['authorization'] ?? b.headers['Authorization'] ?? '';
      const signedHeaders = (auth.match(/SignedHeaders=([^,]+)/)?.[1] ?? '').split(';');
      // The declared payload hash is the WRONG value, it is part of SignedHeaders, and the signature is a
      // real SigV4 signature that is BOUND to the payload hash (signing the identical request with the
      // correct hash yields a different signature) — so a live N2 rejection is payload validation, not a
      // broken/absent signature.
      expect(b.headers['x-amz-content-sha256']).toBe(b.wrongHash);
      expect(signedHeaders).toContain('x-amz-content-sha256');
      expect(b.wrongSignature).toMatch(/^[0-9a-f]{64}$/);
      expect(b.wrongSignature).not.toBe(b.correctSignature);
    });
  });

  describe('independent per-guarantee steps (a PG3 failure must not block PG5)', () => {
    it('evaluates PG5 even after a PG3 assertion failure; an assertion failure does NOT trip the fuse', async () => {
      // Provider ACCEPTS the wrong checksum (returns 200) → PG3's BadDigest-only assertion FAILS. PG5 must
      // still run and pass, and the budget/safety fuse must stay untripped (an assertion failure is not a
      // budget/safety stop). This is the offline proof of the live harness's per-`it()` independence.
      const sim = makeInMemoryS3(CFG, { acceptWrongChecksum: true });
      const bf = makeBudgetedFetch(sim.fetch, LIMITS);
      const store = new S3ObjectStore(CFG, bf.fetch);
      const keys = makeAcceptanceKeys();
      const created: string[] = [];
      const ctx: AcceptanceCtx = { store, cfg: CFG, fetchImpl: bf.fetch, key: keys.key, track: (k) => created.push(k) };

      await expect(runPG3(ctx)).rejects.toThrow(/PG3: expected a checksum 4xx \(got 200\)/); // PG3 fails (200 accepted)
      await expect(runPG5(ctx)).resolves.toBeUndefined(); // PG5 STILL evaluated and passes
      expect(bf.stats().tripped).toBe(false); // an ordinary assertion failure never trips the safety fuse

      await cleanupAndVerify({ store, prefix: keys.prefix, created, enterCleanupPhase: bf.enterCleanupPhase });
      expect(sim.objectCount()).toBe(0); // both the accepted wrong-checksum object and the PG5 object removed
    });

    it('cleanupAndReport reports final counters in a finally EVEN WHEN cleanup FAILS', async () => {
      const sim = makeInMemoryS3(CFG);
      const bf = makeBudgetedFetch(sim.fetch, LIMITS);
      const store = new S3ObjectStore(CFG, bf.fetch);
      const keys = makeAcceptanceKeys();
      // Create an object but DON'T track it → cleanup deletes nothing, the prefix LIST stays non-empty, and
      // cleanupAndVerify throws. The report must STILL fire (in finally) with final counters.
      await store.putIfAbsent(keys.key('leak'), Buffer.from('{"x":1}', 'utf8'), 'application/json');
      const reports: RunTotals[] = [];
      const totals = await cleanupAndReport({ store, prefix: keys.prefix, created: [], budgeted: bf, report: (t) => reports.push(t) });

      expect(totals.cleanupSucceeded).toBe(false); // cleanup genuinely failed (object left behind)
      expect(totals.cleanupError).toBeDefined();
      expect(reports).toHaveLength(1); // reported despite the failure
      expect(reports[0]!.cleanupSucceeded).toBe(false);
      expect(reports[0]!.preCleanup.requests).toBeGreaterThan(0); // pre-cleanup counters captured
      expect(reports[0]!.final.requests).toBeGreaterThanOrEqual(reports[0]!.preCleanup.requests); // final ≥ pre (a LIST ran)
    });

    it('runPG1Concurrent waits for BOTH writes to settle before propagating a failure (no sibling races cleanup)', async () => {
      // The first write rejects fast; the sibling settles LATER. The step must not propagate the failure
      // until the delayed sibling has settled, so no in-flight write outlives the step to race cleanup.
      let calls = 0;
      let siblingSettled = false;
      const fakeStore = {
        putIfAbsent: async (): Promise<'created' | 'exists'> => {
          calls += 1;
          if (calls === 1) throw new Error('fast write rejection');
          await new Promise((r) => setTimeout(r, 25)); // the sibling settles later than the fast rejection
          siblingSettled = true;
          return 'created';
        },
      } as unknown as S3ObjectStore;
      const keys = makeAcceptanceKeys();
      const ctx: AcceptanceCtx = {
        store: fakeStore,
        cfg: CFG,
        fetchImpl: (async () => new Response(null)) as unknown as typeof fetch,
        key: keys.key,
        track: () => {},
      };

      await expect(runPG1Concurrent(ctx)).rejects.toThrow(/fast write rejection/);
      // With allSettled the step only rejects AFTER the delayed sibling settled; Promise.all would have
      // rejected while the sibling was still pending (siblingSettled === false).
      expect(siblingSettled).toBe(true);
    });
  });

  describe('PG3 checksum diagnostics A / B / C', () => {
    const lowerHeaders = (h: HeadersInit | undefined): Record<string, string> => {
      const out: Record<string, string> = {};
      if (!h) return out;
      if (h instanceof Headers) {
        h.forEach((v, k) => (out[k.toLowerCase()] = v));
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) out[String(k).toLowerCase()] = String(v);
      } else {
        for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = String(v);
      }
      return out;
    };
    const b64 = (b: Buffer): string => createHash('sha256').update(b).digest('base64');

    it('the three diagnostic PUTs match on body + payload hash and differ ONLY where intended (signed headers)', async () => {
      const sim = makeInMemoryS3(CFG);
      const puts: Array<{ headers: Record<string, string>; body: Buffer }> = [];
      const recording = (async (url: string, init: RequestInit = {}) => {
        if (String(init.method) === 'PUT') puts.push({ headers: lowerHeaders(init.headers as HeadersInit), body: Buffer.from((init.body as Uint8Array) ?? new Uint8Array()) });
        return sim.fetch(url, init);
      }) as unknown as typeof fetch;
      const store = new S3ObjectStore(CFG, recording);
      const keys = makeAcceptanceKeys();
      const ctx: AcceptanceCtx = { store, cfg: CFG, fetchImpl: recording, key: keys.key, track: () => {} };

      await runDiagAOriginalWrongChecksum(ctx);
      await runDiagBAddedSdkAlgo(ctx);
      await runDiagCCorrectControl(ctx);

      expect(puts).toHaveLength(3);
      const [a, b, c] = puts;
      const pg3Payload = Buffer.from('{"pg3":"bytes"}', 'utf8');
      const wrong = b64(Buffer.from('completely different bytes', 'utf8'));
      const correct = b64(pg3Payload);
      const payloadHashHex = createHash('sha256').update(pg3Payload).digest('hex');
      const signedHeaders = (auth: string): string[] => (auth.match(/SignedHeaders=([^,]+)/)?.[1] ?? '').split(';');
      const signature = (auth: string): string => auth.match(/Signature=([0-9a-f]+)/)?.[1] ?? '';

      // BODIES — all three send the ORIGINAL PG3 payload, byte-identical
      expect(a!.body.equals(pg3Payload)).toBe(true);
      expect(b!.body.equals(pg3Payload)).toBe(true);
      expect(c!.body.equals(pg3Payload)).toBe(true);

      // PAYLOAD HASH (x-amz-content-sha256) — identical across all three (same body)
      expect(a!.headers['x-amz-content-sha256']).toBe(payloadHashHex);
      expect(b!.headers['x-amz-content-sha256']).toBe(payloadHashHex);
      expect(c!.headers['x-amz-content-sha256']).toBe(payloadHashHex);

      // A ↔ B differ ONLY by the SDK-algorithm header (same wrong checksum, same content-type/if-none-match)
      expect(a!.headers['x-amz-checksum-sha256']).toBe(wrong);
      expect(b!.headers['x-amz-checksum-sha256']).toBe(wrong);
      expect(a!.headers['x-amz-sdk-checksum-algorithm']).toBeUndefined();
      expect(b!.headers['x-amz-sdk-checksum-algorithm']).toBe('SHA256');
      expect(a!.headers['content-type']).toBe(b!.headers['content-type']);
      expect(a!.headers['if-none-match']).toBe('*');
      expect(b!.headers['if-none-match']).toBe('*');

      // B ↔ C differ ONLY by the checksum value (+ derived signing); SDK header + content-type + if-none-match same
      expect(c!.headers['x-amz-sdk-checksum-algorithm']).toBe('SHA256');
      expect(c!.headers['x-amz-checksum-sha256']).toBe(correct);
      expect(c!.headers['x-amz-checksum-sha256']).not.toBe(b!.headers['x-amz-checksum-sha256']);
      expect(c!.headers['content-type']).toBe(b!.headers['content-type']);
      expect(c!.headers['if-none-match']).toBe('*');

      // SIGNED HEADERS — B and C sign the SDK-algorithm header; A does not. All sign the checksum + content hash.
      const shA = signedHeaders(a!.headers['authorization'] ?? '');
      const shB = signedHeaders(b!.headers['authorization'] ?? '');
      const shC = signedHeaders(c!.headers['authorization'] ?? '');
      expect(shA).not.toContain('x-amz-sdk-checksum-algorithm');
      expect(shB).toContain('x-amz-sdk-checksum-algorithm');
      expect(shC).toContain('x-amz-sdk-checksum-algorithm');
      for (const sh of [shA, shB, shC]) {
        expect(sh).toContain('x-amz-checksum-sha256');
        expect(sh).toContain('x-amz-content-sha256');
      }
      // Signatures differ across all three (fresh key + differing signed content)
      expect(new Set([signature(a!.headers['authorization'] ?? ''), signature(b!.headers['authorization'] ?? ''), signature(c!.headers['authorization'] ?? '')]).size).toBe(3);
    });

    it('a rejected diagnostic PUT (BadDigest) is absence-checked and leaves nothing', async () => {
      const sim = makeInMemoryS3(CFG); // default: a wrong checksum is rejected with BadDigest 400
      const bf = makeBudgetedFetch(sim.fetch, LIMITS);
      const store = new S3ObjectStore(CFG, bf.fetch);
      const keys = makeAcceptanceKeys();
      const created: string[] = [];
      const ctx: AcceptanceCtx = { store, cfg: CFG, fetchImpl: bf.fetch, key: keys.key, track: (k) => created.push(k) };

      const a = await runDiagAOriginalWrongChecksum(ctx);
      expect(a.status).toBe(400);
      expect(a.code).toBe('BadDigest');
      expect(a.absentAfterReject).toBe(true); // the absence check ran and confirmed nothing landed
      expect(sim.objectCount()).toBe(0);
    });

    it('diagnostic C (correct checksum) is accepted and reads back byte-exact', async () => {
      const sim = makeInMemoryS3(CFG);
      const bf = makeBudgetedFetch(sim.fetch, LIMITS);
      const store = new S3ObjectStore(CFG, bf.fetch);
      const keys = makeAcceptanceKeys();
      const created: string[] = [];
      const ctx: AcceptanceCtx = { store, cfg: CFG, fetchImpl: bf.fetch, key: keys.key, track: (k) => created.push(k) };

      await expect(runDiagCCorrectControl(ctx)).resolves.toBeUndefined(); // accepted + byte-exact read-back asserted inside
      expect(sim.objectCount()).toBe(1);
      await cleanupAndVerify({ store, prefix: keys.prefix, created, enterCleanupPhase: bf.enterCleanupPhase });
      expect(sim.objectCount()).toBe(0);
    });

    it('EMITS sanitized evidence for A, B and C (label/status/code/outcome), not merely returns it', async () => {
      const sim = makeInMemoryS3(CFG);
      const bf = makeBudgetedFetch(sim.fetch, LIMITS);
      const store = new S3ObjectStore(CFG, bf.fetch);
      const keys = makeAcceptanceKeys();
      const created: string[] = [];
      const events: DiagEvidence[] = [];
      const ctx: AcceptanceCtx = { store, cfg: CFG, fetchImpl: bf.fetch, key: keys.key, track: (k) => created.push(k), emit: (e) => events.push(e) };

      await runDiagAOriginalWrongChecksum(ctx);
      await runDiagBAddedSdkAlgo(ctx);
      await runDiagCCorrectControl(ctx);

      expect(events.map((e) => e.label)).toEqual(['DIAG-A', 'DIAG-B', 'DIAG-C']);
      expect(events[0]).toMatchObject({ status: 400, code: 'BadDigest', outcome: 'rejected-absent', absentAfterReject: true });
      expect(events[1]).toMatchObject({ status: 400, code: 'BadDigest', outcome: 'rejected-absent', absentAfterReject: true });
      expect(events[2]).toMatchObject({ status: 200, outcome: 'accepted-readback-ok', readBackOk: true });
      await cleanupAndVerify({ store, prefix: keys.prefix, created, enterCleanupPhase: bf.enterCleanupPhase });
    });

    it('preserves + EMITS the received status/code when the absence assertion fails (rejected but present)', async () => {
      // PUT rejected (400 BadDigest) but the object is PRESENT, so the absence assertion fails. The received
      // status/code must still be emitted (in the finally) before the assertion error propagates.
      const inner = (async (_url: string, init: RequestInit = {}) => {
        const method = String(init.method ?? 'GET');
        if (method === 'PUT') return new Response('<Error><Code>BadDigest</Code></Error>', { status: 400, headers: { 'content-length': '38' } });
        if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '15' } }); // present despite the 400
        return new Response(null, { status: 404 });
      }) as unknown as typeof fetch;
      const store = new S3ObjectStore(CFG, inner);
      const keys = makeAcceptanceKeys();
      const events: DiagEvidence[] = [];
      const ctx: AcceptanceCtx = { store, cfg: CFG, fetchImpl: inner, key: keys.key, track: () => {}, emit: (e) => events.push(e) };

      await expect(runDiagAOriginalWrongChecksum(ctx)).rejects.toThrow(/must leave nothing/);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ label: 'DIAG-A', status: 400, code: 'BadDigest', outcome: 'rejected-present', absentAfterReject: false });
    });

    it("preserves + EMITS the received status when C's read-back GET mismatches", async () => {
      // PUT accepted (200) but the read-back returns DIFFERENT bytes, so the byte-exact assertion fails. The
      // received status must still be emitted before the assertion error propagates.
      const inner = (async (_url: string, init: RequestInit = {}) => {
        const method = String(init.method ?? 'GET');
        if (method === 'PUT') return new Response('', { status: 200, headers: { 'content-length': '0' } });
        if (method === 'GET') return new Response(new Uint8Array(Buffer.from('DIFFERENT')), { status: 200, headers: { 'content-length': '9' } });
        if (method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': '9' } });
        return new Response(null, { status: 404 });
      }) as unknown as typeof fetch;
      const store = new S3ObjectStore(CFG, inner);
      const keys = makeAcceptanceKeys();
      const events: DiagEvidence[] = [];
      const ctx: AcceptanceCtx = { store, cfg: CFG, fetchImpl: inner, key: keys.key, track: () => {}, emit: (e) => events.push(e) };

      await expect(runDiagCCorrectControl(ctx)).rejects.toThrow(/byte-exact read-back/);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ label: 'DIAG-C', status: 200, outcome: 'accepted-readback-mismatch', readBackOk: false });
    });

    it('a PG3 assertion failure does not prevent diagnostic C or PG5 (independent execution)', async () => {
      const sim = makeInMemoryS3(CFG, { acceptWrongChecksum: true }); // PG3 fails (provider returns 200)
      const bf = makeBudgetedFetch(sim.fetch, LIMITS);
      const store = new S3ObjectStore(CFG, bf.fetch);
      const keys = makeAcceptanceKeys();
      const created: string[] = [];
      const ctx: AcceptanceCtx = { store, cfg: CFG, fetchImpl: bf.fetch, key: keys.key, track: (k) => created.push(k) };

      await expect(runPG3(ctx)).rejects.toThrow(/PG3: expected a checksum 4xx \(got 200\)/); // PG3 fails
      await expect(runDiagCCorrectControl(ctx)).resolves.toBeUndefined(); // C still runs
      await expect(runPG5(ctx)).resolves.toBeUndefined(); // PG5 still runs
      expect(bf.stats().tripped).toBe(false); // an assertion failure never trips the fuse

      await cleanupAndVerify({ store, prefix: keys.prefix, created, enterCleanupPhase: bf.enterCleanupPhase });
      expect(sim.objectCount()).toBe(0);
    });

    it('final cleanup accounting covers the diagnostic PUTs, absence HEADs, C read-back, and cleanup', async () => {
      const sim = makeInMemoryS3(CFG);
      const bf = makeBudgetedFetch(sim.fetch, LIMITS);
      const store = new S3ObjectStore(CFG, bf.fetch);
      const keys = makeAcceptanceKeys();
      const created: string[] = [];
      const ctx: AcceptanceCtx = { store, cfg: CFG, fetchImpl: bf.fetch, key: keys.key, track: (k) => created.push(k) };

      await runDiagAOriginalWrongChecksum(ctx); // rejected → PUT + HEAD (absence)
      await runDiagBAddedSdkAlgo(ctx); //           rejected → PUT + HEAD (absence)
      await runDiagCCorrectControl(ctx); //          accepted → PUT + GET (read-back)

      const reports: RunTotals[] = [];
      const totals = await cleanupAndReport({ store, prefix: keys.prefix, created, budgeted: bf, report: (t) => reports.push(t) });

      expect(reports).toHaveLength(1);
      expect(totals.cleanupSucceeded).toBe(true);
      expect(totals.preCleanup.requests).toBeGreaterThanOrEqual(6); // A(put+head) + B(put+head) + C(put+get)
      expect(totals.final.requests).toBeGreaterThan(totals.preCleanup.requests); // cleanup added deletes + a LIST
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

    it('a budget-exhaustion safety stop TRIPS the fuse and refuses further TEST requests (cleanup still allowed)', async () => {
      let innerCalls = 0;
      const inner = (async () => {
        innerCalls += 1;
        return new Response('x', { status: 200, headers: { 'content-length': '1' } });
      }) as unknown as typeof fetch;
      const b = makeBudgetedFetch(inner, { maxRequests: 3, maxBytes: 1024 * 1024, cleanupReserve: 1, cleanupByteReserve: 0 });
      // test-phase request ceiling = maxRequests - cleanupReserve = 2
      await b.fetch('https://ok.test/1');
      await b.fetch('https://ok.test/2');
      const before = innerCalls;
      await expect(b.fetch('https://ok.test/3')).rejects.toThrow(/request budget exceeded/); // hits the ceiling → trips
      expect(b.stats().tripped).toBe(true);
      // subsequent TEST requests are refused deterministically WITHOUT touching the network
      await expect(b.fetch('https://ok.test/4')).rejects.toThrow(/halted/i);
      expect(innerCalls).toBe(before); // no further inner calls in the test phase
      // cleanup phase is NOT fuse-gated: it still runs within its reserve
      b.enterCleanupPhase();
      await expect(b.fetch('https://ok.test/cleanup', { method: 'DELETE' })).resolves.toBeDefined();
      expect(innerCalls).toBe(before + 1);
    });

    it('an unsafe redirect (unsafe configuration) TRIPS the fuse and halts further TEST requests', async () => {
      let n = 0;
      const inner = (async () => {
        n += 1;
        return new Response('', { status: 302, headers: { location: 'https://evil.test' } });
      }) as unknown as typeof fetch;
      const b = makeBudgetedFetch(inner, { maxRequests: 60, maxBytes: 1024 * 1024, cleanupReserve: 5, cleanupByteReserve: 0 });
      await expect(b.fetch('https://ok.test/a')).rejects.toThrow(/redirect/); // unsafe response → trips
      expect(b.stats().tripped).toBe(true);
      await expect(b.fetch('https://ok.test/b')).rejects.toThrow(/halted/i); // halted without a network call
      expect(n).toBe(1); // only the first reached inner
    });

    it('a real redirect/network REJECTION (redirect:error throws, not a returned 302) also trips the fuse; bounded cleanup stays available', async () => {
      // fetch with `redirect: 'error'` REJECTS on a redirect (a network error), it does not return a 3xx.
      // The fuse must trip on that rejection path too, not only on a mocked returned-302.
      let calls = 0;
      const inner = (async () => {
        calls += 1;
        if (calls === 1) throw new TypeError('failed to fetch: redirect not allowed'); // models redirect:'error' rejection
        return new Response(null, { status: 204 }); // a later (cleanup) call succeeds
      }) as unknown as typeof fetch;
      const b = makeBudgetedFetch(inner, { maxRequests: 60, maxBytes: 1024 * 1024, cleanupReserve: 5, cleanupByteReserve: 0 });
      await expect(b.fetch('https://ok.test/a')).rejects.toThrow(/redirect|failed to fetch/i); // inner rejected → trips
      expect(b.stats().tripped).toBe(true);
      // subsequent TEST request is blocked WITHOUT reaching inner
      await expect(b.fetch('https://ok.test/b')).rejects.toThrow(/halted/i);
      expect(calls).toBe(1);
      // cleanup is NOT fuse-gated: the request reaches inner (bounded by the reserve) and completes
      b.enterCleanupPhase();
      await expect(b.fetch('https://ok.test/cleanup', { method: 'DELETE' })).resolves.toBeDefined();
      expect(calls).toBe(2);
    });
  });
});
