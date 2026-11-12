/**
 * VER-002 PR-6 — aggregate storage quota, in-process.
 *
 * The arithmetic rules of design §4.6 as corrected by Gate B, asserted against a double that reproduces
 * the SQL's semantics (InMemoryQuotaStore), plus the live wiring through requestUploadGrant /
 * redeemUploadGrant. The transactional and privilege properties — concurrency, and that app_server cannot
 * touch the counter — are proven against Postgres in tests/integration/verification-quota.int.test.ts.
 *
 * The one assertion to read first: FINALIZE FREES NOTHING. It is the most misread line of §4.6, so the
 * total charged against the cap is asserted explicitly before and after.
 */
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PROJECT_QUOTA_BYTES,
  InMemoryArtifactStore,
  InMemoryExclusiveArtifactWriter,
  InMemoryQuotaStore,
  InMemoryUploadGrantStore,
  InMemoryVerificationStore,
  redeemUploadGrant,
  requestUploadGrant,
  type ExclusiveArtifactWriter,
  type VerificationRequest,
} from '@/domain/verification';

const ORG = randomUUID();
const PROJ = randomUUID();
const TASK = randomUUID();
const REQ = randomUUID();
const ctx = { orgId: ORG, projectId: PROJ };
const PATH = 'test-results.json';
const T0 = new Date('2026-09-21T00:00:00.000Z');

function makeContract(): VerificationRequest {
  return {
    id: REQ, orgId: ORG, projectId: PROJ, taskId: TASK,
    repoFullName: 'acme/widget', expectedCommitSha: 'a'.repeat(40),
    requiredChecks: ['unit'], requiredArtifacts: [PATH], allowDirty: false,
    catalogVersion: 'cat-v1', catalogDigest: 'catdigest01',
    createdBy: randomUUID(), createdAt: T0.toISOString(),
  };
}

const bytes = (s: string): Buffer => Buffer.from(s, 'utf8');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
async function* stream(...chunks: Buffer[]): AsyncIterable<Uint8Array> { for (const c of chunks) yield c; }
const BODY = bytes('{"passed":true}');

let store: InMemoryVerificationStore;
let grants: InMemoryUploadGrantStore;
let artifacts: InMemoryArtifactStore;
let writer: ExclusiveArtifactWriter;
let quota: InMemoryQuotaStore;

beforeEach(() => {
  store = new InMemoryVerificationStore();
  store.addRequest(makeContract());
  grants = new InMemoryUploadGrantStore();
  artifacts = new InMemoryArtifactStore();
  writer = new InMemoryExclusiveArtifactWriter(artifacts);
  quota = new InMemoryQuotaStore();
});

const reqDeps = (over: Record<string, unknown> = {}) => ({ store, grants, quota, now: () => T0, ...over });
const redDeps = (over: Record<string, unknown> = {}) => ({ grants, writer, artifacts, quota, now: () => T0, ...over });
const input = (over: Record<string, unknown> = {}) => ({
  requestId: REQ, attemptId: 'attempt-1', logicalPath: PATH,
  declaredSize: BODY.length, declaredSha256: sha(BODY), ...over,
});

describe('PR-6 quota — the counter itself', () => {
  it('seeds the cap on first reserve and refuses at the boundary, changing nothing on refusal', async () => {
    const q = new InMemoryQuotaStore(1000);
    expect(await q.reserve(600, 1000)).toBe(true);
    expect(await q.reserve(400, 1000)).toBe(true);
    expect(await q.usage()).toMatchObject({ capBytes: 1000, reservedBytes: 1000, committedBytes: 0 });
    expect(await q.reserve(1, 1000)).toBe(false);
    expect(await q.usage()).toMatchObject({ reservedBytes: 1000, committedBytes: 0 });
  });

  it('FINALIZE FREES NOTHING — bytes move reserved → committed and the TOTAL is unchanged', async () => {
    const q = new InMemoryQuotaStore(1000);
    await q.reserve(1000, 1000);
    const before = await q.usage();
    expect(await q.finalize(400)).toBe(true);
    const after = await q.usage();
    expect(after).toMatchObject({ reservedBytes: 600, committedBytes: 400 });
    expect(after!.reservedBytes + after!.committedBytes).toBe(before!.reservedBytes + before!.committedBytes);
    // Still full: a finalized upload occupies storage and keeps counting.
    expect(await q.reserve(1, 1000)).toBe(false);
  });

  it('finalizing more than is reserved returns false and invents no committed bytes', async () => {
    const q = new InMemoryQuotaStore(1000);
    await q.reserve(100, 1000);
    expect(await q.finalize(500)).toBe(false);
    expect(await q.usage()).toMatchObject({ reservedBytes: 100, committedBytes: 0 });
  });

  it('a zero-byte artifact consumes no quota', async () => {
    const q = new InMemoryQuotaStore(0);
    expect(await q.reserve(0, 0)).toBe(true);
    expect(await q.finalize(0)).toBe(true);
  });

  it('the default cap is used when the tenant has no row yet', async () => {
    const q = new InMemoryQuotaStore();
    expect(await q.usage()).toBeNull();
    expect(await q.reserve(1, DEFAULT_PROJECT_QUOTA_BYTES)).toBe(true);
    expect((await q.usage())!.capBytes).toBe(DEFAULT_PROJECT_QUOTA_BYTES);
  });
});

