import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type SignedReceiptV2 } from '../../scripts/backup/receipt-v2-schema';
import { finalizeReceiptV2Id } from '../../scripts/backup/receipt-v2-canonical';
import { signReceiptV2 } from '../../scripts/backup/receipt-v2-sign';
import { computeProviderEvidenceDigest } from '../../scripts/backup/provider-fly-volumes';
import { type ReceiptV2Expectation, verifyReceiptV2Bytes, verifyReceiptV2Parsed } from '../../scripts/backup/receipt-v2-verify';

const kp = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const NONCE = 'deadbeefdeadbeefdeadbeefdeadbeef';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function evidenceFrom(over: Record<string, unknown> = {}) {
  const e = {
    snapshotProvider: 'fly-volumes', providerAdapterVersion: 'fly-volumes.v1', snapshotId: 'vs_abc123',
    sourceVolumeId: 'vol_4m3kmknl059qpd6v', databaseApp: 'king-ai-hub-db-staging', providerSnapshotStatus: 'created',
    canonicalSnapshotStatus: 'complete', snapshotCreatedAt: '2026-08-01T11:50:00.000Z', providerObservedAt: '2026-08-01T11:50:05.000Z',
    retentionDays: 7, storedSizeBytes: 130000000, ...over,
  } as never;
  return { e, digest: computeProviderEvidenceDigest(e) };
}

function buildSigned(over: Partial<SignedReceiptV2> = {}, evOver: Record<string, unknown> = {}, breakDigest = false): SignedReceiptV2 {
  const { e, digest } = evidenceFrom(evOver);
  const ev = e as unknown as Record<string, string | number>;
  const signed: SignedReceiptV2 = {
    schemaVersion: '2', canonicalizationVersion: 1, receiptId: `rcpt2_${'0'.repeat(64)}`,
    environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: ev.databaseApp as string,
    sourceVolumeId: ev.sourceVolumeId as string, databaseSystemIdentifier: '7300000000000000001',
    snapshotProvider: 'fly-volumes', providerSnapshotStatus: ev.providerSnapshotStatus as string, canonicalSnapshotStatus: 'complete',
    snapshotId: ev.snapshotId as string, snapshotCreatedAt: ev.snapshotCreatedAt as string, providerObservedAt: ev.providerObservedAt as string,
    retentionDays: ev.retentionDays as number, storedSizeBytes: ev.storedSizeBytes as number,
    providerEvidenceCanonicalDigest: breakDigest ? 'f'.repeat(64) : digest, providerAdapterVersion: ev.providerAdapterVersion as string,
    sourceCommit: 'd2805ffab69bb83926a50d0422d65823b521138f', targetImageRef: 'registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC',
    targetImageDigest: DIGEST, deploymentNonce: NONCE, portableMigrationSetHash: 'b'.repeat(64), runtimeMigrationSetHash: 'c'.repeat(64),
    pendingMigrations: [{ migrationIndex: 54, migrationTag: '0054_example', migrationPath: 'drizzle/0054_example.sql', byteLength: 100, sha256: 'e'.repeat(64) }],
    receiptCreatedAt: '2026-08-01T11:50:06.000Z', expiresAt: '2026-08-01T12:20:06.000Z',
    signatureAlgorithm: 'ed25519', keyId: 'empera-deploy-key-1', ...over,
  };
  return finalizeReceiptV2Id(signed);
}
const sign = (s: SignedReceiptV2) => signReceiptV2(s, kp.privateKey);

function exp(over: Partial<ReceiptV2Expectation> = {}): ReceiptV2Expectation {
  return {
    environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: 'king-ai-hub-db-staging',
    sourceVolumeId: 'vol_4m3kmknl059qpd6v', databaseSystemIdentifier: '7300000000000000001',
    snapshotProvider: 'fly-volumes', providerAdapterVersion: 'fly-volumes.v1', minRetentionDays: 7, maxSnapshotAgeMs: 30 * 60 * 1000,
    sourceCommit: 'd2805ffab69bb83926a50d0422d65823b521138f', targetImageRef: 'registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC',
    expectedImageDigest: DIGEST, deploymentNonce: NONCE, portableMigrationSetHash: 'b'.repeat(64), runtimeMigrationSetHash: 'c'.repeat(64),
    pendingMigrations: [{ migrationIndex: 54, migrationTag: '0054_example', migrationPath: 'drizzle/0054_example.sql', byteLength: 100, sha256: 'e'.repeat(64) }],
    verificationTime: new Date('2026-08-01T11:50:10.000Z'), migrationStartedAt: new Date('2026-08-01T11:50:20.000Z'),
    supportedSchemaVersions: new Set(['2']), supportedAlgorithms: new Set(['ed25519']),
    keyring: new Map([['empera-deploy-key-1', { publicKey: kp.publicKey }]]),
    ...over,
  };
}
const codeOf = (r: ReturnType<typeof verifyReceiptV2Parsed>) => (r.ok ? 'OK' : r.code);

