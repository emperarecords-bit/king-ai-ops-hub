import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type LegacyEvidenceManifest, type SignedLegacyAttestation } from '../../scripts/backup/legacy-attestation-schema';
import { computeEvidenceManifestHash, finalizeAttestationId } from '../../scripts/backup/legacy-attestation-canonical';
import { signLegacyAttestation } from '../../scripts/backup/legacy-attestation-sign';
import {
  type AttestationExpectation,
  type LegacyTrustStore,
  loadTrustBundle,
  validateAttestationBundle,
  verifyLegacyAttestation,
} from '../../scripts/backup/legacy-attestation-verify';

const kp = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const SRC = 'a'.repeat(64);
const APP = 'b'.repeat(64);
const EMH = 'c'.repeat(64);
const NOW = new Date('2026-06-01T00:00:00.000Z');
const pem = (k: typeof kp) => k.publicKey.export({ type: 'spki', format: 'pem' }).toString();
function storeOf(entries: unknown[]): LegacyTrustStore {
  const r = loadTrustBundle(entries);
  if (!r.ok) throw new Error(`trust load failed: ${r.reason}`);
  return r.store;
}
const trustEntry = (over: Record<string, unknown> = {}) => ({ keyId: 'owner-key-1', algorithm: 'ed25519', publicKeyPem: pem(kp), purpose: 'legacy_migration_attestation', status: 'active', ...over });
const okStore = () => storeOf([trustEntry()]);

