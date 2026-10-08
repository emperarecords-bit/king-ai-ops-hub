import { execFileSync } from 'node:child_process';
import { generateKeyPairSync as genKey } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it , vi } from 'vitest';
import { HEAVY_HOOK_TIMEOUT_MS, HEAVY_TEST_TIMEOUT_MS } from '../support/heavy-timeout';
// #117: git-blob/DB-heavy test file — bounded timeout headroom under full-suite parallel contention (assertions unchanged).
vi.setConfig({ testTimeout: HEAVY_TEST_TIMEOUT_MS, hookTimeout: HEAVY_HOOK_TIMEOUT_MS });
import {
  type StagingReceiptInputs,
  produceStagingReceipt,
} from '../../scripts/backup/sign-staging-receipt';
import { type ReceiptFetchResult, type ReceiptFetcher } from '../../scripts/backup/receipt-transport';
import {
  type CreateOnlyAttempt,
  type ReceiptObjectStore,
  ReceiptPublishError,
} from '../../scripts/backup/publish-receipt';
import { runPublishCli } from '../../scripts/ci/publish-receipt';

/**
 * G-Backup publish CLI — OFFLINE. Builds the real staging source fixture (migration files from git at the pinned
 * 0078 commit), signs a receipt with an EPHEMERAL key, writes it to a temp file, then drives `runPublishCli` with a
 * FAKE in-memory store + fake anonymous fetcher. No network, no real S3/AWS, no credentials, no deploy. Proves the
 * CLI wires env → expectation → publisher correctly and fails closed on missing config / a tampered receipt.
 */

const kp = genKey('ed25519');
const STAGING_SOURCE_COMMIT = execFileSync('git', ['rev-parse', '1be10f77ab5400b435d36ef05014fffca9f9ab92^{commit}'], { encoding: 'utf8' }).trim();
const RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'publish-cli-src-'));
const journalText = execFileSync('git', ['show', `${STAGING_SOURCE_COMMIT}:drizzle/meta/_journal.json`], { encoding: 'utf8' });
mkdirSync(join(RUNTIME_DIR, 'drizzle', 'meta'), { recursive: true });
writeFileSync(join(RUNTIME_DIR, 'drizzle', 'meta', '_journal.json'), journalText, 'utf8');
for (const e of (JSON.parse(journalText) as { entries: Array<{ tag: string }> }).entries) {
  writeFileSync(join(RUNTIME_DIR, 'drizzle', `${e.tag}.sql`), execFileSync('git', ['show', `${STAGING_SOURCE_COMMIT}:drizzle/${e.tag}.sql`]));
}
const OUT_DIR = mkdtempSync(join(tmpdir(), 'publish-cli-out-'));
afterAll(() => {
  rmSync(RUNTIME_DIR, { recursive: true, force: true });
  rmSync(OUT_DIR, { recursive: true, force: true });
});

// Git-blob manifest + runtime hashing over 78 migrations is disk/git-bound (same as the production-pins test).
const HEAVY = 60_000;

const DIGEST = `sha256:${'a'.repeat(64)}`;
const NONCE = 'deadbeefdeadbeefdeadbeefdeadbeef';
const BASE_URL = 'https://king-ai-ops-hub-receipts-staging.s3.us-east-1.amazonaws.com';
const HOST = 'king-ai-ops-hub-receipts-staging.s3.us-east-1.amazonaws.com';
const APPLIED_COUNT = 69;
const EXPECTED_KEY = `v2/staging/king-ai-ops-hub-staging/${NONCE}.json`;
const EXPECTED_URL = `${BASE_URL}/${EXPECTED_KEY}`;
const PUBLISH_NOW = () => new Date('2026-08-03T12:00:20.000Z'); // within freshness + before expiry

function goodInputs(): StagingReceiptInputs {
  return {
    sourceCommit: STAGING_SOURCE_COMMIT,
    targetImageRef: `registry.fly.io/king-ai-ops-hub-staging@${DIGEST}`,
    targetImageDigest: DIGEST,
    deploymentNonce: NONCE,
    databaseSystemIdentifier: '7300338420798239475',
    snapshotId: 'vs_abc123',
    snapshotRequestedAt: '2026-08-03T12:00:00.000Z',
    snapshotCreatedAt: '2026-08-03T12:00:05.000Z',
    providerObservedAt: '2026-08-03T12:00:10.000Z',
    retentionDays: 7,
    storedSizeBytes: 130000000,
    receiptCreatedAt: '2026-08-03T12:00:15.000Z',
    expiresAt: '2026-08-03T12:30:15.000Z',
    keyId: 'staging-dbr-2026-08',
    discovery: { method: 'create-response-id', createResponseSnapshotId: 'vs_abc123', listedSnapshotId: 'vs_abc123' },
    appliedCount: APPLIED_COUNT,
  };
}

