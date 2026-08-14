import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  type AppliedRow,
  type GateConfig,
  type GateDbProbe,
  type GateDeps,
  type ReleaseSourceInputs,
  PreMigrationGateError,
  assertDigestBoundImageRef,
  finalizeMigrationConnection,
  redactSecrets,
  resolveGateEnvironment,
  runPreMigrationGate,
} from '../../scripts/backup/premigration-gate';
import { computeRuntimeMigrationSet } from '../../scripts/backup/runtime-migration-set';
import { type SignedReceiptV2 } from '../../scripts/backup/receipt-v2-schema';
import { finalizeReceiptV2Id } from '../../scripts/backup/receipt-v2-canonical';
import { signReceiptV2 } from '../../scripts/backup/receipt-v2-sign';
import { computeNormalizedProviderEvidenceDigest } from '../../scripts/backup/provider-fly-volumes';
import { type ReceiptFetcher } from '../../scripts/backup/receipt-transport';

// -- fixtures ----------------------------------------------------------------

const kp = generateKeyPairSync('ed25519');
const PEM = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const NONCE = 'deadbeefdeadbeefdeadbeefdeadbeef';
const DBID = '7300338420798239475';
// Immutable, digest-bound runtime image identity (staging requires this; tag-only is rejected).
const REF = `registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC@sha256:${'a'.repeat(64)}`;
const REF2 = `registry.fly.io/king-ai-ops-hub-staging@sha256:${'e'.repeat(64)}`; // valid digest-bound, different image
const TAG_ONLY = 'registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const SOURCE_COMMIT = '3a1ed677afaf6616aa5b051f99a4d013ca74a599';
const PORTABLE = 'b'.repeat(64);
const NOW = new Date('2026-08-01T12:00:00.000Z');

const FILE0 = { migrationIndex: 0, migrationTag: '0000_init', migrationPath: 'drizzle/0000_init.sql', bytes: Buffer.from('create table a;\n') };
const FILE1 = { migrationIndex: 1, migrationTag: '0001_next', migrationPath: 'drizzle/0001_next.sql', bytes: Buffer.from('create table b;\n') };

function buildSource(): ReleaseSourceInputs {
  return {
    journal: [
      { idx: 0, tag: '0000_init', when: 1000 },
      { idx: 1, tag: '0001_next', when: 2000 },
    ],
    runtimeSet: computeRuntimeMigrationSet([FILE0, FILE1]),
    sourceCommit: SOURCE_COMMIT,
    portableMigrationSetHash: PORTABLE,
  };
}
const SRC = buildSource();
const ENTRY1 = SRC.runtimeSet.entries.find((e) => e.migrationTag === '0001_next')!;
const PENDING1 = { migrationIndex: ENTRY1.migrationIndex, migrationTag: ENTRY1.migrationTag, migrationPath: ENTRY1.migrationPath, byteLength: ENTRY1.byteLength, sha256: ENTRY1.sha256 };

const KEY_ID = 'staging-dbr-001';
function trustEntry(over: Record<string, unknown> = {}) {
  return { keyId: KEY_ID, algorithm: 'ed25519', publicKeyPem: PEM, purpose: 'deployment_backup_receipt', status: 'active', ...over };
}

function evidence(over: Record<string, unknown> = {}) {
  const e = {
    snapshotProvider: 'fly-volumes' as const,
    providerAdapterVersion: 'fly-volumes.v1',
    snapshotDiscoveryMethod: 'create-response-id' as const,
    snapshotDiscoveryEvidence: { createResponseSnapshotId: 'vs_abc123', listedSnapshotId: 'vs_abc123' },
    snapshotId: 'vs_abc123',
    sourceVolumeId: 'vol_4m3kmknl059qpd6v',
    databaseApp: 'king-ai-hub-db-staging',
    providerSnapshotStatus: 'created',
    canonicalSnapshotStatus: 'complete' as const,
    snapshotRequestedAt: '2026-08-01T11:58:00.000Z',
    snapshotCreatedAt: '2026-08-01T11:58:30.000Z',
    providerObservedAt: '2026-08-01T11:59:00.000Z',
    retentionDays: 7,
    storedSizeBytes: 130000000,
    ...over,
  };
  return { e, digest: computeNormalizedProviderEvidenceDigest(e) };
}

