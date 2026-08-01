import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type SignedReceiptV2, signedReceiptV2Schema } from '../../scripts/backup/receipt-v2-schema';
import { deriveReceiptV2Id, finalizeReceiptV2Id, isValidDeploymentNonce, receiptV2CanonicalHash } from '../../scripts/backup/receipt-v2-canonical';
import { signReceiptV2 } from '../../scripts/backup/receipt-v2-sign';
import { ReceiptLocatorError, buildReceiptLocator, validateReceiptUrl } from '../../scripts/backup/receipt-v2-locator';
import { type ReceiptFetcher, fetchAndVerifyReceiptV2 } from '../../scripts/backup/receipt-transport';
import { type ReceiptV2Expectation } from '../../scripts/backup/receipt-v2-verify';
import { normalizeFlyVolumeSnapshot } from '../../scripts/backup/provider-fly-volumes';

const HOSTS = new Set(['receipts.example.com']);
const NONCE = 'deadbeefdeadbeefdeadbeefdeadbeef'; // 32 hex = 128-bit

// ---- build a valid signed receipt payload (shared) -----------------------------------------------
const ev = normalizeFlyVolumeSnapshot(
  { id: 'vs_abc123', status: 'created', volumeId: 'vol_4m3kmknl059qpd6v', databaseApp: 'king-ai-hub-db-staging', createdAt: '2026-08-01T11:50:00.000Z', retentionDays: 7, storedSizeBytes: 130000000 },
  '2026-08-01T11:50:05.000Z',
);
function baseSigned(): SignedReceiptV2 {
  const s: SignedReceiptV2 = {
    schemaVersion: '2', canonicalizationVersion: 1, receiptId: `rcpt2_${'0'.repeat(64)}`,
    environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: 'king-ai-hub-db-staging',
    sourceVolumeId: 'vol_4m3kmknl059qpd6v', databaseSystemIdentifier: '7300000000000000001',
    snapshotProvider: 'fly-volumes', providerSnapshotStatus: 'created', canonicalSnapshotStatus: 'complete',
    snapshotId: ev.evidence.snapshotId, snapshotCreatedAt: ev.evidence.snapshotCreatedAt, providerObservedAt: ev.evidence.providerObservedAt,
    retentionDays: 7, storedSizeBytes: 130000000, providerEvidenceCanonicalDigest: ev.providerEvidenceCanonicalDigest, providerAdapterVersion: 'fly-volumes.v1',
    sourceCommit: 'd2805ffab69bb83926a50d0422d65823b521138f', targetImageRef: 'registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC',
    targetImageDigest: `sha256:${'a'.repeat(64)}`, deploymentNonce: NONCE,
    portableMigrationSetHash: 'b'.repeat(64), runtimeMigrationSetHash: 'c'.repeat(64),
    pendingMigrations: [{ migrationIndex: 54, migrationTag: '0054_example', migrationPath: 'drizzle/0054_example.sql', byteLength: 100, sha256: 'e'.repeat(64) }],
    receiptCreatedAt: '2026-08-01T11:50:06.000Z', expiresAt: '2026-08-01T12:20:06.000Z',
    signatureAlgorithm: 'ed25519', keyId: 'empera-deploy-key-1',
  };
  return finalizeReceiptV2Id(s);
}

describe('G-Backup-B1 receipt-v2 canonicalization + identity', () => {
  it('canonical bytes + derived receipt ID are stable across parse/reserialize', () => {
    const s = baseSigned();
    const again = JSON.parse(JSON.stringify(s)) as SignedReceiptV2;
    expect(deriveReceiptV2Id(again)).toBe(s.receiptId);
    expect(receiptV2CanonicalHash(again)).toBe(receiptV2CanonicalHash(s));
    expect(signedReceiptV2Schema.safeParse(s).success).toBe(true);
  });
  it('receiptId is content-bound (a field change changes it)', () => {
    const s = baseSigned();
    expect(deriveReceiptV2Id({ ...s, retentionDays: 8 })).not.toBe(s.receiptId);
  });
});

