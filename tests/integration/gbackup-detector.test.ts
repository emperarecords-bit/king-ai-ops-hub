import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPECTED_DRIZZLE_VERSION, computeExpectedMigrations, installedDrizzleVersion } from '../../scripts/backup/migration-hash';
import { buildSourceManifestFromGit } from '../../scripts/backup/source-manifest';
import { classifyMigrationState, detectMigrationState } from '../../scripts/backup/migration-detector';

const URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
const sql = postgres(URL, { max: 2, prepare: false });

let dbAvailable = false;
try {
  await sql`select 1 as ok`;
  await sql`select 1 from drizzle.__drizzle_migrations limit 1`;
  dbAvailable = true;
} catch (err) {
  console.warn(`[gbackup-detector.test] DB checks SKIPPED — not reachable/migrated: ${err instanceof Error ? err.message : err}`);
}

afterAll(async () => { await sql.end(); });

describe('G-Backup-A hash mirror — drizzle equivalence + portable source manifest', () => {
  it('drizzleExecutionHash mirror reproduces drizzle readMigrationFiles byte-for-byte', () => {
    expect(installedDrizzleVersion()).toBe(EXPECTED_DRIZZLE_VERSION);
    const dz = readMigrationFiles({ migrationsFolder: 'drizzle' }) as Array<{ hash: string }>;
    const mine = computeExpectedMigrations('drizzle');
    expect(mine.length).toBe(dz.length);
    for (let i = 0; i < mine.length; i++) expect(mine[i]!.hash).toBe(dz[i]!.hash);
    const raw = readFileSync('drizzle/0000_illegal_black_knight.sql', 'utf8');
    expect(mine[0]!.hash).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('classifier recognizes CRLF variants of the REAL committed source (staging-shape proof, not hard-coded)', () => {
    // Build the portable source from Git, then simulate an applied history where two migrations were applied
    // from CRLF bytes (their recognized variant) — exactly staging's shape. The classifier must return
    // NO_PENDING with 2 recognized variants and 0 unknown mismatches, derived (not hard-coded).
    const manifest = buildSourceManifestFromGit('HEAD', 'drizzle');
    const variantIdx = new Set([4, 53]);
    const applied = manifest.entries.map((e) => ({
      hash: variantIdx.has(e.idx) && e.recognizedVariantSha256 ? e.recognizedVariantSha256 : e.committedBlobSha256,
      createdAt: e.when,
      id: e.idx + 1,
    }));
    const runtime = manifest.entries.map((e) => ({ when: e.when, tag: e.tag, rawHash: e.committedBlobSha256 }));
    const r = classifyMigrationState({
      source: manifest.entries,
      sourceMigrationSetHash: manifest.sourceMigrationSetHash,
      applied,
      runtime,
      migrationsTableMissing: false,
      declaredBootstrap: false,
      hasUnexplainedUserObjects: false,
      databaseIdentityMatches: true,
    });
    expect(r.state).toBe('NO_PENDING');
    expect(r.lineEndingVariantMatches).toBe(2);
    expect(r.unknownHistoricalMismatches).toBe(0);
    expect(r.unknownDatabaseDivergences).toBe(0);
    expect(r.variantDetails.map((v) => v.idx).sort((a, b) => a - b)).toEqual([4, 53]);
  });
});

describe('G-Backup-A detector — read-only against the real local DB', () => {
  it('classifies the migrated local DB deterministically under the STRICT clean-variant policy', async () => {
    if (!dbAvailable) return;
    const manifest = buildSourceManifestFromGit('HEAD', 'drizzle');
    const a = await detectMigrationState(sql, { sourceManifest: manifest, migrationsFolder: 'drizzle' });
    const b = await detectMigrationState(sql, { sourceManifest: manifest, migrationsFolder: 'drizzle' });
    expect(a.drizzleVersion).toBe(EXPECTED_DRIZZLE_VERSION);
    expect(a.appliedCount).toBe(54);
    expect(a.state).toBe(b.state); // deterministic
    // The local (and staging) dev DBs applied `0004_knowledge_k1` from an IRREGULAR/mixed line-ending form
    // (`c2c7463a…`) that LF-normalizes to the committed content but is NOT the committed blob nor its single
    // deterministic CRLF transform. Under the strict policy that is correctly HISTORICAL_HASH_MISMATCH — NOT a
    // recognized variant. (0053 IS a clean recognized variant.) See the correction report for the decision ask.
    expect(a.state).toBe('HISTORICAL_HASH_MISMATCH');
  });

  it('a VALID ephemeral legacy attestation for 0004 → LEGACY_ATTESTED_MATCH + NO_PENDING (isolated test only)', async () => {
    if (!dbAvailable) return;
    const { generateKeyPairSync } = await import('node:crypto');
    const { signLegacyAttestation } = await import('../../scripts/backup/legacy-attestation-sign');
    const { finalizeAttestationId } = await import('../../scripts/backup/legacy-attestation-canonical');
    const { loadTrustBundle } = await import('../../scripts/backup/legacy-attestation-verify');
    const kp = generateKeyPairSync('ed25519');
    const manifest = buildSourceManifestFromGit('HEAD', 'drizzle');
    const e0004 = manifest.entries.find((e) => e.tag === '0004_knowledge_k1')!;
    const appliedHash = (await sql<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations where created_at = ${e0004.when}`)[0]!.hash;
    const signed = {
      attestationVersion: '1' as const, attestationId: `lma1_${'0'.repeat(64)}`,
      repositoryId: 'emperarecords-bit/king-ai-ops-hub', applicationId: 'king-ai-ops-hub', migrationNamespace: 'drizzle',
      migrationPath: `drizzle/${e0004.tag}.sql`, allowedEnvironments: ['development', 'staging'] as ('development' | 'staging' | 'production')[],
      migrationIndex: e0004.idx, migrationTag: e0004.tag, journalTimestamp: e0004.when,
      reviewedSourceCommit: manifest.sourceCommit, reviewedMigrationSetHash: manifest.sourceMigrationSetHash,
      sourceBlobHash: e0004.committedBlobSha256, appliedExecutionHash: appliedHash,
      sourceByteLength: 3805, appliedByteLength: 3806, differenceType: 'eol_only' as const,
      insertedByteCount: 1, deletedByteCount: 0, substitutedByteCount: 0, insertedCrBeforeLfCount: 1, changedLineIndexes: [48],
      eolMapHash: '99dbc727e5a3ec717dec84af216ece2a1f7427f7547b107da5bd6ce8828329c2',
      sqlContextAssessment: 'outside_sensitive_content' as const, databaseEffectAssessment: 'local_staging_agree' as const,
      evidenceManifestHash: 'c'.repeat(64), approvedTreatment: 'signed_legacy_execution_attestation' as const,
      approvedAt: '2026-01-01T00:00:00.000Z', approverRole: 'owner', approverId: 'empera-owner', approvingOrganization: 'Empera-International',
      signatureAlgorithm: 'ed25519' as const, keyId: 'ephemeral-test',
    };
    const att = signLegacyAttestation(finalizeAttestationId(signed), kp.privateKey);
    const store = loadTrustBundle([{ keyId: 'ephemeral-test', algorithm: 'ed25519', publicKeyPem: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(), purpose: 'legacy_migration_attestation', status: 'active' }]);
    if (!store.ok) throw new Error(store.reason);
    const r = await detectMigrationState(sql, {
      sourceManifest: manifest,
      migrationsFolder: 'drizzle',
      legacyAttestationBundle: {
        attestations: [att],
        store: store.store,
        scope: { repositoryId: 'emperarecords-bit/king-ai-ops-hub', applicationId: 'king-ai-ops-hub', environment: 'staging', migrationNamespace: 'drizzle' },
        verificationTime: new Date('2026-06-01T00:00:00.000Z'),
      },
    });
    expect(r.state).toBe('NO_PENDING');
    expect(r.legacyAttestedMatches).toBe(1);
    expect(r.legacyAttestedDetails[0]!.tag).toBe('0004_knowledge_k1');
    expect(r.unknownHistoricalMismatches).toBe(0);
    // And WITHOUT any attestation the real detector still reports 0004 as a mismatch (fail closed).
    const bare = await detectMigrationState(sql, { sourceManifest: manifest, migrationsFolder: 'drizzle' });
    expect(bare.state).toBe('HISTORICAL_HASH_MISMATCH');
  });

  it('a supplied-but-INVALID attestation is surfaced explicitly and remains blocked (distinct from absent)', async () => {
    if (!dbAvailable) return;
    const { generateKeyPairSync } = await import('node:crypto');
    const { signLegacyAttestation } = await import('../../scripts/backup/legacy-attestation-sign');
    const { finalizeAttestationId } = await import('../../scripts/backup/legacy-attestation-canonical');
    const { loadTrustBundle } = await import('../../scripts/backup/legacy-attestation-verify');
    const signer = generateKeyPairSync('ed25519');
    const untrusted = generateKeyPairSync('ed25519'); // signer key NOT in the store
    const manifest = buildSourceManifestFromGit('HEAD', 'drizzle');
    const e0004 = manifest.entries.find((e) => e.tag === '0004_knowledge_k1')!;
    const appliedHash = (await sql<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations where created_at = ${e0004.when}`)[0]!.hash;
    const signed = {
      attestationVersion: '1' as const, attestationId: `lma1_${'0'.repeat(64)}`, repositoryId: 'emperarecords-bit/king-ai-ops-hub', applicationId: 'king-ai-ops-hub',
      migrationNamespace: 'drizzle', migrationPath: `drizzle/${e0004.tag}.sql`, allowedEnvironments: ['development', 'staging'] as ('development' | 'staging' | 'production')[],
      migrationIndex: e0004.idx, migrationTag: e0004.tag, journalTimestamp: e0004.when,
      reviewedSourceCommit: manifest.sourceCommit, reviewedMigrationSetHash: manifest.sourceMigrationSetHash,
      sourceBlobHash: e0004.committedBlobSha256, appliedExecutionHash: appliedHash,
      sourceByteLength: 3805, appliedByteLength: 3806, differenceType: 'eol_only' as const,
      insertedByteCount: 1, deletedByteCount: 0, substitutedByteCount: 0, insertedCrBeforeLfCount: 1, changedLineIndexes: [48],
      eolMapHash: '99dbc727e5a3ec717dec84af216ece2a1f7427f7547b107da5bd6ce8828329c2',
      sqlContextAssessment: 'outside_sensitive_content' as const, databaseEffectAssessment: 'local_staging_agree' as const,
      evidenceManifestHash: 'c'.repeat(64), approvedTreatment: 'signed_legacy_execution_attestation' as const,
      approvedAt: '2026-01-01T00:00:00.000Z', approverRole: 'owner', approverId: 'empera-owner', approvingOrganization: 'Empera-International',
      signatureAlgorithm: 'ed25519' as const, keyId: 'untrusted-key',
    };
    const att = signLegacyAttestation(finalizeAttestationId(signed), untrusted.privateKey); // signed by an UNTRUSTED key
    const store = loadTrustBundle([{ keyId: 'other-key', algorithm: 'ed25519', publicKeyPem: signer.publicKey.export({ type: 'spki', format: 'pem' }).toString(), purpose: 'legacy_migration_attestation', status: 'active' }]);
    if (!store.ok) throw new Error(store.reason);
    const r = await detectMigrationState(sql, {
      sourceManifest: manifest, migrationsFolder: 'drizzle',
      legacyAttestationBundle: { attestations: [att], store: store.store, scope: { repositoryId: 'emperarecords-bit/king-ai-ops-hub', applicationId: 'king-ai-ops-hub', environment: 'staging', migrationNamespace: 'drizzle' }, verificationTime: new Date('2026-06-01T00:00:00.000Z') },
    });
    expect(r.state).toBe('HISTORICAL_HASH_MISMATCH');
    expect(r.legacyAttestedMatches).toBe(0);
    expect(r.invalidLegacyAttestations.length).toBe(1);
    expect(r.invalidLegacyAttestations[0]!.reasonCode).toBe('unknown_key');
    // ABSENT attestation is distinguishable: no invalid entries.
    const bare = await detectMigrationState(sql, { sourceManifest: manifest, migrationsFolder: 'drizzle' });
    expect(bare.invalidLegacyAttestations.length).toBe(0);
    expect(bare.state).toBe('HISTORICAL_HASH_MISMATCH');
  });

  it('the catalog probe finds this DB non-empty (app schema/tables exist) — read-only', async () => {
    if (!dbAvailable) return;
    const rel = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where c.relkind in ('r','p','S','v','m')
        and n.nspname not in ('pg_catalog','information_schema','pg_toast')
        and n.nspname not like 'pg\\_temp\\_%'
        and not exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')`;
    expect(rel[0]!.n).toBeGreaterThan(0); // proves the probe detects user objects (would block a false bootstrap)
  });
});
