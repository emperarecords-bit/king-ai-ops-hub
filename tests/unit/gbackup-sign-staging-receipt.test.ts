import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it , vi } from 'vitest';
import { HEAVY_HOOK_TIMEOUT_MS, HEAVY_TEST_TIMEOUT_MS } from '../support/heavy-timeout';
// #117: git-blob/DB-heavy test file — bounded timeout headroom under full-suite parallel contention (assertions unchanged).
vi.setConfig({ testTimeout: HEAVY_TEST_TIMEOUT_MS, hookTimeout: HEAVY_HOOK_TIMEOUT_MS });
import { type RunCliOptions, runCli } from '../../scripts/ci/sign-staging-receipt';
import {
  type ReleasePins,
  type StagingReceiptInputs,
  SELF_VERIFY_MAX_SNAPSHOT_AGE_MS,
  STAGING_PINS,
  StagingReceiptInputError,
  assertNoPrivateMaterial,
  buildSelfVerifyExpectation,
  buildStagingSignedReceipt,
  derivePublicTrustEntry,
  produceStagingReceipt,
} from '../../scripts/backup/sign-staging-receipt';
import { receiptV2Schema } from '../../scripts/backup/receipt-v2-schema';
import { readRuntimeMigrationSet } from '../../scripts/backup/runtime-migration-set';
import { loadReceiptKeyBundle } from '../../scripts/backup/receipt-key-bundle';
import { DEFAULT_MAX_SNAPSHOT_AGE_MS, verifyReceiptV2Parsed } from '../../scripts/backup/receipt-v2-verify';

/**
 * G-Backup staging-receipt producer — tests use EPHEMERAL, NON-PRODUCTION ed25519 keys generated in-process. No real
 * signer, GitHub secret, Fly, snapshot, migration, or deploy is involved. Migration facts are DERIVED from the
 * checked-out drizzle tree, so this proves the assembler binds to the real 0000–0077 source set.
 */

const kp = generateKeyPairSync('ed25519');
// The migration facts are derived from a REAL commit (the portable hash reads git blobs at sourceCommit), so the
// producer tests below run against a FROZEN historical source tree: the exact commit that introduced 0078
// (0078_silent_ultron / 79 committed migrations). A moving HEAD must not redefine the fixture, so that commit is
// pinned here and the producer is called with HISTORICAL_STAGING_PINS.
//
// Pinning the FIXTURE is correct; what was wrong before 2026-11-11 is that these tests asserted the fixture's
// endpoint/count through the LIVE STAGING_PINS default. That coupling made a frozen fixture look like a passing
// pin check, so STAGING_PINS sat at 0078 / 79 while the tree advanced to 0088 / 89 and every staging signing run
// failed closed in deriveMigrationFacts. The fixture now carries its own pins, and a separate tree-coupled test
// (mirroring tests/unit/gbackup-production-pins.test.ts) asserts the LIVE pin against the LIVE tree.
const STAGING_SOURCE_COMMIT = execFileSync(
  'git', ['rev-parse', '1be10f77ab5400b435d36ef05014fffca9f9ab92^{commit}'], { encoding: 'utf8' },
).trim();
const STAGING_RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'staging-source-0078-'));
const stagingJournalText = execFileSync(
  'git', ['show', `${STAGING_SOURCE_COMMIT}:drizzle/meta/_journal.json`], { encoding: 'utf8' },
);
mkdirSync(join(STAGING_RUNTIME_DIR, 'drizzle', 'meta'), { recursive: true });
writeFileSync(join(STAGING_RUNTIME_DIR, 'drizzle', 'meta', '_journal.json'), stagingJournalText, 'utf8');
const stagingJournal = JSON.parse(stagingJournalText) as { entries: Array<{ tag: string }> };
for (const entry of stagingJournal.entries) {
  writeFileSync(
    join(STAGING_RUNTIME_DIR, 'drizzle', `${entry.tag}.sql`),
    execFileSync('git', ['show', `${STAGING_SOURCE_COMMIT}:drizzle/${entry.tag}.sql`]),
  );
}
afterAll(() => rmSync(STAGING_RUNTIME_DIR, { recursive: true, force: true }));