describe('G-Backup-B1 deployment nonce', () => {
  it('accepts 32-hex and 22-char base64url; rejects wrong lengths/encodings', () => {
    expect(isValidDeploymentNonce('deadbeefdeadbeefdeadbeefdeadbeef')).toBe(true);
    expect(isValidDeploymentNonce('AAAAAAAAAAAAAAAAAAAAAA')).toBe(true); // 22 base64url
    expect(isValidDeploymentNonce('deadbeef')).toBe(false); // too short
    expect(isValidDeploymentNonce('DEADBEEFDEADBEEFDEADBEEFDEADBEEF')).toBe(false); // uppercase not hex-set
    expect(isValidDeploymentNonce('AAAA=AAAAAAAAAAAAAAAAA')).toBe(false); // padding/invalid char
    expect(isValidDeploymentNonce('')).toBe(false);
  });
});

describe('G-Backup-B1 receipt locator', () => {
  const loc = { baseUrl: 'https://receipts.example.com', environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', deploymentNonce: NONCE, hostAllowlist: HOSTS };
  it('builds the exact deterministic locator (no receipt hash in the path)', () => {
    const url = buildReceiptLocator(loc);
    expect(url).toBe(`https://receipts.example.com/v2/staging/king-ai-ops-hub-staging/${NONCE}.json`);
    expect(() => validateReceiptUrl(url, loc)).not.toThrow();
  });
  it('rejects non-https, wrong host, query, fragment, userinfo, path, wildcard, bad nonce', () => {
    expect(() => buildReceiptLocator({ ...loc, baseUrl: 'http://receipts.example.com' })).toThrow(ReceiptLocatorError);
    expect(() => buildReceiptLocator({ ...loc, baseUrl: 'https://evil.example.com' })).toThrow(ReceiptLocatorError);
    expect(() => buildReceiptLocator({ ...loc, baseUrl: 'https://receipts.example.com/?x=1' })).toThrow(ReceiptLocatorError);
    expect(() => buildReceiptLocator({ ...loc, baseUrl: 'https://receipts.example.com/#f' })).toThrow(ReceiptLocatorError);
    expect(() => buildReceiptLocator({ ...loc, baseUrl: 'https://u:p@receipts.example.com' })).toThrow(ReceiptLocatorError);
    expect(() => buildReceiptLocator({ ...loc, baseUrl: 'https://receipts.example.com/base' })).toThrow(ReceiptLocatorError);
    expect(() => buildReceiptLocator({ ...loc, deploymentNonce: 'bad' })).toThrow(ReceiptLocatorError);
  });
});

describe('G-Backup-B1 transport (injected fake fetcher; no network)', () => {
  const kp = generateKeyPairSync('ed25519');
  const receipt = signReceiptV2(baseSigned(), kp.privateKey);
  const goodBytes = Buffer.from(JSON.stringify(receipt), 'utf8');
  const loc = { baseUrl: 'https://receipts.example.com', environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', deploymentNonce: NONCE };
  const controls = { maxBytes: 64 * 1024, timeoutMs: 2000, hostAllowlist: HOSTS };
  function exp(): ReceiptV2Expectation {
    return {
      environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: 'king-ai-hub-db-staging',
      sourceVolumeId: 'vol_4m3kmknl059qpd6v', databaseSystemIdentifier: '7300000000000000001',
      snapshotProvider: 'fly-volumes', providerAdapterVersion: 'fly-volumes.v1', minRetentionDays: 7, maxSnapshotAgeMs: 30 * 60 * 1000,
      sourceCommit: 'd2805ffab69bb83926a50d0422d65823b521138f', targetImageRef: 'registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC',
      expectedImageDigest: `sha256:${'a'.repeat(64)}`, deploymentNonce: NONCE, portableMigrationSetHash: 'b'.repeat(64), runtimeMigrationSetHash: 'c'.repeat(64),
      pendingMigrations: receipt.pendingMigrations, verificationTime: new Date('2026-08-01T11:50:10.000Z'), migrationStartedAt: new Date('2026-08-01T11:50:20.000Z'),
      supportedSchemaVersions: new Set(['2']), supportedAlgorithms: new Set(['ed25519']), keyring: new Map([['empera-deploy-key-1', { publicKey: kp.publicKey }]]),
    };
  }
  const fetcher = (r: Partial<{ status: number; bytes: Buffer; contentEncoding: string | null; redirected: boolean; throwCode: string }>, counter?: { n: number }): ReceiptFetcher => ({
    fetchOnce() {
      if (counter) counter.n++;
      if (r.throwCode) return Promise.reject(new (class extends Error { code = r.throwCode; })('x'));
      return Promise.resolve({ status: r.status ?? 200, bytes: r.bytes ?? goodBytes, contentEncoding: r.contentEncoding ?? null, redirected: r.redirected ?? false });
    },
  });

  it('the nonce-derived locator + a valid signed receipt verifies (exactly one fetch, no listing)', async () => {
    const counter = { n: 0 };
    const res = await fetchAndVerifyReceiptV2(fetcher({}, counter), loc, controls, exp());
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.receiptCanonicalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(counter.n).toBe(1);
  });
  it('redirect / non-200 / oversize / encoding / timeout / missing all fail closed', async () => {
    expect((await fetchAndVerifyReceiptV2(fetcher({ redirected: true }), loc, controls, exp()))).toMatchObject({ ok: false, stage: 'transport', code: 'redirect' });
    expect((await fetchAndVerifyReceiptV2(fetcher({ status: 404 }), loc, controls, exp()))).toMatchObject({ ok: false, stage: 'transport', code: 'bad_status' });
    expect((await fetchAndVerifyReceiptV2(fetcher({ bytes: Buffer.alloc(64 * 1024 + 1, 0x20) }), loc, controls, exp()))).toMatchObject({ ok: false, stage: 'transport', code: 'oversize' });
    expect((await fetchAndVerifyReceiptV2(fetcher({ contentEncoding: 'gzip' }), loc, controls, exp()))).toMatchObject({ ok: false, stage: 'transport', code: 'encoding_ambiguous' });
    expect((await fetchAndVerifyReceiptV2(fetcher({ throwCode: 'timeout' }), loc, controls, exp()))).toMatchObject({ ok: false, stage: 'transport' });
    expect((await fetchAndVerifyReceiptV2(fetcher({ status: 200, bytes: Buffer.alloc(0) }), loc, controls, exp()))).toMatchObject({ ok: false, stage: 'transport', code: 'empty' });
  });
  it('malformed and duplicate-key JSON fail closed at the verify boundary', async () => {
    expect((await fetchAndVerifyReceiptV2(fetcher({ bytes: Buffer.from('{not json', 'utf8') }), loc, controls, exp()))).toMatchObject({ ok: false, code: 'json_invalid' });
    expect((await fetchAndVerifyReceiptV2(fetcher({ bytes: Buffer.from('{"a":1,"a":2}', 'utf8') }), loc, controls, exp()))).toMatchObject({ ok: false, code: 'json_invalid' });
  });
  it('an invalid signature replacement fails closed', async () => {
    const tampered = { ...receipt, signature: receipt.signature.slice(0, 10) + (receipt.signature[10] === 'A' ? 'B' : 'A') + receipt.signature.slice(11) };
    const res = await fetchAndVerifyReceiptV2(fetcher({ bytes: Buffer.from(JSON.stringify(tampered), 'utf8') }), loc, controls, exp());
    expect(res).toMatchObject({ ok: false, stage: 'verify', code: 'invalid_signature' });
  });
  it('a non-allowlisted host is rejected pre-fetch (locator invalid, fetcher never called)', async () => {
    const counter = { n: 0 };
    const res = await fetchAndVerifyReceiptV2(fetcher({}, counter), loc, { ...controls, hostAllowlist: new Set(['nope.example.com']) }, exp());
    expect(res).toMatchObject({ ok: false, stage: 'transport', code: 'locator_invalid' });
    expect(counter.n).toBe(0);
  });
});