function signedReceiptBytes(over: Partial<SignedReceiptV2> = {}, evOver: Record<string, unknown> = {}): Buffer {
  const { e, digest } = evidence(evOver);
  const signed = finalizeReceiptV2Id({
    schemaVersion: '2', canonicalizationVersion: 1, receiptId: `rcpt2_${'0'.repeat(64)}`,
    environment: 'staging', targetApplication: 'king-ai-ops-hub-staging', databaseApp: e.databaseApp,
    sourceVolumeId: e.sourceVolumeId, databaseSystemIdentifier: DBID,
    snapshotProvider: 'fly-volumes', providerSnapshotStatus: e.providerSnapshotStatus, canonicalSnapshotStatus: 'complete', snapshotDiscoveryMethod: 'create-response-id',
    snapshotDiscoveryEvidence: e.snapshotDiscoveryEvidence, snapshotId: e.snapshotId,
    snapshotRequestedAt: e.snapshotRequestedAt, snapshotCreatedAt: e.snapshotCreatedAt, providerObservedAt: e.providerObservedAt,
    retentionDays: e.retentionDays, storedSizeBytes: e.storedSizeBytes, normalizedProviderEvidenceDigest: digest, providerAdapterVersion: e.providerAdapterVersion,
    sourceCommit: SOURCE_COMMIT, targetImageRef: REF, targetImageDigest: DIGEST, deploymentNonce: NONCE,
    portableMigrationSetHash: PORTABLE, runtimeMigrationSetHash: SRC.runtimeSet.runtimeMigrationSetHash,
    pendingMigrations: [PENDING1],
    receiptCreatedAt: '2026-08-01T11:59:30.000Z', expiresAt: '2026-08-01T12:20:00.000Z', signatureAlgorithm: 'ed25519', keyId: KEY_ID,
    ...over,
  });
  return Buffer.from(JSON.stringify(signReceiptV2(signed, kp.privateKey)), 'utf8');
}

function fetcher(bytes: Buffer | (() => Promise<never>), counter = { n: 0 }): { f: ReceiptFetcher; counter: { n: number } } {
  return {
    counter,
    f: {
      fetchOnce() {
        counter.n++;
        if (typeof bytes === 'function') return bytes();
        return Promise.resolve({ status: 200, bytes, contentEncoding: null, redirected: false });
      },
    },
  };
}

function probe(over: Partial<{ missing: boolean; applied: AppliedRow[]; unexplained: boolean; db: string; sysid: string; throwOn: string }> = {}, counter = { n: 0 }): GateDbProbe {
  const o = { missing: false, applied: [{ hash: 'h0', createdAt: 1000, id: 1 }] as AppliedRow[], unexplained: false, db: 'king_ai_hub', sysid: DBID, ...over };
  const guard = (name: string) => { if (o.throwOn === name) throw new Error(`probe ${name} boom`); };
  return {
    async migrationsTableMissing() { counter.n++; guard('missing'); return o.missing; },
    async appliedRows() { guard('applied'); return o.applied; },
    async hasUnexplainedUserObjects() { guard('unexplained'); return o.unexplained; },
    async currentDatabase() { guard('db'); return o.db; },
    async systemIdentifier() { guard('sysid'); return o.sysid; },
  };
}

