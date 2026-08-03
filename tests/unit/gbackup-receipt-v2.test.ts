import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type SignedReceiptV2, signedReceiptV2Schema } from '../../scripts/backup/receipt-v2-schema';
import { deriveReceiptV2Id, finalizeReceiptV2Id, isValidDeploymentNonce, receiptV2CanonicalHash } from '../../scripts/backup/receipt-v2-canonical';
import { signReceiptV2 } from '../../scripts/backup/receipt-v2-sign';
import { ReceiptLocatorError, buildReceiptLocator, validateReceiptUrl } from '../../scripts/backup/receipt-v2-locator';
import { type ReceiptFetcher, fetchAndVerifyReceiptV2 } from '../../scripts/backup/receipt-transport';
import { type ReceiptV2Expectation } from '../../scripts/backup/receipt-v2-verify';
import { normalizeFlyVolumeSnapshot } from '../../scripts/backup/provider-fly-volumes';
import { loadReceiptKeyBundle } from '../../scripts/backup/receipt-key-bundle';

const HOSTS = new Set(['receipts.example.com']);
const NONCE = 'deadbeefdeadbeefdeadbeefdeadbeef';
const kp = generateKeyPairSync('ed25519');
const keyLoad = loadReceiptKeyBundle([{ keyId: 'test-dbr-001', algorithm: 'ed25519', publicKeyPem: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(), purpose: 'deployment_backup_receipt', status: 'active' }]);
if (!keyLoad.ok) throw new Error(keyLoad.code);

const ev = normalizeFlyVolumeSnapshot(
  { id: 'vs_abc123', status: 'created', volumeId: 'vol_4m3kmknl059qpd6v', databaseApp: 'king-ai-hub-db-staging', createdAt: '2026-08-01T11:50:00.000Z', retentionDays: 7, storedSizeBytes: 130000000 },
  { snapshotRequestedAt: '2026-08-01T11:49:58.000Z', providerObservedAt: '2026-08-01T11:50:05.000Z', snapshotDiscoveryMethod: 'create-response-id', discoveryEvidence: { createResponseSnapshotId: 'vs_abc123', listedSnapshotId: 'vs_abc123' } },
);
function baseSigned(): SignedReceiptV2 {
  const e = ev.evidence;
  return finalizeReceiptV2Id({
    schemaVersion: '2', canonicalizationVersion: 1, receiptId: `rcpt2_${'0'.repeat(64)}`,
    environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: e.databaseApp,
    sourceVolumeId: e.sourceVolumeId, databaseSystemIdentifier: '7300338420798239475',
    snapshotProvider: 'fly-volumes', providerSnapshotStatus: e.providerSnapshotStatus, canonicalSnapshotStatus: 'complete', snapshotDiscoveryMethod: 'create-response-id',
    snapshotDiscoveryEvidence: { createResponseSnapshotId: 'vs_abc123', listedSnapshotId: 'vs_abc123' },
    snapshotId: e.snapshotId, snapshotRequestedAt: e.snapshotRequestedAt, snapshotCreatedAt: e.snapshotCreatedAt, providerObservedAt: e.providerObservedAt,
    retentionDays: 7, storedSizeBytes: 130000000, normalizedProviderEvidenceDigest: ev.normalizedProviderEvidenceDigest, providerAdapterVersion: 'fly-volumes.v1',
    sourceCommit: 'd2805ffab69bb83926a50d0422d65823b521138f', targetImageRef: 'registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC',
    targetImageDigest: `sha256:${'a'.repeat(64)}`, deploymentNonce: NONCE, portableMigrationSetHash: 'b'.repeat(64), runtimeMigrationSetHash: 'c'.repeat(64),
    pendingMigrations: [{ migrationIndex: 54, migrationTag: '0054_example', migrationPath: 'drizzle/0054_example.sql', byteLength: 100, sha256: 'e'.repeat(64) }],
    receiptCreatedAt: '2026-08-01T11:50:06.000Z', expiresAt: '2026-08-01T12:20:06.000Z', signatureAlgorithm: 'ed25519', keyId: 'test-dbr-001',
  });
}

