import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AttestationExpectation,
  type LegacyTrustStore,
  type SignedLegacyAttestation,
  computeEvidenceManifestHash,
  signLegacyAttestation,
  verifyLegacyAttestation,
} from '../../scripts/backup/legacy-attestation';

const kp = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const SRC = 'a'.repeat(64);
const APP = 'b'.repeat(64);
const EMH = 'c'.repeat(64);

function mkSigned(over: Partial<SignedLegacyAttestation> = {}): SignedLegacyAttestation {
  return {
    attestationVersion: '1',
    attestationId: 'att-0004',
    migrationIndex: 4,
    migrationTag: '0004_knowledge_k1',
    journalTimestamp: 1784873208836,
    sourceCommit: '3a1ed677afaf6616aa5b051f99a4d013ca74a599',
    sourceBlobHash: SRC,
    appliedExecutionHash: APP,
    sourceByteLength: 3805,
    appliedByteLength: 3806,
    differenceType: 'eol_only',
    insertedByteCount: 1,
    deletedByteCount: 0,
    substitutedByteCount: 0,
    insertedCrBeforeLfCount: 1,
    changedLineIndexes: [48],
    eolMapHash: '9'.repeat(64),
    sqlContextAssessment: 'outside_sensitive_content',
    databaseEffectAssessment: 'local_staging_agree',
    evidenceManifestHash: EMH,
    approvedTreatment: 'signed_legacy_execution_attestation',
    approvedAt: '2026-01-01T00:00:00.000Z',
    approverRole: 'owner',
    signatureAlgorithm: 'ed25519',
    keyId: 'owner-key-1',
    ...over,
  };
}
function mkExp(over: Partial<AttestationExpectation> = {}): AttestationExpectation {
  return {
    migrationIndex: 4,
    migrationTag: '0004_knowledge_k1',
    journalTimestamp: 1784873208836,
    sourceCommit: '3a1ed677afaf6616aa5b051f99a4d013ca74a599',
    sourceBlobHash: SRC,
    appliedHash: APP,
    supportedVersions: new Set(['1']),
    supportedAlgorithms: new Set(['ed25519']),
    ...over,
  };
}
const store = (over: Partial<LegacyTrustStore> = {}): LegacyTrustStore => ({ keyring: { 'owner-key-1': kp.publicKey }, revoked: new Set(), ...over });