// Staging has applied 0000–0068 (69 migrations); 0069–0077 are the pending set. APPLIED_COUNT is an EXPLICIT
// runtime input (STAGING_PINS.requireExplicitAppliedCount) — never a baked default.
const STAGING_APPLIED_COUNT = 69;

/**
 * Pins for the FROZEN 0078 fixture tree above. Identical to {@link STAGING_PINS} in every identity field → only
 * the endpoint/count tripwire is rewound to what that historical tree actually contains, so these producer tests
 * never move when the live pin is bumped for a new migration.
 */
const HISTORICAL_STAGING_PINS: ReleasePins = {
  ...STAGING_PINS,
  expectedMigrationEndpoint: '0078_silent_ultron',
  expectedCommittedMigrationCount: 79,
};
const HISTORICAL_CLI_OPTIONS: RunCliOptions = {
  pins: HISTORICAL_STAGING_PINS,
  receiptBasename: 'staging-receipt.v2.json',
  label: 'staging',
};
const EXPECTED_PENDING_TAGS = stagingJournal.entries.slice(STAGING_APPLIED_COUNT).map((e) => e.tag);

const DIGEST = `sha256:${'a'.repeat(64)}`;
function goodInputs(over: Partial<StagingReceiptInputs> = {}): StagingReceiptInputs {
  return {
    sourceCommit: STAGING_SOURCE_COMMIT,
    targetImageRef: `registry.fly.io/king-ai-ops-hub-staging@${DIGEST}`,
    targetImageDigest: DIGEST,
    deploymentNonce: 'deadbeefdeadbeefdeadbeefdeadbeef',
    databaseSystemIdentifier: '7300338420798239475',
    snapshotId: 'vs_abc123',
    snapshotRequestedAt: '2026-08-03T12:00:00.000Z',
    snapshotCreatedAt: '2026-08-03T12:00:05.000Z',
    providerObservedAt: '2026-08-03T12:00:10.000Z',
    retentionDays: 7,
    storedSizeBytes: 130000000,
    receiptCreatedAt: '2026-08-03T12:00:15.000Z',
    expiresAt: '2026-08-03T12:30:15.000Z',
    keyId: 'staging-dbr-2026-08',
    discovery: { method: 'create-response-id', createResponseSnapshotId: 'vs_abc123', listedSnapshotId: 'vs_abc123' },
    appliedCount: STAGING_APPLIED_COUNT,
    ...over,
  };
}

describe('snapshot-freshness window — one constant, no drift between consumers', () => {
  // This number is the binding constraint on the WHOLE ceremony, not a producer sanity check:
  // publishSignedReceiptV2 substitutes the real publish clock for migrationStartedAt and keeps this window, and no
  // environment variable reaches it. It previously sat at an independent 30-minute literal here while the release
  // gate defaulted to its own 30-minute literal, so widening GBACKUP_MAX_SNAPSHOT_AGE_MS could satisfy the gate
  // while publication was still refused at step 16. One constant is what prevents that split.
  it('self-verify (and therefore publish-time verify) uses the shared constant', () => {
    expect(SELF_VERIFY_MAX_SNAPSHOT_AGE_MS).toBe(DEFAULT_MAX_SNAPSHOT_AGE_MS);
  });
  it('the shared window is 60 minutes', () => {
    expect(DEFAULT_MAX_SNAPSHOT_AGE_MS).toBe(60 * 60 * 1000);
  });
  it('the self-verify expectation is built from the constant, not a literal', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'backup', 'sign-staging-receipt.ts'), 'utf8');
    expect(src).toContain('maxSnapshotAgeMs: SELF_VERIFY_MAX_SNAPSHOT_AGE_MS');
    expect(src).toContain('SELF_VERIFY_MAX_SNAPSHOT_AGE_MS = DEFAULT_MAX_SNAPSHOT_AGE_MS');
  });
  it('the release gate defaults to the same constant rather than restating a literal', () => {
    const src = readFileSync(join(process.cwd(), 'scripts', 'migrate.ts'), 'utf8');
    expect(src).toContain('intEnv(env.GBACKUP_MAX_SNAPSHOT_AGE_MS, DEFAULT_MAX_SNAPSHOT_AGE_MS)');
    expect(src).not.toMatch(/GBACKUP_MAX_SNAPSHOT_AGE_MS,\s*\d/);
  });
});