function baseConfig(over: Partial<GateConfig> = {}): GateConfig {
  return {
    environment: 'staging', bypass: false, flyRuntimePresent: true, declaredBootstrap: false, expectedDatabaseIdentity: 'king_ai_hub',
    deploymentNonce: NONCE, receiptBaseUrl: 'https://receipts.example.com', hostAllowlist: new Set(['receipts.example.com']),
    trustBundleEntries: [trustEntry()], targetApplication: 'king-ai-ops-hub-staging', databaseApp: 'king-ai-hub-db-staging',
    sourceVolumeId: 'vol_4m3kmknl059qpd6v', expectedImageRef: REF, minRetentionDays: 7, maxSnapshotAgeMs: 30 * 60 * 1000,
    transportMaxBytes: 64 * 1024, transportTimeoutMs: 2000, ...over,
  };
}

function deps(over: { config?: Partial<GateConfig>; probe?: GateDbProbe; f?: ReceiptFetcher; source?: ReleaseSourceInputs; loadSource?: () => ReleaseSourceInputs; now?: Date } = {}): GateDeps {
  return {
    config: baseConfig(over.config),
    probe: over.probe ?? probe(),
    fetcher: over.f ?? fetcher(signedReceiptBytes()).f,
    loadSource: over.loadSource ?? (() => over.source ?? SRC),
    now: over.now ?? NOW,
  };
}

async function code(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); return 'OK'; } catch (e) { return e instanceof PreMigrationGateError ? e.code : `THREW:${e instanceof Error ? e.message : e}`; }
}
async function verifyCode(d: GateDeps): Promise<string | undefined> {
  try { await runPreMigrationGate(d); return undefined; } catch (e) { return e instanceof PreMigrationGateError ? e.verifyCode : undefined; }
}

// -- environment resolution --------------------------------------------------

describe('B2a resolveGateEnvironment', () => {
  it('forces staging when the machine is the staging app; aborts on mismatch', () => {
    expect(resolveGateEnvironment({ gbackupEnvironment: 'staging', flyAppName: 'king-ai-ops-hub-staging' })).toBe('staging');
    expect(() => resolveGateEnvironment({ gbackupEnvironment: '', flyAppName: 'king-ai-ops-hub-staging' })).toThrow(PreMigrationGateError);
    expect(() => resolveGateEnvironment({ gbackupEnvironment: 'local', flyAppName: 'king-ai-ops-hub-staging' })).toThrow(PreMigrationGateError);
  });
  it('defaults to local when nothing is set; rejects unknown values', () => {
    expect(resolveGateEnvironment({})).toBe('local');
    expect(resolveGateEnvironment({ gbackupEnvironment: 'test' })).toBe('test');
    expect(() => resolveGateEnvironment({ gbackupEnvironment: 'prod-ish' })).toThrow(PreMigrationGateError);
  });
});

// -- happy paths -------------------------------------------------------------

describe('B2a gate — proceed paths', () => {
  it('bootstrap-empty bypass: no receipt, no source load, no fetch', async () => {
    const fc = { n: 0 };
    let sourceLoaded = 0;
    const d = deps({ config: { declaredBootstrap: true }, probe: probe({ missing: true }), f: fetcher(signedReceiptBytes(), fc).f, loadSource: () => { sourceLoaded++; return SRC; } });
    const v = await runPreMigrationGate(d);
    expect(v.mode).toBe('bootstrap_bypass');
    expect(fc.n).toBe(0);
    expect(sourceLoaded).toBe(0);
  });
  it('pending-forward success: valid signed receipt verifies', async () => {
    const v = await runPreMigrationGate(deps());
    expect(v.ok).toBe(true);
    expect(v.mode).toBe('verified');
    expect(v.receiptCanonicalHash).toMatch(/^[0-9a-f]{64}$/);
  });
  it('local explicit bypass proceeds without probing or fetching (no Fly identity)', async () => {
    const fc = { n: 0 };
    const pc = { n: 0 };
    const v = await runPreMigrationGate(deps({ config: { environment: 'local', bypass: true, flyRuntimePresent: false }, probe: probe({}, pc), f: fetcher(signedReceiptBytes(), fc).f }));
    expect(v.mode).toBe('local_bypass');
    expect(pc.n).toBe(0);
    expect(fc.n).toBe(0);
  });
});

