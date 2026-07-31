import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type LegacyEvidenceManifest, type SignedLegacyAttestation } from '../../scripts/backup/legacy-attestation-schema';
import { computeEvidenceManifestHash } from '../../scripts/backup/legacy-attestation-canonical';
import { signLegacyAttestation } from '../../scripts/backup/legacy-attestation-sign';
import { type AttestationExpectation, type LegacyTrustStore, validateAttestationBundle, verifyLegacyAttestation } from '../../scripts/backup/legacy-attestation-verify';

const kp = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const SRC = 'a'.repeat(64);
const APP = 'b'.repeat(64);
const EMH = 'c'.repeat(64);

function mkSigned(over: Partial<SignedLegacyAttestation> = {}): SignedLegacyAttestation {
  return {
    attestationVersion: '1', attestationId: 'att-0004',
    repositoryId: 'king-ai-ops-hub', applicationId: 'king-ai-ops-hub-staging',
    migrationNamespace: 'drizzle', migrationPath: 'drizzle/0004_knowledge_k1.sql', allowedEnvironments: ['development', 'staging'],
    migrationIndex: 4, migrationTag: '0004_knowledge_k1', journalTimestamp: 1784873208836,
    reviewedSourceCommit: '3a1ed677afaf6616aa5b051f99a4d013ca74a599', reviewedMigrationSetHash: '1'.repeat(64),
    sourceBlobHash: SRC, appliedExecutionHash: APP,
    sourceByteLength: 3805, appliedByteLength: 3806, differenceType: 'eol_only',
    insertedByteCount: 1, deletedByteCount: 0, substitutedByteCount: 0, insertedCrBeforeLfCount: 1, changedLineIndexes: [48],
    eolMapHash: '9'.repeat(64), sqlContextAssessment: 'outside_sensitive_content', databaseEffectAssessment: 'local_staging_agree',
    evidenceManifestHash: EMH, approvedTreatment: 'signed_legacy_execution_attestation',
    approvedAt: '2026-01-01T00:00:00.000Z', approverRole: 'owner', approverId: 'empera-owner', approvingOrganization: 'Empera-International',
    signatureAlgorithm: 'ed25519', keyId: 'owner-key-1', ...over,
  };
}
function mkExp(over: Partial<AttestationExpectation> = {}): AttestationExpectation {
  return {
    repositoryId: 'king-ai-ops-hub', applicationId: 'king-ai-ops-hub-staging', environment: 'staging',
    migrationNamespace: 'drizzle', migrationPath: 'drizzle/0004_knowledge_k1.sql',
    migrationIndex: 4, migrationTag: '0004_knowledge_k1', journalTimestamp: 1784873208836,
    sourceBlobHash: SRC, appliedHash: APP,
    supportedVersions: new Set(['1']), supportedAlgorithms: new Set(['ed25519']), ...over,
  };
}
const store = (over: Partial<LegacyTrustStore> = {}): LegacyTrustStore => ({ keyring: { 'owner-key-1': kp.publicKey }, revoked: new Set(), ...over });