describe('staging pins — consistency with the repository', () => {
  const runtime = readRuntimeMigrationSet(process.cwd(), 'drizzle');
  const sorted = [...runtime.entries].sort((a, b) => a.migrationIndex - b.migrationIndex);

  // The mirror of tests/unit/gbackup-production-pins.test.ts. Without this, STAGING_PINS can fall behind the
  // committed tree with a fully green suite — which is exactly what happened between 0079 and 0088, and it
  // blocked staging signing entirely (deriveMigrationFacts rejects an endpoint/count mismatch).
  it('pins the actual migration endpoint and count (bump STAGING_PINS when adding a migration)', () => {
    expect(STAGING_PINS.expectedMigrationEndpoint).toBe(sorted[sorted.length - 1]!.migrationTag);
    expect(STAGING_PINS.expectedCommittedMigrationCount).toBe(sorted.length);
  });

  it('never bakes an applied-count fallback (staging supplies it explicitly at signing time)', () => {
    expect(STAGING_PINS.defaultAppliedCount).toBeUndefined();
    expect(STAGING_PINS.requireExplicitAppliedCount).toBe(true);
  });
});

describe('G-Backup staging-receipt producer — happy path (fixture keys)', () => {
  it('signs + self-verifies; pending is exactly 0069–0078 derived from source', () => {
    const out = produceStagingReceipt(goodInputs(), kp.privateKey, STAGING_RUNTIME_DIR, HISTORICAL_STAGING_PINS);
    expect(receiptV2Schema.safeParse(out.receipt).success).toBe(true);
    expect(out.receipt.environment).toBe('staging');
    expect(out.receipt.targetApplication).toBe('king-ai-ops-hub-staging');
    expect(out.receipt.databaseApp).toBe('king-ai-hub-db-staging');
    expect(out.receipt.sourceVolumeId).toBe('vol_4m3kmknl059qpd6v');
    expect(out.derived.endpointTag).toBe(HISTORICAL_STAGING_PINS.expectedMigrationEndpoint);
    expect(out.derived.committedCount).toBe(HISTORICAL_STAGING_PINS.expectedCommittedMigrationCount);
    expect(out.derived.pendingMigrations.map((p) => p.migrationTag)).toEqual(EXPECTED_PENDING_TAGS);
    // Independently re-verify with the derived public trust.
    const load = loadReceiptKeyBundle([out.publicTrustEntry]);
    expect(load.ok).toBe(true);
    if (load.ok) {
      const r = verifyReceiptV2Parsed(out.receipt, buildSelfVerifyExpectation(goodInputs(), out.derived, load.store));
      expect(r.ok).toBe(true);
    }
  });

  it('derived public trust entry carries the deployment-receipt purpose and no private material', () => {
    const entry = derivePublicTrustEntry(kp.privateKey, 'staging-dbr-2026-08');
    expect(entry.purpose).toBe('deployment_backup_receipt');
    expect(entry.algorithm).toBe('ed25519');
    expect(entry.publicKeyPem.includes('PRIVATE KEY')).toBe(false);
    expect(entry.publicKeyPem.includes('PUBLIC KEY')).toBe(true);
  });
});