/** Sign a receipt (ephemeral key) and write it to a temp file; return the file path + the public trust entry JSON. */
function writeSignedReceipt(basename: string): { receiptFile: string; trustBundleJson: string } {
  const out = produceStagingReceipt(goodInputs(), kp.privateKey, RUNTIME_DIR);
  const receiptFile = join(OUT_DIR, basename);
  writeFileSync(receiptFile, JSON.stringify(out.receipt), 'utf8');
  return { receiptFile, trustBundleJson: JSON.stringify([out.publicTrustEntry]) };
}

function baseEnv(receiptFile: string, trustBundleJson: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    SOURCE_DIR: RUNTIME_DIR,
    RECEIPT_FILE: receiptFile,
    GBACKUP_RECEIPT_BASE_URL: BASE_URL,
    GBACKUP_RECEIPT_HOSTS: HOST,
    GBACKUP_RECEIPT_TRUST_BUNDLE: trustBundleJson,
    // Same release facts the signer used (independent reconstruction of the expectation):
    SOURCE_COMMIT: STAGING_SOURCE_COMMIT,
    TARGET_IMAGE_REF: `registry.fly.io/king-ai-ops-hub-staging@${DIGEST}`,
    TARGET_IMAGE_DIGEST: DIGEST,
    DEPLOYMENT_NONCE: NONCE,
    DATABASE_SYSTEM_IDENTIFIER: '7300338420798239475',
    SNAPSHOT_ID: 'vs_abc123',
    SNAPSHOT_REQUESTED_AT: '2026-08-03T12:00:00.000Z',
    SNAPSHOT_CREATED_AT: '2026-08-03T12:00:05.000Z',
    PROVIDER_OBSERVED_AT: '2026-08-03T12:00:10.000Z',
    RECEIPT_CREATED_AT: '2026-08-03T12:00:15.000Z',
    EXPIRES_AT: '2026-08-03T12:30:15.000Z',
    RETENTION_DAYS: '7',
    STORED_SIZE_BYTES: '130000000',
    SNAPSHOT_DISCOVERY_METHOD: 'create-response-id',
    CREATE_RESPONSE_SNAPSHOT_ID: 'vs_abc123',
    KEY_ID: 'staging-dbr-2026-08',
    APPLIED_COUNT: String(APPLIED_COUNT),
  };
}

class FakeStore implements ReceiptObjectStore {
  map = new Map<string, Buffer>();
  async putIfAbsentOnce(key: string, bytes: Buffer, _ct: string): Promise<CreateOnlyAttempt> {
    if (this.map.has(key)) return 'exists';
    this.map.set(key, Buffer.from(bytes));
    return 'created';
  }
  async head(key: string): Promise<'present' | 'absent'> {
    return this.map.has(key) ? 'present' : 'absent';
  }
}

