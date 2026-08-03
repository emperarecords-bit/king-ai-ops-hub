import { createHash, generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EXPECTED_DRIZZLE_VERSION, computeExpectedMigrations, installedDrizzleVersion } from '../../scripts/backup/migration-hash';
import { classifyMigrationState, detectMigrationState } from '../../scripts/backup/migration-detector';
import { buildSourceManifestFromGit } from '../../scripts/backup/source-manifest';
import { finalizeAttestationId } from '../../scripts/backup/legacy-attestation-canonical';
import { signLegacyAttestation } from '../../scripts/backup/legacy-attestation-sign';
import { type LegacyTrustStore, loadTrustBundle } from '../../scripts/backup/legacy-attestation-verify';
import {
  LEGACY_0004_SHA256,
  TAG_0004,
  bootstrapDbAvailable,
  createDisposableDb,
  disposableUrl,
  dropDisposableDb,
  makeIdentityMigrationsFolder,
} from '../support/bootstrap-db';

const URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
const sql = postgres(URL, { max: 2, prepare: false });

let dbAvailable = false;
try {
  await sql`select 1 as ok`;
  await sql`select 1 from drizzle.__drizzle_migrations limit 1`;
  dbAvailable = true;
} catch (err) {
  console.warn(`[gbackup-detector.test] ambient DB probe SKIPPED — not reachable/migrated: ${err instanceof Error ? err.message : err}`);
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

// ---------------------------------------------------------------------------
// Identity policy, tested PURELY (no DB) and DETERMINISTICALLY for BOTH 0004 identities. These replace the old
// cases that silently assumed the AMBIENT suite DB carried the accepted-legacy irregular 0004 (c2c7463a…) — which
// fails on a correct fresh-current CI database. The classifier is a pure function of (source manifest, applied
// set, attested keys), so both identities are covered with explicit in-memory `applied`/`runtime` sets,
// independent of whichever identity the ambient DB happens to have. Migration-count independent throughout.
describe('G-Backup-A classifier — 0004 identity policy (pure, both identities)', () => {
  const manifest = buildSourceManifestFromGit('HEAD', 'drizzle');
  const e4 = manifest.entries.find((e) => e.tag === TAG_0004)!;
  const runtime = manifest.entries.map((e) => ({ when: e.when, tag: e.tag, rawHash: e.committedBlobSha256 }));
  /** applied history where 0004 carries `applied0004`, every other migration its exact committed blob. */
  const appliedWith0004 = (applied0004: string) =>
    manifest.entries.map((e) => ({ hash: e.idx === 4 ? applied0004 : e.committedBlobSha256, createdAt: e.when, id: e.idx + 1 }));
  const classify = (applied0004: string, legacyAttestedKeys?: ReadonlySet<string>) =>
    classifyMigrationState({
      source: manifest.entries,
      sourceMigrationSetHash: manifest.sourceMigrationSetHash,
      applied: appliedWith0004(applied0004),
      runtime,
      legacyAttestedKeys,
      migrationsTableMissing: false,
      declaredBootstrap: false,
      hasUnexplainedUserObjects: false,
      databaseIdentityMatches: true,
    });

  it('CLEAN-CURRENT: 0004 = clean committed bytes → NO_PENDING, no historical mismatch (exact match)', () => {
    const r = classify(e4.committedBlobSha256);
    expect(r.state).toBe('NO_PENDING');
    expect(r.unknownHistoricalMismatches).toBe(0);
    expect(r.legacyAttestedMatches).toBe(0);
    expect(r.exactExecutionMatches).toBe(manifest.entries.length);
  });

  it('CLEAN-CURRENT: an unrelated/irrelevant legacy attestation does NOT convert a clean-current 0004 into a legacy match', () => {
    // Even if the attested set contains 0004's key, a clean-current 0004 is an EXACT committed-blob match and is
    // never accounted as legacy-attested — clean-current is not silently re-labeled a legacy match.
    const r = classify(e4.committedBlobSha256, new Set([String(e4.when)]));
    expect(r.state).toBe('NO_PENDING');
    expect(r.legacyAttestedMatches).toBe(0);
    expect(r.exactExecutionMatches).toBe(manifest.entries.length);
  });

  it('ACCEPTED-LEGACY: strict clean-only policy reports HISTORICAL_HASH_MISMATCH for the irregular 0004', () => {
    const r = classify(LEGACY_0004_SHA256);
    expect(r.state).toBe('HISTORICAL_HASH_MISMATCH');
    expect(r.unknownHistoricalMismatches).toBe(1);
    expect(r.legacyAttestedMatches).toBe(0);
    // Migration-count independent: every OTHER migration is an exact committed-blob match.
    expect(r.exactExecutionMatches).toBe(manifest.entries.length - 1);
  });

  it('ACCEPTED-LEGACY: a valid legacy attestation (verified key present) → LEGACY_ATTESTED_MATCH + NO_PENDING', () => {
    const r = classify(LEGACY_0004_SHA256, new Set([String(e4.when)]));
    expect(r.state).toBe('NO_PENDING');
    expect(r.legacyAttestedMatches).toBe(1);
    expect(r.legacyAttestedDetails[0]!.tag).toBe(TAG_0004);
    expect(r.unknownHistoricalMismatches).toBe(0);
    expect(r.exactExecutionMatches + r.legacyAttestedMatches).toBe(manifest.entries.length);
  });

  // Preserved existing structural coverage — still pure, still deterministic.
  it('detects a MISSING applied migration (short prefix → pending forward)', () => {
    const applied = appliedWith0004(e4.committedBlobSha256).slice(0, -1);
    const r = classifyMigrationState({
      source: manifest.entries, sourceMigrationSetHash: manifest.sourceMigrationSetHash, applied, runtime,
      migrationsTableMissing: false, declaredBootstrap: false, hasUnexplainedUserObjects: false, databaseIdentityMatches: true,
    });
    expect(r.state).toBe('PENDING_FORWARD');
    expect(r.pendingTags).toEqual([manifest.entries[manifest.entries.length - 1]!.tag]);
  });

  it('detects an EXTRA applied migration (more applied than source → divergence)', () => {
    const extra = [...appliedWith0004(e4.committedBlobSha256), { hash: 'f'.repeat(64), createdAt: manifest.entries[manifest.entries.length - 1]!.when + 1, id: 999 }];
    const r = classifyMigrationState({
      source: manifest.entries, sourceMigrationSetHash: manifest.sourceMigrationSetHash, applied: extra, runtime,
      migrationsTableMissing: false, declaredBootstrap: false, hasUnexplainedUserObjects: false, databaseIdentityMatches: true,
    });
    expect(r.state).toBe('UNKNOWN_DATABASE_DIVERGENCE');
  });

  it('detects a CHANGED (unrecognized) applied hash → historical mismatch', () => {
    const r = classify('a'.repeat(64));
    expect(r.state).toBe('HISTORICAL_HASH_MISMATCH');
    expect(r.unknownHistoricalMismatches).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The reader (`detectMigrationState`) exercised against REAL, dedicated disposable databases that each carry a
// KNOWN 0004 identity, constructed here — NOT read from the ambient `DATABASE_URL`. Each DB is bootstrapped from a
// temp migrations folder (`makeIdentityMigrationsFolder`) so the applied 0004 hash is deterministic; each is
// dropped in afterAll. This is the part where a real DB is materially required (verifying the read-only SELECTs +
// the cryptographic legacy-attestation path end to end). The `app` schema is created inline (CI compatibility for
// the accepted-main migrate path) rather than importing P1c production code.
const manifest = buildSourceManifestFromGit('HEAD', 'drizzle');
const e0004 = manifest.entries.find((e) => e.tag === TAG_0004)!;

/**
 * Build a signed legacy attestation for 0004 with the given applied-hash claim, plus a trust store.
 *   - valid !== false → the attestation's keyId matches the store's key (the store holds the SIGNER's public
 *     key), so a well-formed attestation verifies.
 *   - valid === false → the attestation declares an UNTRUSTED keyId absent from the store (which holds a
 *     different key id), so the reader reports `unknown_key` and the migration stays blocked.
 */
function signedAttestationFor(appliedExecutionHash: string, opts: { valid?: boolean } = {}) {
  const kp = generateKeyPairSync('ed25519');
  const attKeyId = opts.valid === false ? 'untrusted-key' : 'ephemeral-test';
  const storeKeyId = opts.valid === false ? 'other-key' : 'ephemeral-test';
  const signed = {
    attestationVersion: '1' as const, attestationId: `lma1_${'0'.repeat(64)}`,
    repositoryId: 'emperarecords-bit/king-ai-ops-hub', applicationId: 'king-ai-ops-hub', migrationNamespace: 'drizzle',
    migrationPath: `drizzle/${e0004.tag}.sql`, allowedEnvironments: ['development', 'staging'] as ('development' | 'staging' | 'production')[],
    migrationIndex: e0004.idx, migrationTag: e0004.tag, journalTimestamp: e0004.when,
    reviewedSourceCommit: manifest.sourceCommit, reviewedMigrationSetHash: manifest.sourceMigrationSetHash,
    sourceBlobHash: e0004.committedBlobSha256, appliedExecutionHash,
    sourceByteLength: 3805, appliedByteLength: 3806, differenceType: 'eol_only' as const,
    insertedByteCount: 1, deletedByteCount: 0, substitutedByteCount: 0, insertedCrBeforeLfCount: 1, changedLineIndexes: [48],
    eolMapHash: '99dbc727e5a3ec717dec84af216ece2a1f7427f7547b107da5bd6ce8828329c2',
    sqlContextAssessment: 'outside_sensitive_content' as const, databaseEffectAssessment: 'local_staging_agree' as const,
    evidenceManifestHash: 'c'.repeat(64), approvedTreatment: 'signed_legacy_execution_attestation' as const,
    approvedAt: '2026-01-01T00:00:00.000Z', approverRole: 'owner', approverId: 'empera-owner', approvingOrganization: 'Empera-International',
    signatureAlgorithm: 'ed25519' as const, keyId: attKeyId,
  };
  const att = signLegacyAttestation(finalizeAttestationId(signed), kp.privateKey);
  const store = loadTrustBundle([{ keyId: storeKeyId, algorithm: 'ed25519', publicKeyPem: kp.publicKey.export({ type: 'spki', format: 'pem' }).toString(), purpose: 'legacy_migration_attestation', status: 'active' }]);
  if (!store.ok) throw new Error(store.reason);
  return { att, store: store.store };
}

function bundleFor(att: unknown, store: LegacyTrustStore) {
  return {
    attestations: [att],
    store,
    scope: { repositoryId: 'emperarecords-bit/king-ai-ops-hub', applicationId: 'king-ai-ops-hub', environment: 'staging' as const, migrationNamespace: 'drizzle' },
    verificationTime: new Date('2026-06-01T00:00:00.000Z'),
  };
}

describe('G-Backup-A detector — dedicated disposable DBs, one per 0004 identity (self-provisioned)', () => {
  let available = false;
  const dbs: { clean?: string; legacy?: string } = {};
  const folders: (() => void)[] = [];
  let cleanUrl = '';
  let legacyUrl = '';

  beforeAll(async () => {
    available = await bootstrapDbAvailable();
    if (!available) { console.warn('[gbackup-detector.test] SELF-PROVISIONED DBs SKIPPED — Postgres unreachable.'); return; }
    const rnd = Math.random().toString(36).slice(2, 8);
    dbs.clean = `king_ai_hub_p1d_detcln_${rnd}`;
    dbs.legacy = `king_ai_hub_p1d_detleg_${rnd}`;
    for (const [name, kind] of [[dbs.clean, 'clean'], [dbs.legacy, 'legacy']] as const) {
      const ident = makeIdentityMigrationsFolder(kind);
      folders.push(ident.cleanup);
      await createDisposableDb(name);
      const s = postgres(disposableUrl(name), { max: 1, onnotice: () => {} });
      try {
        // CI compatibility for the accepted-main migrate path: migration 0052 references `app` but no migration
        // creates it (rls.sql does, after migrate). Create it inline here — no P1c production import.
        await s.unsafe('create schema if not exists app');
        await migrate(drizzle(s), { migrationsFolder: ident.folder });
      } finally { await s.end(); }
    }
    cleanUrl = disposableUrl(dbs.clean);
    legacyUrl = disposableUrl(dbs.legacy);
  }, 120_000);

  afterAll(async () => {
    if (dbs.clean) await dropDisposableDb(dbs.clean);
    if (dbs.legacy) await dropDisposableDb(dbs.legacy);
    for (const c of folders) c();
  }, 60_000);

  it('CLEAN-CURRENT DB: no historical mismatch reported solely because the DB uses current committed bytes', async () => {
    if (!available) return;
    const s = postgres(cleanUrl, { max: 2, prepare: false });
    try {
      const applied0004 = (await s<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations where created_at = ${e0004.when}`)[0]!.hash;
      expect(applied0004).toBe(e0004.committedBlobSha256); // verify identity BEFORE asserting
      const a = await detectMigrationState(s, { sourceManifest: manifest, migrationsFolder: 'drizzle' });
      const b = await detectMigrationState(s, { sourceManifest: manifest, migrationsFolder: 'drizzle' });
      expect(a.drizzleVersion).toBe(EXPECTED_DRIZZLE_VERSION);
      expect(a.appliedCount).toBe(manifest.entries.length); // migration-count independent
      expect(a.state).toBe(b.state); // deterministic
      expect(a.state).toBe('NO_PENDING');
      expect(a.unknownHistoricalMismatches).toBe(0);
      expect(a.legacyAttestedMatches).toBe(0);
    } finally { await s.end(); }
  });

  it('CLEAN-CURRENT DB: an irrelevant/invalid legacy attestation is surfaced but does NOT convert clean-current into a legacy match', async () => {
    if (!available) return;
    const s = postgres(cleanUrl, { max: 2, prepare: false });
    try {
      // A (trusted-key) attestation that CLAIMS the legacy applied hash. Against the clean DB the actual applied
      // hash is the committed blob, so the attestation is surfaced as invalid — it never re-labels clean-current.
      const { att, store } = signedAttestationFor(LEGACY_0004_SHA256);
      const r = await detectMigrationState(s, { sourceManifest: manifest, migrationsFolder: 'drizzle', legacyAttestationBundle: bundleFor(att, store) });
      expect(r.state).toBe('NO_PENDING');
      expect(r.legacyAttestedMatches).toBe(0);
      expect(r.invalidLegacyAttestations.length).toBe(1);
      expect(r.invalidLegacyAttestations[0]!.reasonCode).toBe('applied_hash_mismatch');
    } finally { await s.end(); }
  });

  it('ACCEPTED-LEGACY DB: strict clean-only policy reports the documented HISTORICAL_HASH_MISMATCH', async () => {
    if (!available) return;
    const s = postgres(legacyUrl, { max: 2, prepare: false });
    try {
      const applied0004 = (await s<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations where created_at = ${e0004.when}`)[0]!.hash;
      expect(applied0004).toBe(LEGACY_0004_SHA256); // verify the reconstructed identity BEFORE asserting
      const bare = await detectMigrationState(s, { sourceManifest: manifest, migrationsFolder: 'drizzle' });
      expect(bare.appliedCount).toBe(manifest.entries.length);
      expect(bare.state).toBe('HISTORICAL_HASH_MISMATCH');
      expect(bare.unknownHistoricalMismatches).toBe(1);
      expect(bare.invalidLegacyAttestations.length).toBe(0); // absent attestation ≠ invalid attestation
    } finally { await s.end(); }
  });

  it('ACCEPTED-LEGACY DB: a VALID ephemeral attestation → LEGACY_ATTESTED_MATCH + NO_PENDING', async () => {
    if (!available) return;
    const s = postgres(legacyUrl, { max: 2, prepare: false });
    try {
      const applied0004 = (await s<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations where created_at = ${e0004.when}`)[0]!.hash;
      expect(applied0004).toBe(LEGACY_0004_SHA256);
      const { att, store } = signedAttestationFor(applied0004); // attests the true applied (legacy) hash
      const r = await detectMigrationState(s, { sourceManifest: manifest, migrationsFolder: 'drizzle', legacyAttestationBundle: bundleFor(att, store) });
      expect(r.state).toBe('NO_PENDING');
      expect(r.legacyAttestedMatches).toBe(1);
      expect(r.legacyAttestedDetails[0]!.tag).toBe(TAG_0004);
      expect(r.unknownHistoricalMismatches).toBe(0);
    } finally { await s.end(); }
  });

  it('ACCEPTED-LEGACY DB: an INVALID attestation (untrusted signer) stays blocked and is surfaced explicitly', async () => {
    if (!available) return;
    const s = postgres(legacyUrl, { max: 2, prepare: false });
    try {
      const applied0004 = (await s<{ hash: string }[]>`select hash from drizzle.__drizzle_migrations where created_at = ${e0004.when}`)[0]!.hash;
      // Signed by an UNTRUSTED key (the store holds a different public key) → unknown_key, stays blocked.
      const { att, store } = signedAttestationFor(applied0004, { valid: false });
      const r = await detectMigrationState(s, { sourceManifest: manifest, migrationsFolder: 'drizzle', legacyAttestationBundle: bundleFor(att, store) });
      expect(r.state).toBe('HISTORICAL_HASH_MISMATCH');
      expect(r.legacyAttestedMatches).toBe(0);
      expect(r.invalidLegacyAttestations.length).toBe(1);
      expect(r.invalidLegacyAttestations[0]!.reasonCode).toBe('unknown_key');
    } finally { await s.end(); }
  });
});

// ---------------------------------------------------------------------------
describe('G-Backup-A detector — catalog probe (identity-independent, ambient DB)', () => {
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