describe('G-Backup staging-receipt producer — required-input enforcement + placeholder rejection', () => {
  const cases: [string, Partial<StagingReceiptInputs>][] = [
    ['placeholder source commit', { sourceCommit: 'UNKNOWN' }],
    ['empty source commit', { sourceCommit: '' }],
    ['non-hex source commit', { sourceCommit: 'nothex' }],
    ['tag-only (not digest-bound) image', { targetImageRef: 'registry.fly.io/king-ai-ops-hub-staging:deployment-01ABC' }],
    ['digest not matching ref', { targetImageDigest: `sha256:${'b'.repeat(64)}` }],
    ['malformed image digest', { targetImageRef: 'registry.fly.io/king-ai-ops-hub-staging@sha256:zz', targetImageDigest: 'sha256:zz' }],
    ['non-canonical nonce', { deploymentNonce: 'deadbeef' }],
    ['zero system identifier', { databaseSystemIdentifier: '0' }],
    ['non-numeric system identifier', { databaseSystemIdentifier: 'abc' }],
    ['malformed snapshot id', { snapshotId: 'snap-1' }],
    ['retention below minimum', { retentionDays: 3 }],
    ['bad key id', { keyId: 'bad id!' }],
    ['appliedCount out of range', { appliedCount: 999 }],
  ];
  for (const [label, over] of cases) {
    it(`rejects ${label}`, () => {
      expect(() => buildStagingSignedReceipt(goodInputs(over), STAGING_RUNTIME_DIR, HISTORICAL_STAGING_PINS)).toThrow(StagingReceiptInputError);
    });
  }
});

describe('G-Backup staging-receipt producer — hash cross-check + tamper', () => {
  it('rejects an operator-provided portable hash that disagrees with source', () => {
    expect(() => buildStagingSignedReceipt(goodInputs({ assertPortableMigrationSetHash: 'f'.repeat(64) }), STAGING_RUNTIME_DIR, HISTORICAL_STAGING_PINS)).toThrow(StagingReceiptInputError);
  });

  it('a tampered signature fails verification', () => {
    const out = produceStagingReceipt(goodInputs(), kp.privateKey, STAGING_RUNTIME_DIR, HISTORICAL_STAGING_PINS);
    const flipped = out.receipt.signature[0] === 'A' ? 'B' : 'A';
    const tampered = { ...out.receipt, signature: flipped + out.receipt.signature.slice(1) };
    const load = loadReceiptKeyBundle([out.publicTrustEntry]);
    expect(load.ok).toBe(true);
    if (load.ok) {
      const r = verifyReceiptV2Parsed(tampered, buildSelfVerifyExpectation(goodInputs(), out.derived, load.store));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid_signature');
    }
  });

  it('a receipt signed by a DIFFERENT key is not trusted', () => {
    const out = produceStagingReceipt(goodInputs(), kp.privateKey, STAGING_RUNTIME_DIR, HISTORICAL_STAGING_PINS);
    const other = generateKeyPairSync('ed25519');
    const otherTrust = derivePublicTrustEntry(other.privateKey, out.receipt.keyId);
    const load = loadReceiptKeyBundle([otherTrust]);
    expect(load.ok).toBe(true);
    if (load.ok) {
      const r = verifyReceiptV2Parsed(out.receipt, buildSelfVerifyExpectation(goodInputs(), out.derived, load.store));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('invalid_signature');
    }
  });
});

describe('G-Backup staging-receipt producer — no private material can leak into the artifact', () => {
  it('the receipt, trust bundle, and metadata contain no PRIVATE KEY material', () => {
    const out = produceStagingReceipt(goodInputs(), kp.privateKey, STAGING_RUNTIME_DIR, HISTORICAL_STAGING_PINS);
    for (const [label, v] of [
      ['receipt', out.receipt],
      ['trustEntry', out.publicTrustEntry],
    ] as const) {
      expect(() => assertNoPrivateMaterial(label, v)).not.toThrow();
      expect(JSON.stringify(v).includes('PRIVATE KEY')).toBe(false);
    }
  });

  it('assertNoPrivateMaterial throws if a private PEM is present', () => {
    const priv = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(() => assertNoPrivateMaterial('leak', { priv })).toThrow(/private-key material/);
  });
});

