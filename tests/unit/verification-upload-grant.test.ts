import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  deriveUploadObjectKey,
  InMemoryArtifactStore,
  InMemoryExclusiveArtifactWriter,
  InMemoryUploadGrantStore,
  InMemoryVerificationStore,
  isValidAttemptId,
  PER_ARTIFACT_CAP_BYTES,
  redeemUploadGrant,
  requestUploadGrant,
  UnsupportedExclusiveWriteError,
  type ExclusiveArtifactWriter,
  type StagedArtifact,
  type UploadGrant,
  type VerificationRequest,
} from '@/domain/verification';

const ORG = randomUUID();
const PROJ = randomUUID();
const TASK = randomUUID();
const REQ = randomUUID();
const ctx = { orgId: ORG, projectId: PROJ };
const PATH = 'test-results.json';
const T0 = new Date('2026-09-21T00:00:00.000Z');

function makeContract(over: Partial<VerificationRequest> = {}): VerificationRequest {
  return {
    id: REQ,
    orgId: ORG,
    projectId: PROJ,
    taskId: TASK,
    repoFullName: 'acme/widget',
    expectedCommitSha: 'a'.repeat(40),
    requiredChecks: ['unit'],
    requiredArtifacts: [PATH],
    allowDirty: false,
    catalogVersion: 'cat-v1',
    catalogDigest: 'catdigest01',
    createdBy: randomUUID(),
    createdAt: T0.toISOString(),
    ...over,
  };
}

const bytes = (s: string): Buffer => Buffer.from(s, 'utf8');
const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
async function* stream(...chunks: Buffer[]): AsyncIterable<Uint8Array> {
  for (const c of chunks) yield c;
}

let store: InMemoryVerificationStore;
let grants: InMemoryUploadGrantStore;
let artifacts: InMemoryArtifactStore;
let writer: ExclusiveArtifactWriter;

beforeEach(() => {
  store = new InMemoryVerificationStore();
  store.addRequest(makeContract());
  grants = new InMemoryUploadGrantStore();
  artifacts = new InMemoryArtifactStore();
  writer = new InMemoryExclusiveArtifactWriter(artifacts);
});

const requestDeps = (over: Partial<Parameters<typeof requestUploadGrant>[0]> = {}) => ({
  store,
  grants,
  now: () => T0,
  ...over,
});
const BODY = bytes('{"passed":true}');
const validInput = (over: Record<string, unknown> = {}) => ({
  requestId: REQ,
  attemptId: 'attempt-1',
  logicalPath: PATH,
  declaredSize: BODY.length,
  declaredSha256: sha(BODY),
  ...over,
});

describe('VER-002 PR-4 — requestUploadGrant', () => {
  it('issues a canonical, opaque-leaf, tenant-scoped grant for a required artifact', async () => {
    const out = await requestUploadGrant(requestDeps({ newObjectId: () => 'OBJ' }), ctx, validInput());
    expect(out.created).toBe(true);
    expect(out.rejection).toBeNull();
    expect(out.grant!.objectKey).toBe(deriveUploadObjectKey(ctx, REQ, 'attempt-1', 'OBJ'));
    expect(out.grant!.objectKey).toBe(`org/${ORG}/project/${PROJ}/request/${REQ}/attempt/attempt-1/OBJ`);
    expect(out.grant!.declaredSize).toBe(BODY.length);
  });

  it('is idempotent: an identical re-request returns the SAME grant, no new object key', async () => {
    const first = await requestUploadGrant(requestDeps(), ctx, validInput());
    const again = await requestUploadGrant(requestDeps(), ctx, validInput());
    expect(again.created).toBe(false);
    expect(again.rejection).toBeNull();
    expect(again.grant!.id).toBe(first.grant!.id);
    expect(again.grant!.objectKey).toBe(first.grant!.objectKey);
  });

  it('a CHANGED declaration for the same attempt+path is grant_conflict (never a new object)', async () => {
    await requestUploadGrant(requestDeps(), ctx, validInput());
    const diffSize = await requestUploadGrant(requestDeps(), ctx, validInput({ declaredSize: BODY.length + 1 }));
    expect(diffSize.rejection?.code).toBe('grant_conflict');
    const diffDigest = await requestUploadGrant(requestDeps(), ctx, validInput({ declaredSha256: sha(bytes('other')) }));
    expect(diffDigest.rejection?.code).toBe('grant_conflict');
  });

  it('rejects unknown contract, unpinned contract, and a non-required path', async () => {
    const unknown = await requestUploadGrant(requestDeps(), ctx, validInput({ requestId: randomUUID() }));
    expect(unknown.rejection?.code).toBe('unknown_request');

    const s2 = new InMemoryVerificationStore();
    s2.addRequest(makeContract({ catalogVersion: 'unpinned', catalogDigest: 'unpinned' }));
    const unpinned = await requestUploadGrant(requestDeps({ store: s2 }), ctx, validInput());
    expect(unpinned.rejection?.code).toBe('catalog_unpinned');

    const notReq = await requestUploadGrant(requestDeps(), ctx, validInput({ logicalPath: 'not-required.json' }));
    expect(notReq.rejection?.code).toBe('path_not_required');
  });

  it('validates the declaration: attempt id, size cap, and digest shape', async () => {
    for (const bad of ['../escape', 'a'.repeat(129), 'has/slash', '..']) {
      const out = await requestUploadGrant(requestDeps(), ctx, validInput({ attemptId: bad }));
      expect(out.rejection?.code, bad).toBe('invalid_input');
    }
    expect((await requestUploadGrant(requestDeps(), ctx, validInput({ declaredSize: PER_ARTIFACT_CAP_BYTES + 1 }))).rejection?.code).toBe('invalid_input');
    expect((await requestUploadGrant(requestDeps(), ctx, validInput({ declaredSize: -1 }))).rejection?.code).toBe('invalid_input');
    expect((await requestUploadGrant(requestDeps(), ctx, validInput({ declaredSha256: 'nothex' }))).rejection?.code).toBe('invalid_input');
  });

  it('isValidAttemptId accepts opaque tokens and rejects traversal/oversize', () => {
    expect(isValidAttemptId('att.1_2-3')).toBe(true);
    expect(isValidAttemptId('..')).toBe(false);
    expect(isValidAttemptId('a/b')).toBe(false);
    expect(isValidAttemptId('a'.repeat(129))).toBe(false);
  });
});

