/**
 * VER-002 PR-5 — LIVE provider acceptance harness (S3 create-only). STRICT OPT-IN and dangerous without
 * approval, so it is disabled unless `VER_S3_ACCEPTANCE=1`.
 *
 *  - Not opted in → the suite SKIPS.
 *  - Opted in but any prerequisite missing/inconsistent → the suite FAILS LOUDLY in beforeAll (never a
 *    silent skip). The endpoint (HTTPS) and bucket are validated against the APPROVED allow-list BEFORE
 *    any credential is used.
 *  - It makes REAL calls to the approved provider, bounded by request/byte budgets (with a reserved
 *    cleanup allowance) and a safety fuse, writes only PRODUCTION-SHAPED verification keys under a random
 *    per-run prefix in the approved DISPOSABLE bucket, deletes exactly what it created, and verifies cleanup.
 *
 * Each provider guarantee (PG1, PG1-concurrent, PG2, PG3, PG5) runs in its OWN test, so one guarantee's
 * assertion failure (e.g. PG3 on a provider that accepts a wrong checksum) does NOT prevent PG5 from being
 * evaluated. A single shared budgeted fetch (one counter + fuse) and one shared `created[]` span all tests,
 * and a single afterAll runs cleanup and ALWAYS reports pre-cleanup + final totals.
 *
 * The scenario/cleanup logic lives in tests/support/s3-acceptance.ts and is ALSO exercised offline against
 * a simulated provider (tests/unit/verification-s3-acceptance-offline.test.ts). This file only wires the
 * REAL store + a budgeted global fetch. It proves PROVIDER guarantees the hermetic tests cannot; it is
 * authorized to run ONLY after the owner approves a live run.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore } from '@/domain/documents/s3-object-store';
import {
  cleanupAndReport,
  makeAcceptanceKeys,
  makeBudgetedFetch,
  runDiagAOriginalWrongChecksum,
  runDiagBAddedSdkAlgo,
  runDiagCCorrectControl,
  runN1WrongContentMd5,
  runN2WrongPayloadHash,
  runP1ContentMd5Control,
  runP2PayloadHashControl,
  runPG1,
  runPG1Concurrent,
  runPG2,
  runPG5,
  type AcceptanceCtx,
  type BudgetedFetch,
} from '../support/s3-acceptance';

const OPTED_IN = process.env.VER_S3_ACCEPTANCE === '1';

const ENV = {
  endpoint: process.env.VER_S3_ENDPOINT ?? '',
  region: process.env.VER_S3_REGION ?? '',
  bucket: process.env.VER_S3_BUCKET ?? '',
  accessKeyId: process.env.VER_S3_ACCESS_KEY_ID ?? '',
  secretAccessKey: process.env.VER_S3_SECRET_ACCESS_KEY ?? '',
  approvedEndpoint: process.env.VER_S3_APPROVED_ENDPOINT ?? '',
  approvedBucket: process.env.VER_S3_APPROVED_BUCKET ?? '',
};

const LIMITS = { maxRequests: 60, maxBytes: 30 * 1024 * 1024, cleanupReserve: 15, cleanupByteReserve: 1 * 1024 * 1024 };

let store: S3ObjectStore;
let budgeted: BudgetedFetch;
let ctx: AcceptanceCtx;
const KEYS = makeAcceptanceKeys();
const created: string[] = [];

/** Validate ALL prerequisites and the approved endpoint/bucket BEFORE any credential is used. Throws
 *  (failing the suite) on any missing or non-approved value — the "fail, don't skip" contract. */
function validatePrerequisitesOrFail(): void {
  const missing = (['endpoint', 'region', 'bucket', 'accessKeyId', 'secretAccessKey', 'approvedEndpoint', 'approvedBucket'] as const).filter((k) => ENV[k].trim() === '');
  if (missing.length > 0) throw new Error(`VER_S3_ACCEPTANCE=1 but required config is missing: ${missing.join(', ')}. Refusing to run.`);
  if (!ENV.endpoint.startsWith('https://')) throw new Error(`live acceptance endpoint must be HTTPS: ${ENV.endpoint}`);
  if (ENV.endpoint.replace(/\/+$/, '') !== ENV.approvedEndpoint.replace(/\/+$/, '')) throw new Error(`endpoint '${ENV.endpoint}' is not the approved endpoint. Refusing to run.`);
  if (ENV.bucket !== ENV.approvedBucket) throw new Error(`bucket '${ENV.bucket}' is not the approved disposable bucket. Refusing to run.`);
}