describe('B2a gate — bypass classification hardening', () => {
  it('honored only for local/dev/test with NO Fly identity', async () => {
    for (const environment of ['local', 'development', 'test'] as const) {
      const v = await runPreMigrationGate(deps({ config: { environment, bypass: true, flyRuntimePresent: false } }));
      expect(v.mode).toBe('local_bypass');
    }
  });
  it('refused when Fly runtime identity is present, even for local', async () => {
    expect(await code(() => runPreMigrationGate(deps({ config: { environment: 'local', bypass: true, flyRuntimePresent: true } })))).toBe('bypass_not_allowed');
  });
  it('refused for staging and production regardless of Fly identity', async () => {
    expect(await code(() => runPreMigrationGate(deps({ config: { environment: 'staging', bypass: true, flyRuntimePresent: false } })))).toBe('bypass_not_allowed');
    expect(await code(() => runPreMigrationGate(deps({ config: { environment: 'production', bypass: true, flyRuntimePresent: false } })))).toBe('bypass_not_allowed');
  });
});

// -- non-empty NO_PENDING requires a receipt (rls.sql mutates) ----------------

describe('B2a gate — non-empty NO_PENDING requires an (empty-list) receipt', () => {
  const NO_PENDING = { applied: [{ hash: 'h0', createdAt: 1000, id: 1 }, { hash: 'h1', createdAt: 2000, id: 2 }] };
  it('succeeds with a valid empty-list receipt (never bypasses)', async () => {
    const fc = { n: 0 };
    const d = deps({ probe: probe(NO_PENDING), f: fetcher(signedReceiptBytes({ pendingMigrations: [] }), fc).f });
    const v = await runPreMigrationGate(d);
    expect(v.mode).toBe('verified'); // NOT bootstrap/local bypass
    expect(fc.n).toBe(1); // a receipt WAS required and fetched
  });
  it('rejects when the receipt claims a NON-EMPTY pending list for a NO_PENDING database', async () => {
    const d = deps({ probe: probe(NO_PENDING), f: fetcher(signedReceiptBytes({ pendingMigrations: [PENDING1] })).f });
    expect(await verifyCode(d)).toBe('pending_migration_mismatch');
  });
  it('rejects when the database HAS a pending migration but the receipt list is empty', async () => {
    // default probe = one applied ⇒ one pending; an empty-list receipt must not satisfy it.
    const d = deps({ f: fetcher(signedReceiptBytes({ pendingMigrations: [] })).f });
    expect(await verifyCode(d)).toBe('pending_migration_mismatch');
  });
});

// -- staging config fail-closed ----------------------------------------------

describe('B2a gate — staging fails closed on configuration', () => {
  it('missing trust bundle / base URL / nonce / identifiers → config_incomplete', async () => {
    expect(await code(() => runPreMigrationGate(deps({ config: { trustBundleEntries: undefined } })))).toBe('config_incomplete');
    expect(await code(() => runPreMigrationGate(deps({ config: { receiptBaseUrl: undefined } })))).toBe('config_incomplete');
    expect(await code(() => runPreMigrationGate(deps({ config: { deploymentNonce: undefined } })))).toBe('config_incomplete');
    expect(await code(() => runPreMigrationGate(deps({ config: { databaseApp: undefined } })))).toBe('config_incomplete');
  });
  it('malformed config (empty allowlist / bad nonce) → config_invalid', async () => {
    expect(await code(() => runPreMigrationGate(deps({ config: { hostAllowlist: new Set() } })))).toBe('config_invalid');
    expect(await code(() => runPreMigrationGate(deps({ config: { deploymentNonce: 'not-a-nonce' } })))).toBe('config_invalid');
  });
  it('explicit bypass attempt in staging is refused (probe untouched)', async () => {
    const pc = { n: 0 };
    const c = await code(() => runPreMigrationGate(deps({ config: { bypass: true }, probe: probe({}, pc) })));
    expect(c).toBe('bypass_not_allowed');
    expect(pc.n).toBe(0);
  });
  it('trust bundle that fails to load → trust_bundle_invalid', async () => {
    expect(await code(() => runPreMigrationGate(deps({ config: { trustBundleEntries: [trustEntry({ purpose: 'legacy_migration_attestation' })] } })))).toBe('trust_bundle_invalid');
  });
});