describe('G-Backup-B1 receipt-v2 canonicalization + identity', () => {
  it('canonical bytes + derived receipt ID stable across parse/reserialize; schema valid', () => {
    const s = baseSigned();
    const again = JSON.parse(JSON.stringify(s)) as SignedReceiptV2;
    expect(deriveReceiptV2Id(again)).toBe(s.receiptId);
    expect(receiptV2CanonicalHash(again)).toBe(receiptV2CanonicalHash(s));
    expect(signedReceiptV2Schema.safeParse(s).success).toBe(true);
  });
  it('receiptId is content-bound', () => {
    const s = baseSigned();
    expect(deriveReceiptV2Id({ ...s, retentionDays: 8 })).not.toBe(s.receiptId);
  });
  it('accepts an EMPTY pending list; canonical bytes + receiptId stay stable (NO_PENDING receipt)', () => {
    const s = finalizeReceiptV2Id({ ...baseSigned(), pendingMigrations: [] });
    expect(s.pendingMigrations).toEqual([]);
    expect(signedReceiptV2Schema.safeParse(s).success).toBe(true);
    const again = JSON.parse(JSON.stringify(s)) as SignedReceiptV2;
    expect(deriveReceiptV2Id(again)).toBe(s.receiptId);
    expect(receiptV2CanonicalHash(again)).toBe(receiptV2CanonicalHash(s));
    // A different pending list yields a different identity — the empty list is content-bound like any other.
    expect(deriveReceiptV2Id(baseSigned())).not.toBe(s.receiptId);
  });
});