describe('VER-002 PR-4 — redeemUploadGrant', () => {
  async function grantId(over: Record<string, unknown> = {}, deps = requestDeps()): Promise<string> {
    const out = await requestUploadGrant(deps, ctx, validInput(over));
    return out.grant!.id;
  }
  const redeemDeps = (now: () => Date = () => T0) => ({ grants, writer, artifacts, now });

  it('happy path: streams exact bytes → created, object landed, grant uploaded', async () => {
    const id = await grantId();
    const out = await redeemUploadGrant(redeemDeps(), ctx, id, stream(BODY));
    expect(out.completed).toBe(true);
    expect(out.reconciled).toBe(false);
    expect(out.rejection).toBeNull();
    expect(await grants.isUploaded(ORG, PROJ, id)).toBe(true);
    expect(await artifacts.head(out.objectKey!)).not.toBeNull();
  });

  it('identical retry replays idempotently (already-completed short-circuits)', async () => {
    const id = await grantId();
    await redeemUploadGrant(redeemDeps(), ctx, id, stream(BODY));
    const again = await redeemUploadGrant(redeemDeps(), ctx, id, stream(BODY));
    expect(again.completed).toBe(true);
    expect(again.idempotent).toBe(true);
  });

  it('checksum mismatch is rejected, no object created, grant not uploaded', async () => {
    const id = await grantId();
    const out = await redeemUploadGrant(redeemDeps(), ctx, id, stream(bytes('tampered!!!!!!!')));
    expect(out.rejection?.code).toBe('checksum_mismatch');
    expect(await grants.isUploaded(ORG, PROJ, id)).toBe(false);
    const g = await grants.getGrantById(ORG, PROJ, id);
    expect(await artifacts.head(g!.objectKey)).toBeNull();
  });

  it('size mismatch (short) and too_large (over cap) are rejected', async () => {
    const short = await grantId({ attemptId: 'a-short' });
    const shortOut = await redeemUploadGrant(redeemDeps(), ctx, short, stream(bytes('short')));
    expect(shortOut.rejection?.code).toBe('size_mismatch');

    // A grant whose declared size is huge; stream more than the cap → aborts mid-stream.
    const big = await grantId({ attemptId: 'a-big', declaredSize: PER_ARTIFACT_CAP_BYTES });
    const over = Buffer.alloc(1024);
    const chunks = Array.from({ length: 3 }, () => over);
    const tinyCapOut = await redeemUploadGrant({ ...redeemDeps(), perArtifactCapBytes: 2048 }, ctx, big, stream(...chunks));
    expect(tinyCapOut.rejection?.code).toBe('too_large');
  });

  it('interrupted stream leaves no object and does not complete the grant', async () => {
    const id = await grantId();
    async function* boom(): AsyncIterable<Uint8Array> {
      yield bytes('{"passed"');
      throw new Error('connection reset mid-upload');
    }
    await expect(redeemUploadGrant(redeemDeps(), ctx, id, boom())).rejects.toThrow(/connection reset/);
    const g = await grants.getGrantById(ORG, PROJ, id);
    expect(await artifacts.head(g!.objectKey)).toBeNull(); // temp discarded, never published
    expect(await grants.isUploaded(ORG, PROJ, id)).toBe(false);
  });

  it('concurrent redemption of one grant → exactly one object, one completion, no overwrite', async () => {
    const id = await grantId();
    const [a, b] = await Promise.all([
      redeemUploadGrant(redeemDeps(), ctx, id, stream(BODY)),
      redeemUploadGrant(redeemDeps(), ctx, id, stream(BODY)),
    ]);
    expect(a.completed && b.completed).toBe(true);
    // Exactly one performed the create; the other reconciled the existing object.
    expect([a.reconciled, b.reconciled].filter(Boolean).length).toBe(1);
    expect(await grants.isUploaded(ORG, PROJ, id)).toBe(true);
  });

  it('crash-after-write recovery: object exists without a completion event → reconciled to uploaded', async () => {
    const id = await grantId();
    const g = await grants.getGrantById(ORG, PROJ, id);
    // Simulate a crash between the object write and the event append: the object is present, no event.
    artifacts.createOnly(g!.objectKey, BODY);
    expect(await grants.isUploaded(ORG, PROJ, id)).toBe(false);
    const out = await redeemUploadGrant(redeemDeps(), ctx, id, stream(BODY));
    expect(out.completed).toBe(true);
    expect(out.reconciled).toBe(true);
    expect(await grants.isUploaded(ORG, PROJ, id)).toBe(true);
  });

  it('expiry: refuses NEW creation when expired and absent (grant_expired)', async () => {
    const id = await grantId({ attemptId: 'a-exp' }, requestDeps({ ttlMs: 1000 }));
    const later = () => new Date(T0.getTime() + 5000); // past the 1s TTL
    const out = await redeemUploadGrant(redeemDeps(later), ctx, id, stream(BODY));
    expect(out.rejection?.code).toBe('grant_expired');
    const g = await grants.getGrantById(ORG, PROJ, id);
    expect(await artifacts.head(g!.objectKey)).toBeNull(); // never created after expiry
  });

  it('expiry during recovery: an already-existing matching object is reconciled after expiry', async () => {
    const id = await grantId({ attemptId: 'a-exp2' }, requestDeps({ ttlMs: 1000 }));
    const g = await grants.getGrantById(ORG, PROJ, id);
    artifacts.createOnly(g!.objectKey, BODY); // object landed before the crash/expiry
    const later = () => new Date(T0.getTime() + 5000);
    const out = await redeemUploadGrant(redeemDeps(later), ctx, id, stream(BODY));
    expect(out.completed).toBe(true);
    expect(out.reconciled).toBe(true);
    expect(await grants.isUploaded(ORG, PROJ, id)).toBe(true);
  });

  it('a later failed retry cannot undo a completion; state is derived from the completion event', async () => {
    const id = await grantId();
    await redeemUploadGrant(redeemDeps(), ctx, id, stream(BODY)); // complete
    // A later retry with WRONG bytes: short-circuits to idempotent success (completion stands).
    const badRetry = await redeemUploadGrant(redeemDeps(), ctx, id, stream(bytes('tampered!!!!!!!')));
    expect(badRetry.completed).toBe(true);
    expect(badRetry.idempotent).toBe(true);
    // Even a directly-appended failure event cannot undo it: uploaded is derived from the completion event.
    await grants.appendEvent(ORG, PROJ, id, 'redemption_failed', 'spurious later failure');
    expect(await grants.isUploaded(ORG, PROJ, id)).toBe(true);
  });

  it('fails closed on an adapter that cannot do atomic create-only (never an overwriting put)', async () => {
    const id = await grantId();
    const failingWriter: ExclusiveArtifactWriter = {
      async stage(): Promise<StagedArtifact> {
        throw new UnsupportedExclusiveWriteError('s3');
      },
    };
    const out = await redeemUploadGrant({ grants, writer: failingWriter, artifacts, now: () => T0 }, ctx, id, stream(BODY));
    expect(out.rejection?.code).toBe('write_unsupported');
    expect(await grants.isUploaded(ORG, PROJ, id)).toBe(false);
  });

  it('grant_not_found for an unknown grant id', async () => {
    const out = await redeemUploadGrant(redeemDeps(), ctx, randomUUID(), stream(BODY));
    expect(out.rejection?.code).toBe('grant_not_found');
  });
});

describe('VER-002 PR-4 — grant is a plain immutable record', () => {
  it('exposes only declared identity fields (no secrets)', async () => {
    const out = await requestUploadGrant(requestDeps(), ctx, validInput());
    const g: UploadGrant = out.grant!;
    expect(Object.keys(g).sort()).toEqual(
      ['attemptId', 'contentType', 'createdAt', 'declaredSha256', 'declaredSize', 'expiresAt', 'id', 'logicalPath', 'maxUploadMs', 'objectKey', 'orgId', 'projectId', 'requestId'].sort(),
    );
  });
});