function base(over: Partial<SignedLegacyAttestation> = {}): SignedLegacyAttestation {
  return {
    attestationVersion: '1', attestationId: `lma1_${'0'.repeat(64)}`,
    repositoryId: 'emperarecords-bit/king-ai-ops-hub', applicationId: 'king-ai-ops-hub',
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
function att(over: Partial<SignedLegacyAttestation> = {}, key = kp.privateKey) {
  return signLegacyAttestation(finalizeAttestationId(base(over)), key);
}
function mkExp(over: Partial<AttestationExpectation> = {}): AttestationExpectation {
  return {
    repositoryId: 'emperarecords-bit/king-ai-ops-hub', applicationId: 'king-ai-ops-hub', environment: 'staging',
    migrationNamespace: 'drizzle', migrationPath: 'drizzle/0004_knowledge_k1.sql',
    migrationIndex: 4, migrationTag: '0004_knowledge_k1', journalTimestamp: 1784873208836,
    sourceBlobHash: SRC, appliedHash: APP, supportedVersions: new Set(['1']), supportedAlgorithms: new Set(['ed25519']),
    verificationTime: NOW, ...over,
  };
}

describe('G-Backup-A2 trust-bundle loader', () => {
  it('loads a clean active key', () => {
    expect(loadTrustBundle([trustEntry()]).ok).toBe(true);
  });
  it('rejects duplicate key id', () => {
    expect(loadTrustBundle([trustEntry(), trustEntry()])).toMatchObject({ ok: false, reason: expect.stringContaining('duplicate keyId') });
  });
  it('rejects same key id with different public-key material', () => {
    expect(loadTrustBundle([trustEntry(), trustEntry({ publicKeyPem: pem(other) })])).toMatchObject({ ok: false, reason: expect.stringContaining('different public-key material') });
  });
  it('rejects a key that is both active and revoked', () => {
    expect(loadTrustBundle([trustEntry({ status: 'active' }), trustEntry({ status: 'revoked' })])).toMatchObject({ ok: false });
  });
  it('rejects wrong purpose / unsupported algorithm / malformed key', () => {
    expect(loadTrustBundle([trustEntry({ purpose: 'deployment_receipt' })]).ok).toBe(false); // schema literal
    expect(loadTrustBundle([trustEntry({ algorithm: 'rsa' })]).ok).toBe(false); // schema enum
    expect(loadTrustBundle([trustEntry({ publicKeyPem: 'not-a-key' })])).toMatchObject({ ok: false, reason: expect.stringContaining('malformed') });
  });
});

describe('G-Backup-A2 attestation verification', () => {
  it('a valid attestation verifies from the current trusted source entry (no .git / no ancestry input)', () => {
    expect(verifyLegacyAttestation(att(), mkExp(), okStore())).toEqual({ ok: true });
  });
  it('reviewedSourceCommit ≠ deployment still verifies (provenance only)', () => {
    expect(verifyLegacyAttestation(att({ reviewedSourceCommit: 'f'.repeat(40) }), mkExp(), okStore())).toEqual({ ok: true });
  });
  it('a changed historical source blob → source_mismatch', () => {
    expect(verifyLegacyAttestation(att(), mkExp({ sourceBlobHash: 'd'.repeat(64) }), okStore())).toMatchObject({ reasonCode: 'source_mismatch' });
  });
  it('derived id: a tampered signed field → invalid_attestation_id (recomputed id no longer matches)', () => {
    const a = att();
    expect(verifyLegacyAttestation({ ...a, approverRole: 'attacker' }, mkExp(), okStore())).toMatchObject({ reasonCode: 'invalid_attestation_id' });
  });
  it('a wrong attestationId → invalid_attestation_id', () => {
    const a = att();
    expect(verifyLegacyAttestation({ ...a, attestationId: `lma1_${'e'.repeat(64)}` }, mkExp(), okStore())).toMatchObject({ reasonCode: 'invalid_attestation_id' });
  });
  it('scope mismatches (repo/app/namespace/path/env/index/tag/timestamp) → scope_mismatch', () => {
    const a = att();
    for (const over of [{ repositoryId: 'emperarecords-bit/other' as const }, { applicationId: 'x' }, { migrationNamespace: 'x' }, { migrationPath: 'drizzle/x.sql' }, { environment: 'production' as const }, { migrationIndex: 5 }, { migrationTag: '0005_x' }, { journalTimestamp: 1 }]) {
      expect(verifyLegacyAttestation(a, mkExp(over), okStore())).toMatchObject({ reasonCode: 'scope_mismatch' });
    }
  });
  it('exact scope only: a repo URL, wrong capitalization, or the Fly staging app name are rejected', () => {
    // repo URL → schema (RepoId regex rejects ":" and "://")
    expect(verifyLegacyAttestation(att({ repositoryId: 'https://github.com/emperarecords-bit/king-ai-ops-hub' as never }), mkExp(), okStore())).toMatchObject({ reasonCode: 'schema_invalid' });
    // wrong capitalization → scope mismatch
    expect(verifyLegacyAttestation(att(), mkExp({ repositoryId: 'emperarecords-bit/King-AI-Ops-Hub' }), okStore())).toMatchObject({ reasonCode: 'scope_mismatch' });
    // Fly staging app name used as the logical app id → mismatch
    expect(verifyLegacyAttestation(att({ applicationId: 'king-ai-ops-hub-staging' }), mkExp(), okStore())).toMatchObject({ reasonCode: 'scope_mismatch' });
  });
  it('staging-only rejected in production; dev+staging accepted only in those envs', () => {
    const a = att({ allowedEnvironments: ['development', 'staging'] });
    expect(verifyLegacyAttestation(a, mkExp({ environment: 'production' }), okStore())).toMatchObject({ reasonCode: 'scope_mismatch' });
    expect(verifyLegacyAttestation(a, mkExp({ environment: 'development' }), okStore())).toEqual({ ok: true });
    expect(verifyLegacyAttestation(a, mkExp({ environment: 'staging' }), okStore())).toEqual({ ok: true });
  });
  it('applied-hash / evidence-hash mismatch → explicit reasons', () => {
    expect(verifyLegacyAttestation(att(), mkExp({ appliedHash: 'e'.repeat(64) }), okStore())).toMatchObject({ reasonCode: 'applied_hash_mismatch' });
    const em: LegacyEvidenceManifest = {
      manifestVersion: '1', forensicMethodVersion: 'v1', migrationIndex: 4, migrationTag: '0004_knowledge_k1', journalTimestamp: 1784873208836,
      reviewedSourceCommit: '3a1ed677afaf6616aa5b051f99a4d013ca74a599', sourceBlobHash: SRC, appliedExecutionHash: APP,
      sourceByteLength: 3805, appliedByteLength: 3806, lfCount: 47, crlfCount: 1, loneCrCount: 0,
      insertedByteCount: 1, deletedByteCount: 0, substitutedByteCount: 0, insertedCrBeforeLfCount: 1, changedLineIndexes: [48],
      eolMapHash: '9'.repeat(64), sqlContext: { hasStringLiteralSpanningNewline: false, hasDollarQuote: false, hasCopyFromStdin: false, hasProceduralBody: false, changedEolInsideSensitiveContent: false },
      statementCategoryCounts: { create: 8 }, databaseObjectCategoryCounts: { table: 1 }, localStagingComparison: 'agree',
    };
    expect(verifyLegacyAttestation(att({ evidenceManifestHash: EMH }), mkExp({ evidenceManifest: em }), okStore())).toMatchObject({ reasonCode: 'evidence_mismatch' });
    expect(verifyLegacyAttestation(att({ evidenceManifestHash: computeEvidenceManifestHash(em) }), mkExp({ evidenceManifest: em }), okStore())).toEqual({ ok: true });
  });
  it('unknown / revoked / wrong key → explicit reasons', () => {
    expect(verifyLegacyAttestation(att(), mkExp(), storeOf([]))).toMatchObject({ reasonCode: 'unknown_key' });
    expect(verifyLegacyAttestation(att(), mkExp(), storeOf([trustEntry({ status: 'revoked' })]))).toMatchObject({ reasonCode: 'revoked_key' });
    expect(verifyLegacyAttestation(att(), mkExp(), storeOf([trustEntry({ publicKeyPem: pem(other) })]))).toMatchObject({ reasonCode: 'invalid_signature' });
  });
  it('approval-time: future beyond skew / before notBefore / after notAfter / non-UTC → rejected', () => {
    expect(verifyLegacyAttestation(att({ approvedAt: '2027-01-01T00:00:00.000Z' }), mkExp(), okStore())).toMatchObject({ reasonCode: 'approval_time_invalid' });
    const store = storeOf([trustEntry({ notBefore: '2026-03-01T00:00:00.000Z' })]);
    expect(verifyLegacyAttestation(att({ approvedAt: '2026-01-01T00:00:00.000Z' }), mkExp(), store)).toMatchObject({ reasonCode: 'approval_time_invalid' });
    const store2 = storeOf([trustEntry({ notAfter: '2025-12-01T00:00:00.000Z' })]);
    expect(verifyLegacyAttestation(att({ approvedAt: '2026-01-01T00:00:00.000Z' }), mkExp(), store2)).toMatchObject({ reasonCode: 'approval_time_invalid' });
    // non-UTC approvedAt → schema
    expect(verifyLegacyAttestation(att({ approvedAt: '2026-01-01T00:00:00+02:00' }), mkExp(), okStore())).toMatchObject({ reasonCode: 'schema_invalid' });
  });
  it('invalid byte-claims / unsafe assessments → explicit reasons', () => {
    for (const bad of [{ deletedByteCount: 1 }, { insertedByteCount: 2 }, { appliedByteLength: 9999 }, { changedLineIndexes: [1, 2] }]) {
      expect(verifyLegacyAttestation(att(bad), mkExp(), okStore())).toMatchObject({ reasonCode: 'invalid_byte_claim' });
    }
    expect(verifyLegacyAttestation(att({ sqlContextAssessment: 'inside_sensitive_content' }), mkExp(), okStore())).toMatchObject({ reasonCode: 'unsafe_assessment' });
    expect(verifyLegacyAttestation(att({ databaseEffectAssessment: 'divergent' }), mkExp(), okStore())).toMatchObject({ reasonCode: 'unsafe_assessment' });
  });
});

describe('G-Backup-A2 bundle validation (identity + environment conflicts)', () => {
  it('accepts a clean single bundle', () => {
    expect(validateAttestationBundle([att()])).toEqual({ ok: true });
  });
  it('rejects a forged (non-derived) attestationId', () => {
    const a = { ...att(), attestationId: `lma1_${'a'.repeat(64)}` };
    expect(validateAttestationBundle([a])).toMatchObject({ ok: false, reason: expect.stringContaining('content digest') });
  });
  it('[development,staging] + [staging] → conflict; different keys/timestamps do not resolve it', () => {
    const a = att({ allowedEnvironments: ['development', 'staging'] });
    const b = att({ allowedEnvironments: ['staging'], approvedAt: '2026-02-02T00:00:00.000Z' }, other.privateKey);
    expect(validateAttestationBundle([a, b])).toMatchObject({ ok: false, reason: expect.stringContaining('environment') });
  });
  it('two staging attestations for the same migration → conflict', () => {
    const a = att({ allowedEnvironments: ['staging'] });
    const b = att({ allowedEnvironments: ['staging'], approverId: 'other-owner' });
    expect(validateAttestationBundle([a, b]).ok).toBe(false);
  });
  it('development-only + staging-only (otherwise identical) → accepted (disjoint)', () => {
    const a = att({ allowedEnvironments: ['development'] });
    const b = att({ allowedEnvironments: ['staging'] });
    expect(validateAttestationBundle([a, b])).toEqual({ ok: true });
  });
  it('two production attestations for the same applied migration → conflict', () => {
    const a = att({ allowedEnvironments: ['production'] });
    const b = att({ allowedEnvironments: ['production'], approverId: 'x' });
    expect(validateAttestationBundle([a, b]).ok).toBe(false);
  });
  it('a different migration path/index is not interchangeable (no conflict)', () => {
    const a = att({ allowedEnvironments: ['staging'] });
    const b = att({ allowedEnvironments: ['staging'], migrationIndex: 5, migrationTag: '0005_x', migrationPath: 'drizzle/0005_x.sql', journalTimestamp: 9 });
    expect(validateAttestationBundle([a, b])).toEqual({ ok: true });
  });
});