describe('G-Backup-A2 legacy attestation verification', () => {
  it('a valid ephemeral signed attestation verifies', () => {
    const a = signLegacyAttestation(mkSigned(), kp.privateKey);
    expect(verifyLegacyAttestation(a, mkExp(), store())).toEqual({ ok: true });
  });

  it('unsigned draft (no signature field) is rejected', () => {
    expect(verifyLegacyAttestation(mkSigned(), mkExp(), store())).toMatchObject({ ok: false, reason: expect.stringContaining('schema') });
  });

  it('modified signed field → invalid signature', () => {
    const a = { ...signLegacyAttestation(mkSigned(), kp.privateKey), approverRole: 'attacker' };
    expect(verifyLegacyAttestation(a, mkExp(), store())).toMatchObject({ reason: 'invalid signature' });
  });

  it('scope mismatches are rejected (index/tag/timestamp/commit/sourceHash/appliedHash)', () => {
    const a = signLegacyAttestation(mkSigned(), kp.privateKey);
    expect(verifyLegacyAttestation(a, mkExp({ migrationIndex: 5 }), store())).toMatchObject({ reason: 'migrationIndex mismatch' });
    expect(verifyLegacyAttestation(a, mkExp({ migrationTag: '0005_x' }), store())).toMatchObject({ reason: 'migrationTag mismatch' });
    expect(verifyLegacyAttestation(a, mkExp({ journalTimestamp: 1 }), store())).toMatchObject({ reason: 'journalTimestamp mismatch' });
    expect(verifyLegacyAttestation(a, mkExp({ sourceCommit: 'f'.repeat(40) }), store())).toMatchObject({ reason: 'sourceCommit mismatch' });
    expect(verifyLegacyAttestation(a, mkExp({ sourceBlobHash: 'd'.repeat(64) }), store())).toMatchObject({ reason: 'sourceBlobHash mismatch' });
    expect(verifyLegacyAttestation(a, mkExp({ appliedHash: 'e'.repeat(64) }), store())).toMatchObject({ reason: 'appliedHash mismatch' });
  });

  it('evidence-manifest hash mismatch (manifest modified after signing) → rejected', () => {
    const a = signLegacyAttestation(mkSigned({ evidenceManifestHash: EMH }), kp.privateKey);
    const evidenceManifest = {
      manifestVersion: '1' as const, forensicMethodVersion: 'v1', migrationIndex: 4, migrationTag: '0004_knowledge_k1', journalTimestamp: 1784873208836,
      sourceCommit: '3a1ed677afaf6616aa5b051f99a4d013ca74a599', sourceBlobHash: SRC, appliedExecutionHash: APP,
      sourceByteLength: 3805, appliedByteLength: 3806, lfCount: 47, crlfCount: 1, loneCrCount: 0,
      insertedByteCount: 1, deletedByteCount: 0, substitutedByteCount: 0, insertedCrBeforeLfCount: 1, changedLineIndexes: [48],
      eolMapHash: '9'.repeat(64), sqlContext: { hasStringLiteralSpanningNewline: false, hasDollarQuote: false, hasCopyFromStdin: false, hasProceduralBody: false, changedEolInsideSensitiveContent: false },
      statementCategoryCounts: { create: 8 }, databaseObjectCategoryCounts: { table: 1 }, localStagingComparison: 'agree' as const,
    };
    // The attestation's EMH ('c'*64) does not equal the real manifest hash → rejected.
    expect(verifyLegacyAttestation(a, mkExp({ evidenceManifest }), store())).toMatchObject({ reason: expect.stringContaining('evidenceManifestHash') });
    // Whereas an attestation carrying the CORRECT manifest hash verifies.
    const good = signLegacyAttestation(mkSigned({ evidenceManifestHash: computeEvidenceManifestHash(evidenceManifest) }), kp.privateKey);
    expect(verifyLegacyAttestation(good, mkExp({ evidenceManifest }), store())).toEqual({ ok: true });
  });

  it('unknown key / revoked key / wrong key / unsupported algorithm|version → rejected', () => {
    const a = signLegacyAttestation(mkSigned(), kp.privateKey);
    expect(verifyLegacyAttestation(a, mkExp(), store({ keyring: {} }))).toMatchObject({ reason: expect.stringContaining('unknown keyId') });
    expect(verifyLegacyAttestation(a, mkExp(), store({ revoked: new Set(['owner-key-1']) }))).toMatchObject({ reason: expect.stringContaining('revoked') });
    expect(verifyLegacyAttestation(a, mkExp(), store({ keyring: { 'owner-key-1': other.publicKey } }))).toMatchObject({ reason: 'invalid signature' });
    expect(verifyLegacyAttestation(a, mkExp({ supportedAlgorithms: new Set() }), store())).toMatchObject({ reason: expect.stringContaining('unsupported signatureAlgorithm') });
    expect(verifyLegacyAttestation(a, mkExp({ supportedVersions: new Set() }), store())).toMatchObject({ reason: expect.stringContaining('unsupported attestationVersion') });
  });

  it('invalid byte-difference claims are rejected', () => {
    for (const bad of [{ deletedByteCount: 1 }, { substitutedByteCount: 1 }, { insertedByteCount: 2 }, { appliedByteLength: 9999 }, { changedLineIndexes: [1, 2] }]) {
      const a = signLegacyAttestation(mkSigned(bad), kp.privateKey);
      expect(verifyLegacyAttestation(a, mkExp(), store()).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('unsafe SQL-context or divergent db-effect assessment → rejected (safety gates)', () => {
    expect(verifyLegacyAttestation(signLegacyAttestation(mkSigned({ sqlContextAssessment: 'inside_sensitive_content' }), kp.privateKey), mkExp(), store())).toMatchObject({ reason: expect.stringContaining('sqlContextAssessment') });
    expect(verifyLegacyAttestation(signLegacyAttestation(mkSigned({ databaseEffectAssessment: 'divergent' }), kp.privateKey), mkExp(), store())).toMatchObject({ reason: expect.stringContaining('databaseEffectAssessment') });
  });

  it('an attestation for one migration cannot authorize another (no wildcard/prefix)', () => {
    // Signed for 0004 but evaluated against a 0005 expectation → rejected on scope.
    const a = signLegacyAttestation(mkSigned(), kp.privateKey);
    expect(verifyLegacyAttestation(a, mkExp({ migrationIndex: 5, migrationTag: '0005_other', journalTimestamp: 999 }), store()).ok).toBe(false);
  });
});
