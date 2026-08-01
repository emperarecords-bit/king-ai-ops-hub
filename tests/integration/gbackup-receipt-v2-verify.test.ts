import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type SignedReceiptV2 } from '../../scripts/backup/receipt-v2-schema';
import { finalizeReceiptV2Id } from '../../scripts/backup/receipt-v2-canonical';
import { signReceiptV2 } from '../../scripts/backup/receipt-v2-sign';
import { type NormalizedProviderEvidence, computeNormalizedProviderEvidenceDigest } from '../../scripts/backup/provider-fly-volumes';
import { type ReceiptV2Expectation, verifyReceiptV2Bytes, verifyReceiptV2Parsed } from '../../scripts/backup/receipt-v2-verify';
import { loadReceiptKeyBundle } from '../../scripts/backup/receipt-key-bundle';

const kp = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const PEM = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const NONCE = 'deadbeefdeadbeefdeadbeefdeadbeef';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const DBID = '7300338420798239475';
const REF = 'registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC';

const store = () => { const l = loadReceiptKeyBundle([{ keyId: 'test-dbr-001', algorithm: 'ed25519', publicKeyPem: PEM, purpose: 'deployment_backup_receipt', status: 'active' }]); if (!l.ok) throw new Error(l.reason); return l.store; };

function evidenceObj(over: Partial<NormalizedProviderEvidence> = {}): { e: NormalizedProviderEvidence; digest: string } {
  const e: NormalizedProviderEvidence = {
    snapshotProvider: 'fly-volumes', providerAdapterVersion: 'fly-volumes.v1', snapshotDiscoveryMethod: 'create-response-id',
    snapshotId: 'vs_abc123', sourceVolumeId: 'vol_4m3kmknl059qpd6v', databaseApp: 'king-ai-hub-db-staging',
    providerSnapshotStatus: 'created', canonicalSnapshotStatus: 'complete',
    snapshotRequestedAt: '2026-08-01T11:49:58.000Z', snapshotCreatedAt: '2026-08-01T11:50:00.000Z', providerObservedAt: '2026-08-01T11:50:05.000Z',
    retentionDays: 7, storedSizeBytes: 130000000, ...over,
  };
  return { e, digest: computeNormalizedProviderEvidenceDigest(e) };
}

function buildSigned(over: Partial<SignedReceiptV2> = {}, evOver: Partial<NormalizedProviderEvidence> = {}, breakDigest = false): SignedReceiptV2 {
  const { e, digest } = evidenceObj(evOver);
  return finalizeReceiptV2Id({
    schemaVersion: '2', canonicalizationVersion: 1, receiptId: `rcpt2_${'0'.repeat(64)}`,
    environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: e.databaseApp,
    sourceVolumeId: e.sourceVolumeId, databaseSystemIdentifier: DBID,
    snapshotProvider: 'fly-volumes', providerSnapshotStatus: e.providerSnapshotStatus, canonicalSnapshotStatus: 'complete', snapshotDiscoveryMethod: e.snapshotDiscoveryMethod as 'create-response-id',
    snapshotId: e.snapshotId, snapshotRequestedAt: e.snapshotRequestedAt, snapshotCreatedAt: e.snapshotCreatedAt, providerObservedAt: e.providerObservedAt,
    retentionDays: e.retentionDays, storedSizeBytes: e.storedSizeBytes, normalizedProviderEvidenceDigest: breakDigest ? 'f'.repeat(64) : digest, providerAdapterVersion: e.providerAdapterVersion,
    sourceCommit: 'd2805ffab69bb83926a50d0422d65823b521138f', targetImageRef: REF, targetImageDigest: DIGEST, deploymentNonce: NONCE,
    portableMigrationSetHash: 'b'.repeat(64), runtimeMigrationSetHash: 'c'.repeat(64),
    pendingMigrations: [{ migrationIndex: 54, migrationTag: '0054_example', migrationPath: 'drizzle/0054_example.sql', byteLength: 100, sha256: 'e'.repeat(64) }],
    receiptCreatedAt: '2026-08-01T11:50:06.000Z', expiresAt: '2026-08-01T12:20:06.000Z', signatureAlgorithm: 'ed25519', keyId: 'test-dbr-001', ...over,
  });
}
const sign = (s: SignedReceiptV2) => signReceiptV2(s, kp.privateKey);

