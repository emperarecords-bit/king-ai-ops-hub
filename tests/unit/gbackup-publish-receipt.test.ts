import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type SignedReceiptV2 } from '../../scripts/backup/receipt-v2-schema';
import { finalizeReceiptV2Id } from '../../scripts/backup/receipt-v2-canonical';
import { signReceiptV2 } from '../../scripts/backup/receipt-v2-sign';
import { type NormalizedProviderEvidence, computeNormalizedProviderEvidenceDigest } from '../../scripts/backup/provider-fly-volumes';
import { type ReceiptV2Expectation } from '../../scripts/backup/receipt-v2-verify';
import { loadReceiptKeyBundle } from '../../scripts/backup/receipt-key-bundle';
import { type ReceiptFetchResult, type ReceiptFetcher, type TransportControls } from '../../scripts/backup/receipt-transport';
import { type RuntimeMigrationSet } from '../../scripts/backup/runtime-migration-set';
import {
  type GateConfig,
  type GateDbProbe,
  type ReleaseSourceInputs,
  runPreMigrationGate,
} from '../../scripts/backup/premigration-gate';
import {
  type CreateOnlyAttempt,
  type ReceiptObjectStore,
  ReceiptPublishError,
  publishSignedReceiptV2,
} from '../../scripts/backup/publish-receipt';

/**
 * G-Backup receipt PUBLISHER — fully OFFLINE. Ephemeral, non-production ed25519 keys in-process; an in-memory
 * fake store + fake anonymous fetcher. No network, no real S3/Tigris, no credentials, no Fly, no deploy. Proves
 * the publisher: verifies before publishing, binds every identity incl. image digest, writes create-only (never
 * overwrites), reconciles an ambiguous write by HEAD, reads back byte/hash-exact from the exact gate URL,
 * re-verifies remotely, and that a published object is then ACCEPTED by the real pre-migration gate.
 */

const kp = generateKeyPairSync('ed25519');
const PEM = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const NONCE = 'deadbeefdeadbeefdeadbeefdeadbeef';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const WRONG_DIGEST = `sha256:${'b'.repeat(64)}`;
const DBID = '7300338420798239475';
const SRC = 'd2805ffab69bb83926a50d0422d65823b521138f';
const REF = `registry.fly.io/king-ai-ops-hub-staging@${DIGEST}`; // digest-bound (the gate requires it on staging)
const BASE_URL = 'https://receipts.example.com';
const HOSTS = new Set(['receipts.example.com']);
const CONTROLS: TransportControls = { maxBytes: 64 * 1024, timeoutMs: 2000, hostAllowlist: HOSTS };
const NOW = () => new Date('2026-08-01T11:50:20.000Z'); // within snapshot freshness + before expiry
const EXPECTED_URL = `${BASE_URL}/v2/staging/king-ai-ops-hub-staging/${NONCE}.json`;
const EXPECTED_KEY = `v2/staging/king-ai-ops-hub-staging/${NONCE}.json`;

// A single pending migration (small synthetic set) — used by both the receipt and the capstone gate fixture.
const PENDING = [{ migrationIndex: 1, migrationTag: '0001_feature', migrationPath: 'drizzle/0001_feature.sql', byteLength: 100, sha256: 'e'.repeat(64) }];
const PORTABLE = 'b'.repeat(64);
const RUNTIME = 'c'.repeat(64);

function keyStore() {
  const l = loadReceiptKeyBundle([{ keyId: 'test-dbr-001', algorithm: 'ed25519', publicKeyPem: PEM, purpose: 'deployment_backup_receipt', status: 'active' }]);
  if (!l.ok) throw new Error(l.code);
  return l.store;
}