// -- baked source identity ---------------------------------------------------

describe('B2a gate — baked source identity is fatal on staging when missing/placeholder', () => {
  it('placeholder sourceCommit / portable hash → source_identity_invalid', async () => {
    expect(await code(() => runPreMigrationGate(deps({ source: { ...SRC, sourceCommit: 'UNKNOWN' } })))).toBe('source_identity_invalid');
    expect(await code(() => runPreMigrationGate(deps({ source: { ...SRC, portableMigrationSetHash: 'UNKNOWN' } })))).toBe('source_identity_invalid');
    expect(await code(() => runPreMigrationGate(deps({ source: { ...SRC, sourceCommit: 'zz' } })))).toBe('source_identity_invalid');
  });
  it('a throwing source loader on the verified path fails closed', async () => {
    expect(await code(() => runPreMigrationGate(deps({ loadSource: () => { throw new Error('no baked file'); } })))).toBe('source_identity_invalid');
  });
});

// -- immutable digest-bound image identity -----------------------------------

describe('B2a gate — staging requires an immutable digest-bound image identity', () => {
  it('rejects tag-only / placeholder / malformed-digest identity with image_identity_invalid', async () => {
    expect(await code(() => runPreMigrationGate(deps({ config: { expectedImageRef: TAG_ONLY } })))).toBe('image_identity_invalid'); // tag-only (mutable)
    expect(await code(() => runPreMigrationGate(deps({ config: { expectedImageRef: 'UNKNOWN' } })))).toBe('image_identity_invalid'); // placeholder
    expect(await code(() => runPreMigrationGate(deps({ config: { expectedImageRef: 'registry.fly.io/app@sha256:deadbeef' } })))).toBe('image_identity_invalid'); // malformed digest
  });
  it('missing image identity is rejected', async () => {
    expect(await code(() => runPreMigrationGate(deps({ config: { expectedImageRef: undefined } })))).toBe('config_incomplete');
  });
  it('a digest-bound identity that does not exactly match the receipt is rejected by the verifier', async () => {
    expect(await verifyCode(deps({ config: { expectedImageRef: REF2 } }))).toBe('image_ref_mismatch');
  });
  it('local/dev tolerates a tag-only identity (enforcement is staging/production only)', async () => {
    // local bypass path never builds the expectation; a non-bypass local run would still verify, but the digest
    // requirement is not enforced outside staging/production — proven via assertDigestBoundImageRef directly.
    expect(() => assertDigestBoundImageRef(REF)).not.toThrow();
    expect(() => assertDigestBoundImageRef(TAG_ONLY)).toThrow(PreMigrationGateError);
  });
});

// -- database probe / divergence ---------------------------------------------

