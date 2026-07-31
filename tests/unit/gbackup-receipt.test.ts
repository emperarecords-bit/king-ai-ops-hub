import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type SignedReceipt } from '../../scripts/backup/receipt-schema';
import { canonicalReceiptString } from '../../scripts/backup/receipt-canonical';
import { type VerifyContext, signReceipt, verifyReceipt } from '../../scripts/backup/receipt-verify';

const kp = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

function signed(over: Partial<SignedReceipt> = {}): SignedReceipt {
  return {
    receiptVersion: '1',
    environment: 'staging',
    databaseApp: 'king-ai-hub-db-staging',
    volumeId: 'vol_4m3kmknl059qpd6v',
    snapshotId: 'snap_1',
    snapshotStatus: 'complete',
    snapshotCreatedAt: '2026-07-30T00:00:00.000Z',
    receiptCreatedAt: '2026-07-30T00:05:00.000Z',
    expiresAt: '2026-07-30T01:00:00.000Z',
    sourceCommit: '3a1ed677afaf6616aa5b051f99a4d013ca74a599',
    sourceRelease: 'v124',
    targetApplication: 'king-ai-ops-hub-staging',
    pendingMigrations: ['0054_example'],
    migrationSetHash: 'a'.repeat(64),
    deploymentNonce: 'nonce-abcdefghij0123',
    verificationResult: 'verified',
    signatureAlgorithm: 'ed25519',
    keyId: 'k1',
    ...over,
  };
}

function ctx(over: Partial<VerifyContext> = {}): VerifyContext {
  return {
    now: new Date('2026-07-30T00:06:00.000Z'),
    migrationStartedAt: new Date('2026-07-30T00:10:00.000Z'),
    environment: 'staging',
    databaseApp: 'king-ai-hub-db-staging',
    volumeId: 'vol_4m3kmknl059qpd6v',
    targetApplication: 'king-ai-ops-hub-staging',
    sourceCommit: '3a1ed677afaf6616aa5b051f99a4d013ca74a599',
    migrationSetHash: 'a'.repeat(64),
    supportedReceiptVersions: new Set(['1']),
    supportedAlgorithms: new Set(['ed25519']),
    keyring: { k1: kp.publicKey },
    ...over,
  };
}