beforeAll(() => {
  if (!OPTED_IN) return;
  validatePrerequisitesOrFail(); // endpoint + bucket validated BEFORE the credential goes into the store
  budgeted = makeBudgetedFetch(fetch, LIMITS);
  const cfg = { endpoint: ENV.endpoint, region: ENV.region, bucket: ENV.bucket, accessKeyId: ENV.accessKeyId, secretAccessKey: ENV.secretAccessKey };
  store = new S3ObjectStore(cfg, budgeted.fetch);
  ctx = {
    store,
    cfg,
    fetchImpl: budgeted.fetch,
    key: KEYS.key,
    track: (k) => created.push(k),
    // Emit sanitized diagnostic evidence to the run log (label/status/code/outcome only — no credentials).
    emit: (ev) => console.log(`VER_S3_DIAG ${JSON.stringify(ev)}`),
  };
});

afterAll(async () => {
  if (!OPTED_IN || !store) return;
  // Cleanup ALWAYS reports pre-cleanup + final totals (in a finally, even if cleanup fails); a cleanup
  // failure (leftover object) fails the suite here, AFTER the totals have been reported.
  const totals = await cleanupAndReport({ store, prefix: KEYS.prefix, created, budgeted });
  expect(totals.cleanupSucceeded, `cleanup must delete everything and verify the prefix '${KEYS.prefix}' empty`).toBe(true);
});

describe.skipIf(!OPTED_IN)('VER-002 PR-5 — S3 provider acceptance (LIVE, opt-in)', () => {
  // Each guarantee is an INDEPENDENT test: an ordinary assertion failure in one (e.g. PG3) does not stop
  // the others (notably PG5) from being evaluated. Order is preserved; the shared budgeted fetch and
  // created[] persist across them.
  it('PG1 — create-only publish; a second create-only is rejected as exists', () => runPG1(ctx));
  it('PG1-concurrent — two concurrent create-only writes yield exactly one create', () => runPG1Concurrent(ctx));
  it('PG2 — GET/HEAD round-trip is byte-exact; absent reads absent', () => runPG2(ctx));
  it('PG5 — adapter overwrite guard + provider conditional-write enforcement', () => runPG5(ctx));

  // Provider-verified integrity-at-write (Content-MD5 + payload-hash), replacing old PG3. Each negative
  // passes ONLY on its own specific status + error code (other errors do not satisfy); each positive control
  // must write successfully and read back byte-exact.
  it('N1 — wrong Content-MD5 → 400 BadDigest, object absent', () => runN1WrongContentMd5(ctx));
  it('P1 — correct Content-MD5 → accepted + byte-exact read-back', () => runP1ContentMd5Control(ctx));
  it('N2 — wrong x-amz-content-sha256 → 400 XAmzContentSHA256Mismatch, object absent', () => runN2WrongPayloadHash(ctx));
  it('P2 — correct x-amz-content-sha256 → accepted + byte-exact read-back', () => runP2PayloadHashControl(ctx));

  // PG3 checksum diagnostics — three independent PUTs (A/B/C). A PG3 assertion failure above does not
  // prevent these (each is its own test). A and B are observational (rejected ⇒ absence-checked); C is a
  // positive control that must be accepted + byte-exact.
  it('DIAG-A — original wrong-checksum PUT (observational; rejected ⇒ absent)', () => runDiagAOriginalWrongChecksum(ctx));
  it('DIAG-B — wrong-checksum PUT + x-amz-sdk-checksum-algorithm (observational; rejected ⇒ absent)', () => runDiagBAddedSdkAlgo(ctx));
  it('DIAG-C — positive control: B format + correct checksum ⇒ accepted + byte-exact', () => runDiagCCorrectControl(ctx));

  it('stays within the request/byte budget and the fuse did not trip', () => {
    const s = budgeted.stats();
    expect(s.requests).toBeLessThanOrEqual(LIMITS.maxRequests);
    expect(s.uploadBytes + s.downloadBytes).toBeLessThanOrEqual(LIMITS.maxBytes);
    expect(s.tripped, 'the budget/safety fuse must not have tripped during the run').toBe(false);
  });
});