function exp(over: Partial<ReceiptV2Expectation> = {}): ReceiptV2Expectation {
  return {
    environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: 'king-ai-hub-db-staging',
    sourceVolumeId: 'vol_4m3kmknl059qpd6v', databaseSystemIdentifier: DBID, snapshotProvider: 'fly-volumes', providerAdapterVersion: 'fly-volumes.v1',
    minRetentionDays: 7, maxSnapshotAgeMs: 30 * 60 * 1000, sourceCommit: 'd2805ffab69bb83926a50d0422d65823b521138f', targetImageRef: REF,
    deploymentNonce: NONCE, portableMigrationSetHash: 'b'.repeat(64), runtimeMigrationSetHash: 'c'.repeat(64),
    pendingMigrations: [{ migrationIndex: 54, migrationTag: '0054_example', migrationPath: 'drizzle/0054_example.sql', byteLength: 100, sha256: 'e'.repeat(64) }],
    verificationTime: new Date('2026-08-01T11:50:10.000Z'), migrationStartedAt: new Date('2026-08-01T11:50:20.000Z'),
    supportedSchemaVersions: new Set(['2']), supportedAlgorithms: new Set(['ed25519']), keyStore: store(), ...over,
  };
}
const codeOf = (r: ReturnType<typeof verifyReceiptV2Parsed>) => (r.ok ? 'OK' : r.code);

describe('B1 receipt-v2 verifier — happy path, signature, key policy', () => {
  it('valid receipt verifies; image-trust diagnostics are honest', () => {
    const r = verifyReceiptV2Parsed(sign(buildSigned()), exp());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.imageTrust.image_ref_verified_runtime).toBe(true);
      expect(r.imageTrust.image_digest_verified_controller).toBe(false);
      expect(r.imageTrust.image_digest_signed_but_not_runtime_observable).toBe(true);
    }
  });
  it('tamper / wrong key / unknown key / revoked / not-yet-valid / expired-key fail', () => {
    const rc = sign(buildSigned());
    expect(codeOf(verifyReceiptV2Parsed({ ...rc, signature: rc.signature.slice(0, 10) + (rc.signature[10] === 'A' ? 'B' : 'A') + rc.signature.slice(11) }, exp()))).toBe('invalid_signature');
    const wrong = loadReceiptKeyBundle([{ keyId: 'test-dbr-001', algorithm: 'ed25519', publicKeyPem: other.publicKey.export({ type: 'spki', format: 'pem' }).toString(), purpose: 'deployment_backup_receipt', status: 'active' }]);
    expect(codeOf(verifyReceiptV2Parsed(rc, exp({ keyStore: wrong.ok ? wrong.store : store() })))).toBe('invalid_signature');
    expect(codeOf(verifyReceiptV2Parsed(rc, exp({ keyStore: { keyring: new Map(), revoked: new Set() } })))).toBe('unknown_key');
    expect(codeOf(verifyReceiptV2Parsed(rc, exp({ keyStore: { keyring: new Map(), revoked: new Set(['test-dbr-001']) } })))).toBe('key_policy');
    const nb = loadReceiptKeyBundle([{ keyId: 'test-dbr-001', algorithm: 'ed25519', publicKeyPem: PEM, purpose: 'deployment_backup_receipt', status: 'active', notBefore: '2026-08-02T00:00:00.000Z' }]);
    expect(codeOf(verifyReceiptV2Parsed(rc, exp({ keyStore: nb.ok ? nb.store : store() })))).toBe('key_policy');
    const na = loadReceiptKeyBundle([{ keyId: 'test-dbr-001', algorithm: 'ed25519', publicKeyPem: PEM, purpose: 'deployment_backup_receipt', status: 'active', notAfter: '2026-07-01T00:00:00.000Z' }]);
    expect(codeOf(verifyReceiptV2Parsed(rc, exp({ keyStore: na.ok ? na.store : store() })))).toBe('key_policy');
  });
  it('changing a signed field (image digest) after signing invalidates the receipt', () => {
    const rc = sign(buildSigned());
    expect(verifyReceiptV2Parsed({ ...rc, targetImageDigest: `sha256:${'9'.repeat(64)}` }, exp()).ok).toBe(false);
  });
  it('schema/json/version boundaries', () => {
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from(JSON.stringify({ ...sign(buildSigned()), schemaVersion: '3' })), exp()))).toBe('schema_invalid');
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from('{"a":1,"a":2}'), exp()))).toBe('json_invalid');
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0x7d]), exp()))).toBe('json_invalid');
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from('{"n":9007199254740993}'), exp()))).toBe('json_invalid');
  });
});

