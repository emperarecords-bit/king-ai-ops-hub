/**
 * VER-002 PR-5 — LIVE provider acceptance harness (S3 create-only). STRICT OPT-IN and dangerous without
 * approval, so it is disabled unless `VER_S3_ACCEPTANCE=1`.
 *
 *  - Not opted in → the suite SKIPS.
 *  - Opted in but any prerequisite missing/inconsistent → the suite FAILS LOUDLY in beforeAll (never a
 *    silent skip). The endpoint (HTTPS) and bucket are validated against the APPROVED allow-list BEFORE
 *    any credential is used.
 *  - It makes REAL calls to the approved provider, bounded by request/byte budgets (with a reserved
 *    cleanup allowance), writes only PRODUCTION-SHAPED verification keys under a random per-run prefix in
 *    the approved DISPOSABLE bucket, deletes exactly what it created, and verifies cleanup.
 *
 * The scenario/cleanup logic lives in tests/support/s3-acceptance.ts and is ALSO exercised offline against
 * a simulated provider (tests/unit/verification-s3-acceptance-offline.test.ts). This file only wires the
 * REAL store + a budgeted global fetch. It proves the PROVIDER guarantees the hermetic tests cannot; it is
 * authorized to run ONLY after the owner approves A1–A5.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3ObjectStore } from '@/domain/documents/s3-object-store';
import { cleanupAndVerify, makeAcceptanceKeys, makeBudgetedFetch, runAcceptanceScenarios } from '../support/s3-acceptance';

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
let budgeted: ReturnType<typeof makeBudgetedFetch>;
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
  store = new S3ObjectStore(
    { endpoint: ENV.endpoint, region: ENV.region, bucket: ENV.bucket, accessKeyId: ENV.accessKeyId, secretAccessKey: ENV.secretAccessKey },
    budgeted.fetch,
  );
});

afterAll(async () => {
  if (!OPTED_IN || !store) return;
  await cleanupAndVerify({ store, prefix: KEYS.prefix, created, enterCleanupPhase: budgeted.enterCleanupPhase });
});

describe.skipIf(!OPTED_IN)('VER-002 PR-5 — S3 provider acceptance (LIVE, opt-in)', () => {
  it('proves PG1, PG1-concurrent, PG2, PG3, PG5 against the approved disposable bucket', async () => {
    await runAcceptanceScenarios({
      store,
      cfg: { endpoint: ENV.endpoint, region: ENV.region, bucket: ENV.bucket, accessKeyId: ENV.accessKeyId, secretAccessKey: ENV.secretAccessKey },
      fetchImpl: budgeted.fetch,
      key: KEYS.key,
      track: (k) => created.push(k),
    });
  });

  it('stays within the request/byte budget', () => {
    const s = budgeted.stats();
    expect(s.requests).toBeLessThanOrEqual(LIMITS.maxRequests);
    expect(s.uploadBytes + s.downloadBytes).toBeLessThanOrEqual(LIMITS.maxBytes);
  });
});