function evidence(over: Partial<NormalizedProviderEvidence> = {}): { e: NormalizedProviderEvidence; digest: string } {
  const e: NormalizedProviderEvidence = {
    snapshotProvider: 'fly-volumes', providerAdapterVersion: 'fly-volumes.v1', snapshotDiscoveryMethod: 'create-response-id',
    snapshotDiscoveryEvidence: { createResponseSnapshotId: 'vs_abc123', listedSnapshotId: 'vs_abc123' },
    snapshotId: 'vs_abc123', sourceVolumeId: 'vol_4m3kmknl059qpd6v', databaseApp: 'king-ai-hub-db-staging',
    providerSnapshotStatus: 'created', canonicalSnapshotStatus: 'complete',
    snapshotRequestedAt: '2026-08-01T11:49:58.000Z', snapshotCreatedAt: '2026-08-01T11:50:00.000Z', providerObservedAt: '2026-08-01T11:50:05.000Z',
    retentionDays: 7, storedSizeBytes: 130000000, ...over,
  };
  return { e, digest: computeNormalizedProviderEvidenceDigest(e) };
}

function buildSigned(over: Partial<SignedReceiptV2> = {}, evOver: Partial<NormalizedProviderEvidence> = {}): SignedReceiptV2 {
  const { e, digest } = evidence(evOver);
  return finalizeReceiptV2Id({
    schemaVersion: '2', canonicalizationVersion: 1, receiptId: `rcpt2_${'0'.repeat(64)}`,
    environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: e.databaseApp,
    sourceVolumeId: e.sourceVolumeId, databaseSystemIdentifier: DBID,
    snapshotProvider: 'fly-volumes', providerSnapshotStatus: e.providerSnapshotStatus, canonicalSnapshotStatus: 'complete',
    snapshotDiscoveryMethod: 'create-response-id', snapshotDiscoveryEvidence: e.snapshotDiscoveryEvidence as { createResponseSnapshotId: string; listedSnapshotId: string },
    snapshotId: e.snapshotId, snapshotRequestedAt: e.snapshotRequestedAt, snapshotCreatedAt: e.snapshotCreatedAt, providerObservedAt: e.providerObservedAt,
    retentionDays: e.retentionDays, storedSizeBytes: e.storedSizeBytes, normalizedProviderEvidenceDigest: digest, providerAdapterVersion: e.providerAdapterVersion,
    sourceCommit: SRC, targetImageRef: REF, targetImageDigest: DIGEST, deploymentNonce: NONCE,
    portableMigrationSetHash: PORTABLE, runtimeMigrationSetHash: RUNTIME, pendingMigrations: PENDING,
    receiptCreatedAt: '2026-08-01T11:50:06.000Z', expiresAt: '2026-08-01T12:20:06.000Z', signatureAlgorithm: 'ed25519', keyId: 'test-dbr-001', ...over,
  });
}

/** The exact signed-receipt file bytes to publish. */
function signedBytes(over: Partial<SignedReceiptV2> = {}, evOver: Partial<NormalizedProviderEvidence> = {}): Buffer {
  return Buffer.from(JSON.stringify(signReceiptV2(buildSigned(over, evOver), kp.privateKey)));
}

function expectation(over: Partial<ReceiptV2Expectation> = {}): ReceiptV2Expectation {
  return {
    environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: 'king-ai-hub-db-staging',
    sourceVolumeId: 'vol_4m3kmknl059qpd6v', databaseSystemIdentifier: DBID, snapshotProvider: 'fly-volumes', providerAdapterVersion: 'fly-volumes.v1',
    minRetentionDays: 7, maxSnapshotAgeMs: 30 * 60 * 1000, sourceCommit: SRC, expectedRegistryNamespace: 'registry.fly.io/king-ai-ops-hub-staging', deploymentNonce: NONCE,
    portableMigrationSetHash: PORTABLE, runtimeMigrationSetHash: RUNTIME, pendingMigrations: PENDING,
    migrationStartedAt: NOW(), supportedSchemaVersions: new Set(['2']), supportedAlgorithms: new Set(['ed25519']), keyStore: keyStore(), ...over,
  };
}