function fetcherFor(map: Map<string, Buffer>): ReceiptFetcher {
  return {
    fetchOnce(url: string): Promise<ReceiptFetchResult> {
      const key = new URL(url).pathname.replace(/^\//, '');
      const b = map.get(key);
      if (!b) return Promise.resolve({ status: 404, bytes: Buffer.alloc(0), redirected: false });
      return Promise.resolve({ status: 200, bytes: b, redirected: false, contentEncoding: null });
    },
  };
}

// Sign the fixture ONCE (the expensive step); tests reuse the file + trust bundle.
const SIGNED = writeSignedReceipt('staging-receipt.v2.json');

describe('publish-receipt CLI — happy path (fake store/fetcher)', () => {
  it('publishes the signed receipt to the exact gate locator and verifies it back', async () => {
    const store = new FakeStore();
    const r = await runPublishCli(baseEnv(SIGNED.receiptFile, SIGNED.trustBundleJson), process.cwd(), () => {}, { store, fetcher: fetcherFor(store.map), now: PUBLISH_NOW });
    expect(r.status).toBe('created');
    expect(r.url).toBe(EXPECTED_URL);
    expect(r.objectKey).toBe(EXPECTED_KEY);
    expect(r.deploymentNonce).toBe(NONCE);
    expect(store.map.has(EXPECTED_KEY)).toBe(true);
  }, HEAVY);

  it('re-publishing the identical receipt is a safe idempotent no-op (never overwrites)', async () => {
    const store = new FakeStore();
    const env = baseEnv(SIGNED.receiptFile, SIGNED.trustBundleJson);
    await runPublishCli(env, process.cwd(), () => {}, { store, fetcher: fetcherFor(store.map), now: PUBLISH_NOW });
    const r2 = await runPublishCli(env, process.cwd(), () => {}, { store, fetcher: fetcherFor(store.map), now: PUBLISH_NOW });
    expect(r2.status).toBe('already_present_identical');
  }, HEAVY);

  it('writes sanitized publication evidence (non-secret only) when PUBLISH_EVIDENCE_FILE is set', async () => {
    const store = new FakeStore();
    const evidenceFile = join(OUT_DIR, 'evidence.json');
    const env = { ...baseEnv(SIGNED.receiptFile, SIGNED.trustBundleJson), PUBLISH_EVIDENCE_FILE: evidenceFile };
    await runPublishCli(env, process.cwd(), () => {}, { store, fetcher: fetcherFor(store.map), now: PUBLISH_NOW });
    const raw = readFileSync(evidenceFile, 'utf8');
    const ev = JSON.parse(raw);
    expect(ev.status).toBe('created');
    expect(ev.publicUrl).toBe(EXPECTED_URL);
    expect(ev.deploymentNonce).toBe(NONCE);
    expect(ev.sourceCommit).toBe(STAGING_SOURCE_COMMIT);
    expect(ev.targetImageDigest).toBe(DIGEST);
    expect(typeof ev.receiptSha256).toBe('string');
    expect(ev.publishedAtUtc).toMatch(/Z$/);
    // No credential / secret material may appear in the evidence.
    expect(/SECRET|ACCESS_KEY|PRIVATE KEY/i.test(raw)).toBe(false);
  }, HEAVY);
});

describe('publish-receipt CLI — fail-closed', () => {
  it('throws when GBACKUP_RECEIPT_BASE_URL is missing', async () => {
    const env = baseEnv(SIGNED.receiptFile, SIGNED.trustBundleJson);
    delete env.GBACKUP_RECEIPT_BASE_URL;
    const store = new FakeStore();
    await expect(runPublishCli(env, process.cwd(), () => {}, { store, fetcher: fetcherFor(store.map), now: PUBLISH_NOW })).rejects.toThrow(/GBACKUP_RECEIPT_BASE_URL/);
  }, HEAVY);

  it('throws when RECEIPT_FILE is missing (before any heavy work)', async () => {
    const env = baseEnv(SIGNED.receiptFile, SIGNED.trustBundleJson);
    delete env.RECEIPT_FILE;
    await expect(runPublishCli(env, process.cwd(), () => {}, { store: new FakeStore() })).rejects.toThrow(/RECEIPT_FILE/);
  });

  it('refuses a tampered receipt file (verification fails before any write)', async () => {
    const tamperedFile = join(OUT_DIR, 'tampered.v2.json');
    const receipt = JSON.parse(readFileSync(SIGNED.receiptFile, 'utf8'));
    receipt.signature = (receipt.signature[0] === 'A' ? 'B' : 'A') + receipt.signature.slice(1);
    writeFileSync(tamperedFile, JSON.stringify(receipt), 'utf8');
    const env = baseEnv(tamperedFile, SIGNED.trustBundleJson);
    const store = new FakeStore();
    const err = await runPublishCli(env, process.cwd(), () => {}, { store, fetcher: fetcherFor(store.map), now: PUBLISH_NOW }).then(() => null).catch((e) => e);
    expect(err).toBeInstanceOf(ReceiptPublishError);
    expect((err as ReceiptPublishError).code.startsWith('local_verify_failed')).toBe(true);
    expect(store.map.size).toBe(0);
  }, HEAVY);

  it('requires the DEDICATED receipt S3 credential when no store is injected (real path, no network)', async () => {
    // No GBACKUP_RECEIPT_S3_* set and no injected store ⇒ fails building the credential BEFORE any network call.
    await expect(runPublishCli(baseEnv(SIGNED.receiptFile, SIGNED.trustBundleJson), process.cwd(), () => {}, { now: PUBLISH_NOW })).rejects.toThrow(/GBACKUP_RECEIPT_S3_/);
  }, HEAVY);
});