describe('B2a gate — database probe + divergence', () => {
  it('probe failure → db_probe_failed', async () => {
    expect(await code(() => runPreMigrationGate(deps({ probe: probe({ throwOn: 'applied' }) })))).toBe('db_probe_failed');
    expect(await code(() => runPreMigrationGate(deps({ probe: probe({ throwOn: 'sysid' }) })))).toBe('db_probe_failed');
  });
  it('zero / non-canonical system identifier → system_identifier_invalid', async () => {
    expect(await code(() => runPreMigrationGate(deps({ probe: probe({ sysid: '0' }) })))).toBe('system_identifier_invalid');
    expect(await code(() => runPreMigrationGate(deps({ probe: probe({ sysid: '00123' }) })))).toBe('system_identifier_invalid');
  });
  it('applied history that is not a clean journal prefix → database_divergence', async () => {
    expect(await code(() => runPreMigrationGate(deps({ probe: probe({ applied: [{ hash: 'h', createdAt: 9999, id: 1 }] }) })))).toBe('database_divergence'); // when != journal
    expect(await code(() => runPreMigrationGate(deps({ probe: probe({ applied: [{ hash: 'h0', createdAt: 1000, id: 1 }, { hash: 'h1', createdAt: 2000, id: 2 }, { hash: 'h2', createdAt: 3000, id: 3 }] }) })))).toBe('database_divergence'); // count > journal
    expect(await code(() => runPreMigrationGate(deps({ probe: probe({ applied: [{ hash: 'h', createdAt: 1000, id: 1 }, { hash: 'h', createdAt: 2000, id: 2 }] }) })))).toBe('database_divergence'); // duplicate hash
  });
  it('migration table absent but non-empty / not-bootstrap / wrong identity → migration_table_missing_nonempty', async () => {
    expect(await code(() => runPreMigrationGate(deps({ config: { declaredBootstrap: true }, probe: probe({ missing: true, unexplained: true }) })))).toBe('migration_table_missing_nonempty');
    expect(await code(() => runPreMigrationGate(deps({ config: { declaredBootstrap: false }, probe: probe({ missing: true }) })))).toBe('migration_table_missing_nonempty');
    expect(await code(() => runPreMigrationGate(deps({ config: { declaredBootstrap: true }, probe: probe({ missing: true, db: 'other_db' }) })))).toBe('migration_table_missing_nonempty');
  });
});

// -- transport failures ------------------------------------------------------

describe('B2a gate — transport failures fail closed', () => {
  const bad = (bytes: Buffer | (() => Promise<never>)) => deps({ f: fetcher(bytes).f });
  it('timeout / non-200 / redirect / oversize / empty', async () => {
    expect(await code(() => runPreMigrationGate(deps({ f: { fetchOnce: () => Promise.reject(Object.assign(new Error('t'), { code: 'timeout' })) } })))).toBe('verification_failed');
    expect(await code(() => runPreMigrationGate(deps({ f: { fetchOnce: () => Promise.resolve({ status: 404, bytes: Buffer.from('x'), contentEncoding: null, redirected: false }) } })))).toBe('verification_failed');
    expect(await code(() => runPreMigrationGate(deps({ f: { fetchOnce: () => Promise.resolve({ status: 200, bytes: signedReceiptBytes(), contentEncoding: null, redirected: true }) } })))).toBe('verification_failed');
    expect(await code(() => runPreMigrationGate(deps({ f: { fetchOnce: () => Promise.resolve({ status: 200, bytes: Buffer.alloc(64 * 1024 + 1, 0x20), contentEncoding: null, redirected: false }) } })))).toBe('verification_failed');
    expect(await code(() => runPreMigrationGate(bad(Buffer.alloc(0))))).toBe('verification_failed');
  });
});

// -- receipt / key / mismatch failures (delegated to the B1 verifier) --------