describe('B1 receipt-v2 verifier — canonical encodings via schema', () => {
  it('offset / missing-ms timestamps, noncanonical nonce/signature/dbid rejected at schema', () => {
    const rc = sign(buildSigned());
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from(JSON.stringify({ ...rc, receiptCreatedAt: '2026-08-01T11:50:06Z' })), exp()))).toBe('schema_invalid');
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from(JSON.stringify({ ...rc, deploymentNonce: 'AAAAAAAAAAAAAAAAAAAAAB' })), exp()))).toBe('schema_invalid');
    // A canonical 64-byte base64url ends in one of A/Q/g/w (padding bits 0); +1 sets a padding bit → same bytes,
    // non-canonical spelling → rejected by the schema's canonical-signature refine.
    const sigAlias = rc.signature.slice(0, -1) + ({ A: 'B', Q: 'R', g: 'h', w: 'x' } as Record<string, string>)[rc.signature.slice(-1)]!;
    expect(Buffer.from(sigAlias, 'base64url').equals(Buffer.from(rc.signature, 'base64url'))).toBe(true); // same bytes
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from(JSON.stringify({ ...rc, signature: sigAlias })), exp()))).toBe('schema_invalid');
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from(JSON.stringify({ ...rc, databaseSystemIdentifier: '0123' })), exp()))).toBe('schema_invalid');
    expect(codeOf(verifyReceiptV2Bytes(Buffer.from(JSON.stringify({ ...rc, databaseSystemIdentifier: '18446744073709551616' })), exp()))).toBe('schema_invalid');
  });
});

describe('B1 receipt-v2 verifier — provider evidence + identity', () => {
  it('retention<7 / adapter mismatch / digest mismatch rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({}, { retentionDays: 5 })), exp()))).toBe('provider_evidence_invalid');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({}, { providerAdapterVersion: 'fly-volumes.v2' })), exp()))).toBe('provider_evidence_invalid');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({}, {}, true)), exp()))).toBe('provider_evidence_invalid');
  });
  it('wrong volume / db app / system id rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ sourceVolumeId: 'vol_other' })))).toBe('db_identity_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ databaseApp: 'other-db' })))).toBe('db_identity_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ databaseSystemIdentifier: '1' })))).toBe('db_identity_mismatch');
  });
  it('nonce / image-ref / source-commit / migration-hash / pending mismatches rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ deploymentNonce: 'cafebabecafebabecafebabecafebabe' })))).toBe('nonce_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ targetImageRef: `${REF}-x` })))).toBe('image_ref_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ sourceCommit: 'f'.repeat(40) })))).toBe('source_commit_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ runtimeMigrationSetHash: 'd'.repeat(64) })))).toBe('migration_set_mismatch');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ pendingMigrations: [{ migrationIndex: 54, migrationTag: '0054_example', migrationPath: 'drizzle/0054_example.sql', byteLength: 100, sha256: '1'.repeat(64) }] })))).toBe('pending_migration_mismatch');
  });
});

describe('B1 receipt-v2 verifier — timeline', () => {
  it('request-after-create / create-after-observe / observe-after-receipt rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({}, { snapshotRequestedAt: '2026-08-01T11:50:01.000Z' })), exp()))).toBe('snapshot_time_invalid');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({}, { snapshotCreatedAt: '2026-08-01T11:50:06.000Z', providerObservedAt: '2026-08-01T11:50:05.000Z' })), exp()))).toBe('snapshot_time_invalid');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({}, { providerObservedAt: '2026-08-01T11:50:07.000Z' })), exp()))).toBe('snapshot_time_invalid');
  });
  it('receipt-after-migration-start / snapshot-too-old / snapshot-after-migration rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({ receiptCreatedAt: '2026-08-01T11:50:25.000Z' })), exp()))).toBe('snapshot_time_invalid');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ migrationStartedAt: new Date('2026-08-01T12:40:00.000Z') })))).toBe('snapshot_time_invalid');
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ migrationStartedAt: new Date('2026-08-01T11:49:00.000Z') })))).toBe('snapshot_time_invalid');
  });
  it('expired receipt rejected', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned()), exp({ verificationTime: new Date('2026-08-01T13:00:00.000Z') })))).toBe('receipt_expired');
  });
});

describe('B1 receipt-v2 verifier — production policy', () => {
  it('production rejected at step 18 even when everything else matches', () => {
    expect(codeOf(verifyReceiptV2Parsed(sign(buildSigned({ environment: 'production' })), exp({ environment: 'production' })))).toBe('production_rejected');
  });
});