describe('PR-6 quota — wired into grant issuance', () => {
  it('reserves the declared size when a grant is created', async () => {
    const out = await requestUploadGrant(reqDeps(), ctx, input());
    expect(out.created).toBe(true);
    expect(await quota.usage()).toMatchObject({ reservedBytes: BODY.length, committedBytes: 0 });
  });

  it('refuses with quota_exceeded when the project is full, and creates no grant', async () => {
    const tiny = new InMemoryQuotaStore(5);
    const out = await requestUploadGrant(reqDeps({ quota: tiny }), ctx, input());
    expect(out.created).toBe(false);
    expect(out.grant).toBeNull();
    expect(out.rejection?.code).toBe('quota_exceeded');
    // The row is SEEDED by the refused attempt (the SQL inserts the row before the conditional UPDATE),
    // but nothing is reserved for a grant that does not exist — which is the property that matters.
    expect(await tiny.usage()).toMatchObject({ capBytes: 5, reservedBytes: 0, committedBytes: 0 });
  });

  it('an identical re-request does NOT charge twice (dedup precedes the reservation)', async () => {
    const first = await requestUploadGrant(reqDeps(), ctx, input());
    expect(first.created).toBe(true);
    const again = await requestUploadGrant(reqDeps(), ctx, input());
    expect(again.created).toBe(false);
    expect(again.grant?.id).toBe(first.grant?.id);
    expect((await quota.usage())!.reservedBytes).toBe(BODY.length); // charged once, not twice
  });

  it('without a quota dep the behaviour is exactly PR-4: no accounting, no refusal', async () => {
    const out = await requestUploadGrant({ store, grants, now: () => T0 }, ctx, input());
    expect(out.created).toBe(true);
    expect(await quota.usage()).toBeNull();
  });
});

describe('PR-6 quota — wired into redemption', () => {
  it('a completed upload moves its bytes reserved → committed, total unchanged', async () => {
    const out = await requestUploadGrant(reqDeps(), ctx, input());
    const before = await quota.usage();
    const red = await redeemUploadGrant(redDeps(), ctx, out.grant!.id, stream(BODY));
    expect(red.completed).toBe(true);
    const after = await quota.usage();
    expect(after).toMatchObject({ reservedBytes: 0, committedBytes: BODY.length });
    expect(after!.reservedBytes + after!.committedBytes).toBe(before!.reservedBytes + before!.committedBytes);
  });

  it('an idempotent replay does not double-commit', async () => {
    const out = await requestUploadGrant(reqDeps(), ctx, input());
    await redeemUploadGrant(redDeps(), ctx, out.grant!.id, stream(BODY));
    const afterFirst = await quota.usage();
    const replay = await redeemUploadGrant(redDeps(), ctx, out.grant!.id, stream(BODY));
    expect(replay.idempotent).toBe(true);
    expect(await quota.usage()).toEqual(afterFirst);
  });

  it('a FAILED upload commits nothing and does NOT release the reservation (Gate B)', async () => {
    const out = await requestUploadGrant(reqDeps(), ctx, input());
    // Truncated body → the redemption fails.
    const red = await redeemUploadGrant(redDeps(), ctx, out.grant!.id, stream(bytes('{"passed":')));
    expect(red.completed).toBe(false);
    const after = await quota.usage();
    // Committed stays 0 — nothing landed. Reserved is STILL held: the grant exists and, per Gate B,
    // bytes could still arrive on a retry, so the reservation is not given back on failure.
    expect(after).toMatchObject({ committedBytes: 0, reservedBytes: BODY.length });
  });
});

describe('PR-6 ↔ PR-7 seam', () => {
  it('committed bytes come back only when retention confirms the object gone', async () => {
    const out = await requestUploadGrant(reqDeps(), ctx, input());
    await redeemUploadGrant(redDeps(), ctx, out.grant!.id, stream(BODY));
    expect((await quota.usage())!.committedBytes).toBe(BODY.length);

    // This is what app.record_verification_purge_object_deleted() does, refunding the GRANT's
    // declared_size. Nothing on the upload path can trigger it — refund is granted only to the
    // retention role.
    quota.refund(out.grant!.declaredSize);
    expect(await quota.usage()).toMatchObject({ reservedBytes: 0, committedBytes: 0 });
  });
});