describe('B2a gate — receipt + key + mismatch failures carry the verifier code', () => {
  it('malformed receipt JSON', async () => {
    expect(await verifyCode(deps({ f: fetcher(Buffer.from('{bad', 'utf8')).f }))).toBe('json_invalid');
  });
  it('unknown / revoked / inactive / expired / not-yet-valid keys', async () => {
    expect(await verifyCode(deps({ f: fetcher(signedReceiptBytes({ keyId: 'someone-else' })).f, config: { trustBundleEntries: [trustEntry()] } }))).toBe('unknown_key');
    expect(await verifyCode(deps({ config: { trustBundleEntries: [trustEntry({ status: 'revoked' })] } }))).toBe('revoked_key');
    expect(await verifyCode(deps({ config: { trustBundleEntries: [trustEntry({ status: 'inactive' })] } }))).toBe('inactive_key');
    expect(await verifyCode(deps({ config: { trustBundleEntries: [trustEntry({ notAfter: '2026-07-01T00:00:00.000Z' })] } }))).toBe('expired_at_receipt');
    expect(await verifyCode(deps({ config: { trustBundleEntries: [trustEntry({ notBefore: '2026-09-01T00:00:00.000Z' })] } }))).toBe('not_yet_valid_at_receipt');
  });
  it('source-commit / image / db-id / volume / application / nonce mismatches', async () => {
    expect(await verifyCode(deps({ f: fetcher(signedReceiptBytes({ sourceCommit: 'f'.repeat(40) })).f }))).toBe('source_commit_mismatch');
    expect(await verifyCode(deps({ config: { expectedImageRef: REF2 } }))).toBe('image_ref_mismatch'); // valid digest-bound, different image
    expect(await verifyCode(deps({ probe: probe({ sysid: '999' }) }))).toBe('db_identity_mismatch');
    expect(await verifyCode(deps({ config: { sourceVolumeId: 'vol_other' } }))).toBe('db_identity_mismatch');
    expect(await verifyCode(deps({ config: { targetApplication: 'king-ai-ops-hub-prod' } }))).toBe('application_mismatch');
    expect(await verifyCode(deps({ config: { deploymentNonce: 'cafebabecafebabecafebabecafebabe' } }))).toBe('nonce_mismatch');
  });
  it('migration-set and freshness mismatches', async () => {
    const tampered = { ...PENDING1, sha256: '1'.repeat(64) };
    expect(await verifyCode(deps({ f: fetcher(signedReceiptBytes({ pendingMigrations: [tampered] })).f }))).toBe('pending_migration_mismatch');
    expect(await verifyCode(deps({ f: fetcher(signedReceiptBytes({ runtimeMigrationSetHash: 'c'.repeat(64) })).f }))).toBe('migration_set_mismatch');
    expect(await verifyCode(deps({ now: new Date('2026-08-01T12:40:00.000Z') }))).toBe('snapshot_time_invalid'); // > 30 min old
  });
  // Gate 3 (owner-approved 2026-08-14): the categorical production exclusion became an explicit double-switch —
  // a production receipt verifies ONLY when the gate itself is explicitly production-configured; every other
  // configuration still rejects it fail-closed (environment mismatch fires before the step-18 policy).
  it('production receipt VERIFIES when the gate is explicitly production-configured (Gate 3)', async () => {
    const c = await verifyCode(deps({ config: { environment: 'production' }, f: fetcher(signedReceiptBytes({ environment: 'production' })).f }));
    expect(c).toBeUndefined(); // no failure code — full verification succeeded
  });
  it('a STAGING-configured gate still rejects a production receipt fail-closed', async () => {
    const c = await verifyCode(deps({ f: fetcher(signedReceiptBytes({ environment: 'production' })).f }));
    expect(c).toBe('environment_mismatch');
  });
});

// -- migration connection cleanup --------------------------------------------