describe('G-Backup-B1 receipt-v2 verifier — happy path + signature/schema', () => {
  it('a valid receipt verifies and exposes the canonical hash', () => {
    const r = verifyReceiptV2Parsed(sign(buildSigned()), exp());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.receiptCanonicalHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('one-byte signature tamper fails (invalid_signature)', () => {
    const rc = sign(buildSigned());
    const t = { ...rc, signature: rc.signature.slice(0, 10) + (rc.signature[10] === 'A' ? 'B' : 'A') + rc.signature.slice(11) };
    expect(codeOf(verifyReceiptV2Parsed(t, exp()))).toBe('invalid_signature');
  });
  it('wrong key fails (invalid_signature)', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ keyring: new Map([['empera-deploy-key-1', { publicKey: other.publicKey }]]) })))).toBe('invalid_signature');
  });
  it('unknown key fails', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ keyring: new Map() })))).toBe('unknown_key');
  });
  it('a tampered signed field fails receipt_id or signature (derived-id bound)', () => {
    const rc = sign(buildSigned());
    expect(verifyReceiptV2Parsed({ ...rc, sourceCommit: 'a'.repeat(40) }, exp()).ok).toBe(false);
  });
  it('unknown version / duplicate-key / invalid-utf8 / unsafe-integer fail at bytes boundary', () => {
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from(JSON.stringify({ ...sign(buildSigned()), schemaVersion: '3' })), exp()))).toBe('schema_invalid');
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from('{"a":1,"a":2}'), exp()))).toBe('json_invalid');
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]), exp()))).toBe('json_invalid');
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from('{"n":9007199254740993}'), exp()))).toBe('json_invalid');
  });
});

describe('G-Backup-B1 receipt-v2 verifier — provider evidence', () => {
  it('retention below 7 rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({ retentionDays: 5 }, { retentionDays: 5 })), exp()))).toBe('provider_evidence_invalid');
  });
  it('adapter-version mismatch rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({ providerAdapterVersion: 'fly-volumes.v2' }, { providerAdapterVersion: 'fly-volumes.v2' })), exp()))).toBe('provider_evidence_invalid');
  });
  it('evidence-digest mismatch rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({}, {}, true)), exp()))).toBe('provider_evidence_invalid');
  });
  it('providerObservedAt before snapshotCreatedAt rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({}, { providerObservedAt: '2026-08-01T11:49:00.000Z' })), exp()))).toBe('provider_evidence_invalid');
  });
  it('providerObservedAt in the future rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({}, { providerObservedAt: '2026-08-01T13:00:00.000Z' })), exp()))).toBe('provider_evidence_invalid');
  });
  it('wrong provider (raw JSON) rejected by schema', () => {
    const rc = sign(buildSigned());
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from(JSON.stringify({ ...rc, snapshotProvider: 'aws' })), exp()))).toBe('schema_invalid');
  });
});

describe('G-Backup-B1 receipt-v2 verifier — identity + snapshot time', () => {
  it('wrong volume / db app / system id rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ sourceVolumeId: 'vol_other' })))).toBe('db_identity_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ databaseApp: 'other-db' })))).toBe('db_identity_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ databaseSystemIdentifier: '9' })))).toBe('db_identity_mismatch');
  });
  it('snapshot too old / after migration start rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ migrationStartedAt: new Date('2026-08-01T12:40:00.000Z') })))).toBe('snapshot_time_invalid'); // >30min
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ migrationStartedAt: new Date('2026-08-01T11:49:00.000Z') })))).toBe('snapshot_time_invalid'); // before snapshot
  });
  it('expired receipt rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ verificationTime: new Date('2026-08-01T13:00:00.000Z'), migrationStartedAt: new Date('2026-08-01T11:50:20.000Z') })))).toBe('receipt_expired');
  });
});

describe('G-Backup-B1 receipt-v2 verifier — deployment + image + release', () => {
  it('nonce / image ref / image digest / source-commit mismatches rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ deploymentNonce: 'cafebabecafebabecafebabecafebabe' })))).toBe('nonce_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ targetImageRef: 'registry.fly.io/king-ai-ops-hub-staging:deployment-OTHER' })))).toBe('image_ref_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ expectedImageDigest: `sha256:${'9'.repeat(64)}` })))).toBe('image_digest_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ sourceCommit: 'f'.repeat(40) })))).toBe('source_commit_mismatch');
  });
  it('runtime / portable hash mismatch and wrong pending bytes rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ runtimeMigrationSetHash: 'd'.repeat(64) })))).toBe('migration_set_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ portableMigrationSetHash: 'd'.repeat(64) })))).toBe('migration_set_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ pendingMigrations: [{ migrationIndex: 54, migrationTag: '0054_example', migrationPath: 'drizzle/0054_example.sql', byteLength: 100, sha256: '1'.repeat(64) }] })))).toBe('pending_migration_mismatch');
  });
  it('malformed nonce rejected by schema', () => {
    const rc = sign(buildSigned());
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from(JSON.stringify({ ...rc, deploymentNonce: 'short' })), exp()))).toBe('schema_invalid');
  });
  it('priorReleaseVersion is optional audit metadata and does not affect trust', () => {
    expect(verifyReceiptV2Parsed(sign(buildSigned({ priorReleaseVersion: 'v123' })), exp()).ok).toBe(true);
    expect(verifyReceiptV2Parsed(sign(buildSigned({ priorReleaseVersion: 'v999' })), exp()).ok).toBe(true);
  });
});

describe('G-Backup-B1 receipt-v2 verifier — production policy', () => {
  it('production environment is rejected even when everything else matches (step 18)', () => {
    const r = verifyReceiptV2Parsed(sign(buildSigned({ environment: 'production' })), exp({ environment: 'production' }));
    expect(codeOf(r)).toBe('production_rejected');
  });
});