describe('G-Backup-A receipt signing + verification', () => {
  it('a valid signed receipt is accepted; signature is base64url', () => {
    const r = signReceipt(signed(), kp.privateKey);
    expect(r.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifyReceipt(r, ctx())).toEqual({ ok: true });
  });

  it('a tampered signed field is rejected (invalid signature)', () => {
    const r = { ...signReceipt(signed(), kp.privateKey), sourceRelease: 'v999' };
    expect(verifyReceipt(r, ctx())).toEqual({ ok: false, reason: 'invalid signature' });
  });

  it('wrong public key is rejected', () => {
    const r = signReceipt(signed(), kp.privateKey);
    expect(verifyReceipt(r, ctx({ keyring: { k1: other.publicKey } }))).toEqual({ ok: false, reason: 'invalid signature' });
  });

  it('unknown keyId is rejected', () => {
    const r = signReceipt(signed(), kp.privateKey);
    expect(verifyReceipt(r, ctx({ keyring: {} })).ok).toBe(false);
    expect(verifyReceipt(r, ctx({ keyring: {} }))).toMatchObject({ reason: expect.stringContaining('unknown keyId') });
  });

  it('unsupported algorithm / version is rejected', () => {
    const r = signReceipt(signed(), kp.privateKey);
    expect(verifyReceipt(r, ctx({ supportedAlgorithms: new Set() }))).toMatchObject({ reason: expect.stringContaining('unsupported signatureAlgorithm') });
    expect(verifyReceipt(r, ctx({ supportedReceiptVersions: new Set() }))).toMatchObject({ reason: expect.stringContaining('unsupported receiptVersion') });
  });

  it('expired / future-created receipts are rejected', () => {
    const r = signReceipt(signed(), kp.privateKey);
    expect(verifyReceipt(r, ctx({ now: new Date('2026-07-30T02:00:00.000Z') }))).toMatchObject({ reason: 'receipt expired' });
    const future = signReceipt(signed({ receiptCreatedAt: '2026-07-30T00:30:00.000Z' }), kp.privateKey);
    expect(verifyReceipt(future, ctx())).toMatchObject({ reason: expect.stringContaining('future') });
  });

  it('binding mismatches are rejected (env/db/volume/app/commit/migration-set)', () => {
    const r = signReceipt(signed(), kp.privateKey);
    expect(verifyReceipt(r, ctx({ environment: 'production' }))).toMatchObject({ reason: 'environment mismatch' });
    expect(verifyReceipt(r, ctx({ databaseApp: 'x' }))).toMatchObject({ reason: 'databaseApp mismatch' });
    expect(verifyReceipt(r, ctx({ volumeId: 'x' }))).toMatchObject({ reason: 'volumeId mismatch' });
    expect(verifyReceipt(r, ctx({ targetApplication: 'x' }))).toMatchObject({ reason: 'targetApplication mismatch' });
    expect(verifyReceipt(r, ctx({ sourceCommit: 'x' }))).toMatchObject({ reason: 'sourceCommit mismatch' });
    expect(verifyReceipt(r, ctx({ migrationSetHash: 'x' }))).toMatchObject({ reason: 'migrationSetHash mismatch' });
  });

  it('snapshotStatus other than complete is rejected', () => {
    const r = signReceipt(signed({ snapshotStatus: 'pending' }), kp.privateKey);
    expect(verifyReceipt(r, ctx())).toMatchObject({ reason: expect.stringContaining("snapshotStatus is 'pending'") });
  });

  it('snapshot created at/after migration start is rejected', () => {
    const r = signReceipt(signed({ snapshotCreatedAt: '2026-07-30T00:20:00.000Z' }), kp.privateKey);
    expect(verifyReceipt(r, ctx())).toMatchObject({ reason: expect.stringContaining('predate migration') });
  });

  it('a too-short / whitespace deploymentNonce is rejected (schema bounds high-entropy nonces)', () => {
    const r = { ...signReceipt(signed(), kp.privateKey), deploymentNonce: ' ' };
    expect(verifyReceipt(r, ctx())).toMatchObject({ ok: false, reason: expect.stringContaining('schema') });
  });

  it('receipt with an extra (secret-looking) field is rejected by the strict schema', () => {
    const r = { ...signReceipt(signed(), kp.privateKey), databaseUrl: 'postgres://u:p@h/db' } as unknown;
    expect(verifyReceipt(r, ctx())).toMatchObject({ ok: false, reason: expect.stringContaining('schema') });
  });

  it('canonical serialization is stable after parse+reload', () => {
    const s = signed();
    const a = canonicalReceiptString(s);
    const b = canonicalReceiptString(JSON.parse(JSON.stringify(s)) as SignedReceipt);
    expect(a).toBe(b);
  });
});

describe('G-Backup-A receipt content-safety constraints (correction 5)', () => {
  const good = () => signReceipt(signed(), kp.privateKey);
  // A tampered field is caught at the STRICT SCHEMA before signature verification.
  it('rejects a database URL with credentials in a name field', () => {
    expect(verifyReceipt({ ...good(), databaseApp: 'postgres://u:p@h:5432/db' }, ctx())).toMatchObject({ reason: expect.stringContaining('schema') });
  });
  it('rejects a bearer token', () => {
    expect(verifyReceipt({ ...good(), sourceRelease: 'Bearer abc.def.ghi' }, ctx())).toMatchObject({ reason: expect.stringContaining('schema') });
  });
  it('rejects a PEM private-key block', () => {
    expect(verifyReceipt({ ...good(), keyId: '-----BEGIN PRIVATE KEY-----' }, ctx())).toMatchObject({ reason: expect.stringContaining('schema') });
  });
  it('rejects multiline injection', () => {
    expect(verifyReceipt({ ...good(), databaseApp: 'ok\nrm -rf' }, ctx())).toMatchObject({ reason: expect.stringContaining('schema') });
  });
  it('rejects control characters', () => {
    expect(verifyReceipt({ ...good(), databaseApp: 'okbell' }, ctx())).toMatchObject({ reason: expect.stringContaining('schema') });
  });
  it('rejects an overlong field', () => {
    expect(verifyReceipt({ ...good(), databaseApp: 'a'.repeat(129) }, ctx())).toMatchObject({ reason: expect.stringContaining('schema') });
  });
  it('rejects an invalid git commit', () => {
    expect(verifyReceipt({ ...good(), sourceCommit: 'nothex' }, ctx())).toMatchObject({ reason: expect.stringContaining('schema') });
  });
  it('rejects an invalid migration-set hash', () => {
    expect(verifyReceipt({ ...good(), migrationSetHash: 'abc' }, ctx())).toMatchObject({ reason: expect.stringContaining('schema') });
  });
  it('rejects an invalid signature encoding', () => {
    expect(verifyReceipt({ ...good(), signature: 'not+valid/base64url==' }, ctx())).toMatchObject({ reason: expect.stringContaining('schema') });
  });
});