describe('B2a finalizeMigrationConnection — cleanup never masks the primary failure', () => {
  const okOps = (over: Partial<{ locked: boolean; unlock: () => Promise<void>; end: () => Promise<void> }> = {}) => {
    const calls = { unlock: 0, end: 0 };
    const ops = {
      locked: over.locked ?? true,
      unlock: over.unlock ?? (() => { calls.unlock++; return Promise.resolve(); }),
      end: over.end ?? (() => { calls.end++; return Promise.resolve(); }),
    };
    return { ops, calls };
  };

  it('happy path: unlock then end, no throw', async () => {
    const { ops, calls } = okOps();
    await expect(finalizeMigrationConnection(null, ops, () => {})).resolves.toBeUndefined();
    expect(calls).toEqual({ unlock: 1, end: 1 });
  });
  it('not locked: unlock is skipped, end still attempted', async () => {
    let unlocked = 0;
    let ended = 0;
    await finalizeMigrationConnection(null, { locked: false, unlock: () => { unlocked++; return Promise.resolve(); }, end: () => { ended++; return Promise.resolve(); } }, () => {});
    expect(unlocked).toBe(0);
    expect(ended).toBe(1);
  });
  it('unlock failure still attempts end and surfaces (no primary)', async () => {
    let ended = 0;
    const p = finalizeMigrationConnection(null, { locked: true, unlock: () => Promise.reject(new Error('unlock boom')), end: () => { ended++; return Promise.resolve(); } }, () => {});
    await expect(p).rejects.toThrow(/post-migration cleanup failed.*advisory_unlock/);
    expect(ended).toBe(1); // end attempted even though unlock failed
  });
  it('end failure surfaces (no primary)', async () => {
    await expect(finalizeMigrationConnection(null, okOps({ end: () => Promise.reject(new Error('close boom')) }).ops, () => {})).rejects.toThrow(/connection_close/);
  });
  it('a primary error is rethrown UNCHANGED even when cleanup also fails', async () => {
    const primary = new PreMigrationGateError('verification_failed', 'the real failure');
    let logged = '';
    let ended = 0;
    const p = finalizeMigrationConnection(primary, { locked: true, unlock: () => Promise.reject(new Error('unlock boom')), end: () => { ended++; return Promise.reject(new Error('close boom')); } }, (m) => { logged = m; });
    await expect(p).rejects.toBe(primary); // exact primary, not the cleanup error
    expect(ended).toBe(1); // end still attempted
    expect(logged).toMatch(/cleanup issues after a primary failure/);
  });
  it('redactSecrets strips scheme://user:pass@host credentials from diagnostics', async () => {
    expect(redactSecrets('connect postgres://king:s3cret@db.internal:5432/x failed')).toBe('connect postgres://***@db.internal:5432/x failed');
    // a cleanup message derived from an error carrying a URL is redacted before it is thrown/logged.
    let msg = '';
    await finalizeMigrationConnection(null, { locked: true, unlock: () => Promise.reject(new Error('FATAL postgresql://u:pw@h/db')), end: () => Promise.resolve() }, () => {}).catch((e) => { msg = (e as Error).message; });
    expect(msg).toContain('//***@');
    expect(msg).not.toContain('pw@');
  });
});

// -- ordering proof: no mutation after a gate failure ------------------------

describe('B2a gate — neither migrate() nor rls.sql runs after any gate failure', () => {
  // Faithful model of the migrate.ts control flow: mutations happen ONLY if the gate resolves.
  async function runFlow(d: GateDeps): Promise<{ migrated: boolean; rls: boolean }> {
    let migrated = false;
    let rls = false;
    await runPreMigrationGate(d); // throws on any failure → the two lines below are unreachable
    migrated = true;
    rls = true;
    return { migrated, rls };
  }
  it('failure ⇒ mutations never reached', async () => {
    for (const d of [
      deps({ config: { bypass: true } }), // bypass_not_allowed_in_staging
      deps({ config: { trustBundleEntries: undefined } }), // config_incomplete
      deps({ probe: probe({ throwOn: 'missing' }) }), // db_probe_failed
      deps({ f: fetcher(Buffer.from('{bad')).f }), // verification_failed
      deps({ probe: probe({ applied: [{ hash: 'h', createdAt: 42, id: 1 }] }) }), // database_divergence
    ]) {
      await expect(runFlow(d)).rejects.toBeInstanceOf(PreMigrationGateError);
    }
  });
  it('success ⇒ mutations reached', async () => {
    await expect(runFlow(deps())).resolves.toEqual({ migrated: true, rls: true });
    await expect(runFlow(deps({ config: { declaredBootstrap: true }, probe: probe({ missing: true }) }))).resolves.toEqual({ migrated: true, rls: true });
  });
});