const LOCATOR = { baseUrl: BASE_URL, environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', deploymentNonce: NONCE };

class FakeStore implements ReceiptObjectStore {
  map = new Map<string, Buffer>();
  putScript: CreateOnlyAttempt[] = [];
  headScript: ('present' | 'absent')[] = [];
  headThrows = false;
  putCalls = 0;
  headCalls = 0;
  async putIfAbsentOnce(key: string, bytes: Buffer, _ct: string): Promise<CreateOnlyAttempt> {
    this.putCalls++;
    if (this.putScript.length) {
      const r = this.putScript.shift()!;
      if (r === 'created' && !this.map.has(key)) this.map.set(key, Buffer.from(bytes));
      return r;
    }
    if (this.map.has(key)) return 'exists';
    this.map.set(key, Buffer.from(bytes));
    return 'created';
  }
  async head(key: string): Promise<'present' | 'absent'> {
    this.headCalls++;
    if (this.headThrows) throw new Error('simulated HEAD failure');
    if (this.headScript.length) return this.headScript.shift()!;
    return this.map.has(key) ? 'present' : 'absent';
  }
}

function fetcherFor(map: Map<string, Buffer>, opts: { redirect?: boolean; override?: Buffer; status?: number; contentEncoding?: string } = {}): ReceiptFetcher {
  return {
    fetchOnce(url: string): Promise<ReceiptFetchResult> {
      if (opts.redirect) return Promise.resolve({ status: 302, bytes: Buffer.alloc(0), redirected: true });
      const key = new URL(url).pathname.replace(/^\//, '');
      const b = opts.override ?? map.get(key);
      if (!b) return Promise.resolve({ status: 404, bytes: Buffer.alloc(0), redirected: false });
      return Promise.resolve({ status: opts.status ?? 200, bytes: b, redirected: false, contentEncoding: opts.contentEncoding ?? null });
    },
  };
}

async function publish(args: { bytes?: Buffer; exp?: ReceiptV2Expectation; digest?: string; store?: FakeStore; fetcher?: ReceiptFetcher; locator?: typeof LOCATOR; controls?: TransportControls; maxWriteAttempts?: number }) {
  const store = args.store ?? new FakeStore();
  const bytes = args.bytes ?? signedBytes();
  return publishSignedReceiptV2({
    signedReceiptBytes: bytes,
    expectation: args.exp ?? expectation(),
    expectedTargetImageDigest: args.digest ?? DIGEST,
    locator: args.locator ?? LOCATOR,
    controls: args.controls ?? CONTROLS,
    store,
    fetcher: args.fetcher ?? fetcherFor(store.map),
    now: NOW,
    maxWriteAttempts: args.maxWriteAttempts,
  });
}

async function expectRefusal(p: Promise<unknown>, codePrefix: string): Promise<ReceiptPublishError> {
  const err = await p.then(() => null).catch((e) => e);
  expect(err, 'expected a ReceiptPublishError').toBeInstanceOf(ReceiptPublishError);
  const e = err as ReceiptPublishError;
  expect(e.code.startsWith(codePrefix), `code ${e.code} should start with ${codePrefix}`).toBe(true);
  return e;
}

describe('publish-receipt — pre-publication verification refusals (fail-closed)', () => {
  it('refuses an UNSIGNED receipt (signature field removed)', async () => {
    const signed = signReceiptV2(buildSigned(), kp.privateKey);
    const unsigned: Record<string, unknown> = { ...signed };
    delete unsigned.signature;
    const store = new FakeStore();
    await expectRefusal(publish({ bytes: Buffer.from(JSON.stringify(unsigned)), store }), 'local_verify_failed');
    expect(store.putCalls).toBe(0); // nothing written
    expect(store.map.size).toBe(0);
  });
  it('refuses an INVALID signature (flipped byte)', async () => {
    const signed = signReceiptV2(buildSigned(), kp.privateKey);
    const flipped = (signed.signature[0] === 'A' ? 'B' : 'A') + signed.signature.slice(1);
    await expectRefusal(publish({ bytes: Buffer.from(JSON.stringify({ ...signed, signature: flipped })) }), 'local_verify_failed:invalid_signature');
  });
  it('refuses an EXPIRED receipt (migration/publish time after expiry)', async () => {
    const e = await expectRefusal(publish({ bytes: signedBytes({ expiresAt: '2026-08-01T11:50:10.000Z' }) }), 'local_verify_failed:receipt_expired');
    expect(e.step).toBe(17);
  });
  it('refuses a STALE snapshot (older than the freshness window at publish time)', async () => {
    const store = new FakeStore();
    // A far-future publish clock so now - snapshotCreated (11:50:00) > 30min freshness window.
    const p = publishSignedReceiptV2({
      signedReceiptBytes: signedBytes(), expectation: expectation(), expectedTargetImageDigest: DIGEST,
      locator: LOCATOR, controls: CONTROLS, store, fetcher: fetcherFor(store.map),
      now: () => new Date('2026-08-01T12:40:00.000Z'),
    });
    await expectRefusal(p, 'local_verify_failed:snapshot_time_invalid');
    expect(store.putCalls).toBe(0);
  });
  it('refuses a WRONG environment', async () => {
    await expectRefusal(publish({ bytes: signedBytes({ environment: 'production' }) }), 'local_verify_failed:environment_mismatch');
  });
  it('refuses a WRONG application', async () => {
    await expectRefusal(publish({ exp: expectation({ targetApplication: 'king-ai-ops-hub-staging' }), bytes: signedBytes({ targetApplication: 'some-other-app' }), locator: { ...LOCATOR, targetApplication: 'some-other-app' } }), 'local_verify_failed:application_mismatch');
  });
  it('refuses a WRONG deployment nonce', async () => {
    await expectRefusal(publish({ exp: expectation({ deploymentNonce: NONCE }), bytes: signedBytes({ deploymentNonce: 'cafebabecafebabecafebabecafebabe' }), locator: { ...LOCATOR, deploymentNonce: 'cafebabecafebabecafebabecafebabe' } }), 'local_verify_failed:nonce_mismatch');
  });
  it('refuses a WRONG source commit', async () => {
    await expectRefusal(publish({ exp: expectation({ sourceCommit: 'f'.repeat(40) }) }), 'local_verify_failed:source_commit_mismatch');
  });
  it('refuses a WRONG migration set / pending (endpoint/count drift)', async () => {
    await expectRefusal(publish({ exp: expectation({ pendingMigrations: [{ migrationIndex: 9, migrationTag: '0009_other', migrationPath: 'drizzle/0009_other.sql', byteLength: 1, sha256: '1'.repeat(64) }] }) }), 'local_verify_failed:pending_migration_mismatch');
    await expectRefusal(publish({ exp: expectation({ runtimeMigrationSetHash: 'd'.repeat(64) }) }), 'local_verify_failed:migration_set_mismatch');
  });
});

describe('publish-receipt — publish-time image-digest binding', () => {
  it('refuses when the receipt digest != the controller-resolved expected digest', async () => {
    const store = new FakeStore();
    await expectRefusal(publish({ digest: WRONG_DIGEST, store }), 'image_digest_mismatch');
    expect(store.putCalls).toBe(0); // bound BEFORE any write
  });
  it('refuses a malformed expected digest (config guard)', async () => {
    await expectRefusal(publish({ digest: 'not-a-digest' }), 'config_invalid');
  });
});

describe('publish-receipt — deterministic locator + create-only write', () => {
  it('creates once at the exact deterministic locator', async () => {
    const store = new FakeStore();
    const r = await publish({ store });
    expect(r.status).toBe('created');
    expect(r.url).toBe(EXPECTED_URL);
    expect(r.objectKey).toBe(EXPECTED_KEY);
    expect(store.map.has(EXPECTED_KEY)).toBe(true);
    expect(r.receiptSha256).toBe(createHash('sha256').update(signedBytes()).digest('hex')); // read-back hash equals published bytes
    expect(r.deploymentNonce).toBe(NONCE);
  });
  it('refuses to overwrite a DIFFERENT receipt already at the same nonce', async () => {
    const store = new FakeStore();
    await publish({ store }); // receipt A
    const before = store.map.get(EXPECTED_KEY)!;
    // receipt B: different snapshot id ⇒ different bytes, SAME nonce/env/app ⇒ SAME key.
    const bBytes = signedBytes({}, { snapshotId: 'vs_def456', snapshotDiscoveryEvidence: { createResponseSnapshotId: 'vs_def456', listedSnapshotId: 'vs_def456' } });
    await expectRefusal(publish({ store, bytes: bBytes }), 'readback_byte_mismatch');
    expect(store.map.get(EXPECTED_KEY)!.equals(before)).toBe(true); // A untouched — never clobbered
  });
  it('re-publishing the IDENTICAL receipt is a safe idempotent no-op', async () => {
    const store = new FakeStore();
    await publish({ store });
    const r2 = await publish({ store });
    expect(r2.status).toBe('already_present_identical');
  });
  it('refuses an off-allowlist base URL (locator rejected before any write)', async () => {
    const store = new FakeStore();
    await expectRefusal(publish({ store, controls: { ...CONTROLS, hostAllowlist: new Set(['other.example.com']) } }), 'locator_invalid');
    expect(store.putCalls).toBe(0);
  });
});

describe('publish-receipt — ambiguous write reconciliation (HEAD, bounded retry)', () => {
  it('ambiguous + object PRESENT reconciles safely (no overwrite, idempotent success)', async () => {
    const store = new FakeStore();
    store.map.set(EXPECTED_KEY, signedBytes()); // the write actually landed despite the ambiguous response
    store.putScript = ['ambiguous'];
    store.headScript = ['present'];
    const r = await publish({ store });
    expect(r.status).toBe('already_present_identical');
    expect(store.putCalls).toBe(1);
    expect(store.headCalls).toBe(1);
  });
  it('ambiguous + object ABSENT ⇒ bounded retry, then creates', async () => {
    const store = new FakeStore();
    store.putScript = ['ambiguous', 'created'];
    store.headScript = ['absent'];
    const r = await publish({ store });
    expect(r.status).toBe('created');
    expect(store.putCalls).toBe(2);
    expect(store.headCalls).toBe(1);
  });
  it('ambiguous + absent exhausting the attempt budget fails closed (never a silent success)', async () => {
    const store = new FakeStore();
    store.putScript = ['ambiguous', 'ambiguous', 'ambiguous'];
    store.headScript = ['absent', 'absent', 'absent'];
    await expectRefusal(publish({ store, maxWriteAttempts: 3 }), 'write_unconfirmed');
    expect(store.putCalls).toBe(3);
  });
  it('a HEAD read error during reconciliation propagates (outcome never assumed)', async () => {
    const store = new FakeStore();
    store.putScript = ['ambiguous'];
    store.headThrows = true;
    await expect(publish({ store })).rejects.toThrow(/HEAD failure/);
  });
});

describe('publish-receipt — anonymous read-back integrity', () => {
  it('read-back byte mismatch fails', async () => {
    const store = new FakeStore();
    const fetcher = fetcherFor(store.map, { override: Buffer.from('{"tampered":true}') });
    await expectRefusal(publish({ store, fetcher }), 'readback_byte_mismatch');
  });
  it('read-back content that does not hash-match the published bytes is refused', async () => {
    const store = new FakeStore();
    // A byte-length-different payload: trips the integrity guard (byte/hash) — the object read back is not the one written.
    const fetcher = fetcherFor(store.map, { override: Buffer.concat([signedBytes(), Buffer.from(' ')]) });
    const e = await expectRefusal(publish({ store, fetcher }), 'readback_');
    expect(['readback_byte_mismatch', 'readback_hash_mismatch']).toContain(e.code);
  });
  it('read-back redirect fails', async () => {
    const store = new FakeStore();
    await expectRefusal(publish({ store, fetcher: fetcherFor(store.map, { redirect: true }) }), 'readback_redirect');
  });
  it('read-back non-200 fails', async () => {
    const store = new FakeStore();
    await expectRefusal(publish({ store, fetcher: fetcherFor(store.map, { status: 403 }) }), 'readback_bad_status');
  });
});

describe('publish-receipt — end-to-end: publish, then the REAL pre-migration gate accepts', () => {
  it('sign → verify → publish to fake store → anonymous fetch → remote verify → gate verdict "verified"', async () => {
    // 1–3: publish the signed receipt.
    const store = new FakeStore();
    const published = await publish({ store });
    expect(published.status).toBe('created');

    // 4: construct a baked source + DB probe CONSISTENT with the receipt (applied 0000_init; pending 0001_feature).
    const runtimeSet: RuntimeMigrationSet = {
      runtimeMigrationSetHash: RUNTIME,
      entries: [
        { migrationIndex: 0, migrationTag: '0000_init', migrationPath: 'drizzle/0000_init.sql', byteLength: 50, sha256: 'd'.repeat(64) },
        { migrationIndex: 1, migrationTag: '0001_feature', migrationPath: 'drizzle/0001_feature.sql', byteLength: 100, sha256: 'e'.repeat(64) },
      ],
    } as RuntimeMigrationSet;
    const source: ReleaseSourceInputs = {
      journal: [
        { idx: 0, tag: '0000_init', when: 1000 },
        { idx: 1, tag: '0001_feature', when: 2000 },
      ],
      runtimeSet,
      sourceCommit: SRC,
      portableMigrationSetHash: PORTABLE,
    };
    const probe: GateDbProbe = {
      migrationsTableMissing: () => Promise.resolve(false),
      appliedRows: () => Promise.resolve([{ hash: 'applied-0000', createdAt: 1000, id: 1 }]),
      hasUnexplainedUserObjects: () => Promise.resolve(false),
      currentDatabase: () => Promise.resolve('king_ai_ops_hub_staging'),
      systemIdentifier: () => Promise.resolve(DBID),
    };
    const config: GateConfig = {
      environment: 'staging', bypass: false, flyRuntimePresent: true, declaredBootstrap: false, expectedDatabaseIdentity: 'king_ai_ops_hub_staging',
      deploymentNonce: NONCE, receiptBaseUrl: BASE_URL, hostAllowlist: HOSTS, trustBundleEntries: [{ keyId: 'test-dbr-001', algorithm: 'ed25519', publicKeyPem: PEM, purpose: 'deployment_backup_receipt', status: 'active' }],
      targetApplication: 'king-ai-ops-hub-staging', databaseApp: 'king-ai-hub-db-staging', sourceVolumeId: 'vol_4m3kmknl059qpd6v', expectedImageRef: REF,
      minRetentionDays: 7, maxSnapshotAgeMs: 30 * 60 * 1000, transportMaxBytes: 64 * 1024, transportTimeoutMs: 2000,
    };

    // 5: the gate fetches the PUBLISHED object anonymously and verifies it — same path the release machine runs.
    const verdict = await runPreMigrationGate({ config, loadSource: () => source, probe, fetcher: fetcherFor(store.map), now: NOW() });
    expect(verdict.ok).toBe(true);
    expect(verdict.mode).toBe('verified');
    expect(verdict.receiptCanonicalHash).toBe(published.receiptCanonicalHash);
  });
});