describe('G-Backup-A2 attestation verification (split modules, scoped)', () => {
  it('a valid ephemeral signed attestation verifies', () => {
    expect(verifyLegacyAttestation(signLegacyAttestation(mkSigned(), kp.privateKey), mkExp(), store())).toEqual({ ok: true });
  });

  it('reviewedSourceCommit ≠ deployment commit still verifies (commit-evolution; provenance not a runtime constraint)', () => {
    const a = signLegacyAttestation(mkSigned({ reviewedSourceCommit: 'f'.repeat(40) }), kp.privateKey);
    // exp carries no sourceCommit; runtime binding is only source-blob + identity → still ok.
    expect(verifyLegacyAttestation(a, mkExp(), store())).toEqual({ ok: true });
  });

  it('a changed historical source blob invalidates the attestation (source_mismatch)', () => {
    const a = signLegacyAttestation(mkSigned(), kp.privateKey);
    expect(verifyLegacyAttestation(a, mkExp({ sourceBlobHash: 'd'.repeat(64) }), store())).toMatchObject({ ok: false, reasonCode: 'source_mismatch' });
  });

  it('scope mismatches → scope_mismatch (repo/app/namespace/path/env/index/tag/timestamp)', () => {
    const a = signLegacyAttestation(mkSigned(), kp.privateKey);
    for (const over of [{ repositoryId: 'x' }, { applicationId: 'x' }, { migrationNamespace: 'x' }, { migrationPath: 'drizzle/x.sql' }, { environment: 'production' as const }, { migrationIndex: 5 }, { migrationTag: '0005_x' }, { journalTimestamp: 1 }]) {
      expect(verifyLegacyAttestation(a, mkExp(over), store())).toMatchObject({ ok: false, reasonCode: 'scope_mismatch' });
    }
  });

  it('staging-only attestation is rejected in production; dev+staging accepted only in those envs', () => {
    const a = signLegacyAttestation(mkSigned({ allowedEnvironments: ['development', 'staging'] }), kp.privateKey);
    expect(verifyLegacyAttestation(a, mkExp({ environment: 'production' }), store())).toMatchObject({ ok: false, reasonCode: 'scope_mismatch' });
    expect(verifyLegacyAttestation(a, mkExp({ environment: 'development' }), store())).toEqual({ ok: true });
    expect(verifyLegacyAttestation(a, mkExp({ environment: 'staging' }), store())).toEqual({ ok: true });
  });

  it('applied-hash / evidence-hash mismatches → explicit reason codes', () => {
    expect(verifyLegacyAttestation(signLegacyAttestation(mkSigned(), kp.privateKey), mkExp({ appliedHash: 'e'.repeat(64) }), store())).toMatchObject({ reasonCode: 'applied_hash_mismatch' });
    const em: LegacyEvidenceManifest = {
      manifestVersion: '1', forensicMethodVersion: 'v1', migrationIndex: 4, migrationTag: '0004_knowledge_k1', journalTimestamp: 1784873208836,
      reviewedSourceCommit: '3a1ed677afaf6616aa5b051f99a4d013ca74a599', sourceBlobHash: SRC, appliedExecutionHash: APP,
      sourceByteLength: 3805, appliedByteLength: 3806, lfCount: 47, crlfCount: 1, loneCrCount: 0,
      insertedByteCount: 1, deletedByteCount: 0, substitutedByteCount: 0, insertedCrBeforeLfCount: 1, changedLineIndexes: [48],
      eolMapHash: '9'.repeat(64), sqlContext: { hasStringLiteralSpanningNewline: false, hasDollarQuote: false, hasCopyFromStdin: false, hasProceduralBody: false, changedEolInsideSensitiveContent: false },
      statementCategoryCounts: { create: 8 }, databaseObjectCategoryCounts: { table: 1 }, localStagingComparison: 'agree',
    };
    expect(verifyLegacyAttestation(signLegacyAttestation(mkSigned({ evidenceManifestHash: EMH }), kp.privateKey), mkExp({ evidenceManifest: em }), store())).toMatchObject({ reasonCode: 'evidence_mismatch' });
    const good = signLegacyAttestation(mkSigned({ evidenceManifestHash: computeEvidenceManifestHash(em) }), kp.privateKey);
    expect(verifyLegacyAttestation(good, mkExp({ evidenceManifest: em }), store())).toEqual({ ok: true });
  });

  it('key / signature / algorithm / version failures → explicit reason codes', () => {
    const a = signLegacyAttestation(mkSigned(), kp.privateKey);
    expect(verifyLegacyAttestation({ ...a, approverRole: 'x' }, mkExp(), store())).toMatchObject({ reasonCode: 'invalid_signature' });
    expect(verifyLegacyAttestation(a, mkExp(), store({ keyring: {} }))).toMatchObject({ reasonCode: 'unknown_key' });
    expect(verifyLegacyAttestation(a, mkExp(), store({ revoked: new Set(['owner-key-1']) }))).toMatchObject({ reasonCode: 'revoked_key' });
    expect(verifyLegacyAttestation(a, mkExp(), store({ keyring: { 'owner-key-1': other.publicKey } }))).toMatchObject({ reasonCode: 'invalid_signature' });
    expect(verifyLegacyAttestation(a, mkExp({ supportedAlgorithms: new Set() }), store())).toMatchObject({ reasonCode: 'unsupported_algorithm' });
    expect(verifyLegacyAttestation(a, mkExp({ supportedVersions: new Set() }), store())).toMatchObject({ reasonCode: 'unsupported_version' });
    expect(verifyLegacyAttestation(mkSigned(), mkExp(), store())).toMatchObject({ reasonCode: 'schema_invalid' }); // unsigned
  });

  it('invalid byte claims / unsafe assessments → explicit reason codes', () => {
    for (const bad of [{ deletedByteCount: 1 }, { insertedByteCount: 2 }, { appliedByteLength: 9999 }, { changedLineIndexes: [1, 2] }]) {
      expect(verifyLegacyAttestation(signLegacyAttestation(mkSigned(bad), kp.privateKey), mkExp(), store())).toMatchObject({ reasonCode: 'invalid_byte_claim' });
    }
    expect(verifyLegacyAttestation(signLegacyAttestation(mkSigned({ sqlContextAssessment: 'inside_sensitive_content' }), kp.privateKey), mkExp(), store())).toMatchObject({ reasonCode: 'unsafe_assessment' });
    expect(verifyLegacyAttestation(signLegacyAttestation(mkSigned({ databaseEffectAssessment: 'divergent' }), kp.privateKey), mkExp(), store())).toMatchObject({ reasonCode: 'unsafe_assessment' });
  });

  it('ancestry required but unconfirmed → ancestry_unverifiable', () => {
    const a = signLegacyAttestation(mkSigned(), kp.privateKey);
    expect(verifyLegacyAttestation(a, mkExp({ requireAncestry: true, ancestryConfirmed: false }), store())).toMatchObject({ reasonCode: 'ancestry_unverifiable' });
    expect(verifyLegacyAttestation(a, mkExp({ requireAncestry: true, ancestryConfirmed: true }), store())).toEqual({ ok: true });
  });

  it('one attestation cannot authorize another migration', () => {
    const a = signLegacyAttestation(mkSigned(), kp.privateKey);
    expect(verifyLegacyAttestation(a, mkExp({ migrationIndex: 5, migrationTag: '0005_other', journalTimestamp: 999, migrationPath: 'drizzle/0005_other.sql' }), store()).ok).toBe(false);
  });
});