describe('G-Backup staging-receipt CLI (fixture key via env) — writes only public files', () => {
  const keyB64 = Buffer.from(kp.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), 'utf8').toString('base64');
  function baseEnv(outDir: string): NodeJS.ProcessEnv {
    return {
      NODE_ENV: 'test',
      GBACKUP_SIGNING_KEY_PEM_B64: keyB64,
      OUTPUT_DIR: outDir,
      SOURCE_DIR: STAGING_RUNTIME_DIR,
      SOURCE_COMMIT: STAGING_SOURCE_COMMIT,
      TARGET_IMAGE_REF: `registry.fly.io/king-ai-ops-hub-staging@${DIGEST}`,
      TARGET_IMAGE_DIGEST: DIGEST,
      DEPLOYMENT_NONCE: 'deadbeefdeadbeefdeadbeefdeadbeef',
      DATABASE_SYSTEM_IDENTIFIER: '7300338420798239475',
      SNAPSHOT_ID: 'vs_abc123',
      SNAPSHOT_REQUESTED_AT: '2026-08-03T12:00:00.000Z',
      SNAPSHOT_CREATED_AT: '2026-08-03T12:00:05.000Z',
      PROVIDER_OBSERVED_AT: '2026-08-03T12:00:10.000Z',
      RECEIPT_CREATED_AT: '2026-08-03T12:00:15.000Z',
      EXPIRES_AT: '2026-08-03T12:30:15.000Z',
      RETENTION_DAYS: '7',
      SNAPSHOT_DISCOVERY_METHOD: 'create-response-id',
      CREATE_RESPONSE_SNAPSHOT_ID: 'vs_abc123',
      KEY_ID: 'staging-dbr-2026-08',
      APPLIED_COUNT: String(STAGING_APPLIED_COUNT),
    };
  }

  it('writes the 3 public files, none containing PRIVATE KEY material', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-receipt-'));
    try {
      runCli(baseEnv(dir), process.cwd(), () => {}, HISTORICAL_CLI_OPTIONS);
      const files = readdirSync(dir).sort();
      expect(files).toEqual(['staging-receipt.v2.json', 'trust-bundle.public.json', 'verification-metadata.json']);
      for (const f of files) {
        const content = readFileSync(join(dir, f), 'utf8');
        expect(content.includes('PRIVATE KEY')).toBe(false);
      }
      const meta = JSON.parse(readFileSync(join(dir, 'verification-metadata.json'), 'utf8'));
      expect(meta.selfVerified).toBe(true);
      expect(meta.pendingMigrationTags).toEqual(EXPECTED_PENDING_TAGS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when APPLIED_COUNT is absent (staging never defaults a migrated prefix; writes nothing)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-receipt-'));
    try {
      const env = baseEnv(dir);
      delete env.APPLIED_COUNT;
      expect(() => runCli(env, process.cwd(), () => {}, HISTORICAL_CLI_OPTIONS)).toThrow(/APPLIED_COUNT/);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the signing key env is absent (and writes nothing)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-receipt-'));
    try {
      const env = baseEnv(dir);
      delete env.GBACKUP_SIGNING_KEY_PEM_B64;
      expect(() => runCli(env, process.cwd(), () => {}, HISTORICAL_CLI_OPTIONS)).toThrow(/signing key/);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a placeholder source commit from env (fails closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-receipt-'));
    try {
      expect(() => runCli({ ...baseEnv(dir), SOURCE_COMMIT: 'UNKNOWN' }, process.cwd(), () => {}, HISTORICAL_CLI_OPTIONS)).toThrow();
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