describe('G-Backup-B1 deployment nonce (canonical)', () => {
  it('accepts canonical hex(32)/base64url(22); rejects alias/padding/short', () => {
    expect(isValidDeploymentNonce('deadbeefdeadbeefdeadbeefdeadbeef')).toBe(true);
    expect(isValidDeploymentNonce('AAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
    expect(isValidDeploymentNonce('AAAAAAAAAAAAAAAAAAAAAB')).toBe(false); // non-canonical alias
    expect(isValidDeploymentNonce('deadbeef')).toBe(false);
  });
});

describe('G-Backup-B1 receipt locator', () => {
  const loc = { baseUrl: 'https://receipts.example.com', environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', deploymentNonce: NONCE, hostAllowlist: HOSTS };
  it('builds the exact deterministic locator', () => {
    expect(buildReceiptLocator(loc)).toBe(`https://receipts.example.com/v2/staging/king-ai-ops-hub-staging/${NONCE}.json`);
    expect(() => validateReceiptUrl(buildReceiptLocator(loc), loc)).not.toThrow();
  });
  it('rejects non-https / wrong host / query / fragment / userinfo / path / bad nonce', () => {
    for (const bad of ['http://receipts.example.com', 'https://evil.example.com', 'https://receipts.example.com/?x=1', 'https://receipts.example.com/#f', 'https://u:p@receipts.example.com', 'https://receipts.example.com/base']) {
      expect(() => buildReceiptLocator({ ...loc, baseUrl: bad })).toThrow(ReceiptLocatorError);
    }
    expect(() => buildReceiptLocator({ ...loc, deploymentNonce: 'bad' })).toThrow(ReceiptLocatorError);
  });
});

describe('G-Backup-B1 transport (injected fake; no network)', () => {
  const receipt = signReceiptV2(baseSigned(), kp.privateKey);
  const goodBytes = Buffer.from(JSON.stringify(receipt), 'utf8');
  const loc = { baseUrl: 'https://receipts.example.com', environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', deploymentNonce: NONCE };
  const controls = { maxBytes: 64 * 1024, timeoutMs: 2000, hostAllowlist: HOSTS };
  const exp = (): ReceiptV2Expectation => ({
    environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: 'king-ai-hub-db-staging',
    sourceVolumeId: 'vol_4m3kmknl059qpd6v', databaseSystemIdentifier: '7300338420798239475',
    snapshotProvider: 'fly-volumes', providerAdapterVersion: 'fly-volumes.v1', minRetentionDays: 7, maxSnapshotAgeMs: 30 * 60 * 1000,
    sourceCommit: 'd2805ffab69bb83926a50d0422d65823b521138f', targetImageRef: 'registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC',
    deploymentNonce: NONCE, portableMigrationSetHash: 'b'.repeat(64), runtimeMigrationSetHash: 'c'.repeat(64),
    pendingMigrations: receipt.pendingMigrations, migrationStartedAt: new Date('2026-08-01T11:50:20.000Z'),
    supportedSchemaVersions: new Set(['2']), supportedAlgorithms: new Set(['ed25519']), keyStore: keyLoad.store,
  });
  const fetcher = (r: Partial<{ status: number; bytes: Buffer; contentEncoding: string | null; redirected: boolean; throwCode: string }>, counter?: { n: number }): ReceiptFetcher => ({
    fetchOnce() {
      if (counter) counter.n++;
      if (r.throwCode) return Promise.reject(new (class extends Error { code = r.throwCode; })('x'));
      return Promise.resolve({ status: r.status ?? 200, bytes: r.bytes ?? goodBytes, contentEncoding: r.contentEncoding ?? null, redirected: r.redirected ?? false });
    },
  });

  it('valid signed receipt verifies (exactly one fetch)', async () => {
    const counter = { n: 0 };
    const res = await fetchAndVerifyReceiptV2(fetcher({}, counter), loc, controls, exp());
    expect(res.ok).toBe(true);
    expect(counter.n).toBe(1);
  });
  it('redirect / non-200 / oversize / encoding / timeout / empty fail closed', async () => {
    expect(await fetchAndVerifyReceiptV2(fetcher({ redirected: true }), loc, controls, exp())).toMatchObject({ ok: false, code: 'redirect' });
    expect(await fetchAndVerifyReceiptV2(fetcher({ status: 404 }), loc, controls, exp())).toMatchObject({ ok: false, code: 'bad_status' });
    expect(await fetchAndVerifyReceiptV2(fetcher({ bytes: Buffer.alloc(64 * 1024 + 1, 0x20) }), loc, controls, exp())).toMatchObject({ ok: false, code: 'oversize' });
    expect(await fetchAndVerifyReceiptV2(fetcher({ contentEncoding: 'gzip' }), loc, controls, exp())).toMatchObject({ ok: false, code: 'encoding_ambiguous' });
    expect(await fetchAndVerifyReceiptV2(fetcher({ throwCode: 'timeout' }), loc, controls, exp())).toMatchObject({ ok: false, stage: 'transport' });
    expect(await fetchAndVerifyReceiptV2(fetcher({ bytes: Buffer.alloc(0) }), loc, controls, exp())).toMatchObject({ ok: false, code: 'empty' });
  });
  it('malformed / duplicate-key JSON and tampered signature fail closed', async () => {
    expect(await fetchAndVerifyReceiptV2(fetcher({ bytes: Buffer.from('{bad', 'utf8') }), loc, controls, exp())).toMatchObject({ ok: false, code: 'json_invalid' });
    expect(await fetchAndVerifyReceiptV2(fetcher({ bytes: Buffer.from('{"a":1,"a":2}', 'utf8') }), loc, controls, exp())).toMatchObject({ ok: false, code: 'json_invalid' });
    const t = { ...receipt, signature: receipt.signature.slice(0, 10) + (receipt.signature[10] === 'A' ? 'B' : 'A') + receipt.signature.slice(11) };
    expect(await fetchAndVerifyReceiptV2(fetcher({ bytes: Buffer.from(JSON.stringify(t), 'utf8') }), loc, controls, exp())).toMatchObject({ ok: false, stage: 'verify', code: 'invalid_signature' });
  });
  it('non-allowlisted host rejected pre-fetch (fetcher never called)', async () => {
    const counter = { n: 0 };
    const res = await fetchAndVerifyReceiptV2(fetcher({}, counter), loc, { ...controls, hostAllowlist: new Set(['nope.example.com']) }, exp());
    expect(res).toMatchObject({ ok: false, code: 'locator_invalid' });
    expect(counter.n).toBe(0);
  });
});