describe('G-Backup-A2 trusted-bundle validation (duplicate/conflict)', () => {
  it('accepts a clean single-entry bundle', () => {
    expect(validateAttestationBundle([signLegacyAttestation(mkSigned(), kp.privateKey)])).toEqual({ ok: true });
  });
  it('rejects a duplicate attestationId', () => {
    const a = signLegacyAttestation(mkSigned({ attestationId: 'dup' }), kp.privateKey);
    const b = signLegacyAttestation(mkSigned({ attestationId: 'dup', migrationTag: '0005_x', migrationIndex: 5 }), kp.privateKey);
    expect(validateAttestationBundle([a, b])).toMatchObject({ ok: false, reason: expect.stringContaining('duplicate attestationId') });
  });
  it('rejects two attestations for the same repo/app/migration/applied-hash scope', () => {
    const a = signLegacyAttestation(mkSigned({ attestationId: 'a1' }), kp.privateKey);
    const b = signLegacyAttestation(mkSigned({ attestationId: 'a2' }), other.privateKey); // different key, same scope
    expect(validateAttestationBundle([a, b])).toMatchObject({ ok: false, reason: expect.stringContaining('same repository/application/migration/applied-hash') });
  });
  it('rejects a schema-invalid entry in the bundle', () => {
    expect(validateAttestationBundle([mkSigned()])).toMatchObject({ ok: false, reason: expect.stringContaining('schema-invalid') });
  });
});
