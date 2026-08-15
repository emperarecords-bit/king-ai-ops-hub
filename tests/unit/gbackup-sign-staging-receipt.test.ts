import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from '../../scripts/ci/sign-staging-receipt';
import {
  type StagingReceiptInputs,
  STAGING_PINS,
  StagingReceiptInputError,
  assertNoPrivateMaterial,
  buildSelfVerifyExpectation,
  buildStagingSignedReceipt,
  derivePublicTrustEntry,
  produceStagingReceipt,
} from '../../scripts/backup/sign-staging-receipt';
import { receiptV2Schema } from '../../scripts/backup/receipt-v2-schema';
import { loadReceiptKeyBundle } from '../../scripts/backup/receipt-key-bundle';
import { verifyReceiptV2Parsed } from '../../scripts/backup/receipt-v2-verify';

/**
 * G-Backup staging-receipt producer — tests use EPHEMERAL, NON-PRODUCTION ed25519 keys generated in-process. No real
 * signer, GitHub secret, Fly, snapshot, migration, or deploy is involved. Migration facts are DERIVED from the
 * checked-out drizzle tree, so this proves the assembler binds to the real 0000–0064 source set.
 */

const kp = generateKeyPairSync('ed25519');
// The migration facts are derived from a REAL commit (the portable hash reads git blobs at sourceCommit), so the
// tests bind the actual checked-out HEAD — the same code path the workflow runs against the selected source commit.
// The staged source identity moved to 0064 with the 2026-08-15 Employee Chat release (EV-011).
// A moving HEAD must not redefine it — the exact release commit is pinned here.
const STAGING_SOURCE_COMMIT = execFileSync(
  'git', ['rev-parse', '641d32f1ba28597deabc4f6e7f40dd034c4d9e99^{commit}'], { encoding: 'utf8' },
).trim();
const STAGING_RUNTIME_DIR = mkdtempSync(join(tmpdir(), 'staging-source-0064-'));
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
    appliedCount: STAGING_PINS.defaultAppliedCount,
    ...over,
  };
}

describe('G-Backup staging-receipt producer — happy path (fixture keys)', () => {
  it('signs + self-verifies; pending is exactly 0064 derived from source', () => {
    const out = produceStagingReceipt(goodInputs(), kp.privateKey, STAGING_RUNTIME_DIR);
    expect(receiptV2Schema.safeParse(out.receipt).success).toBe(true);
    expect(out.receipt.environment).toBe('staging');
    expect(out.receipt.targetApplication).toBe('king-ai-ops-hub-staging');
    expect(out.receipt.databaseApp).toBe('king-ai-hub-db-staging');
    expect(out.receipt.sourceVolumeId).toBe('vol_4m3kmknl059qpd6v');
    expect(out.derived.endpointTag).toBe('0064_employee_chat');
    expect(out.derived.committedCount).toBe(65);
    expect(out.derived.pendingMigrations.map((p) => p.migrationTag)).toEqual(['0064_employee_chat']);
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
      expect(() => buildStagingSignedReceipt(goodInputs(over), STAGING_RUNTIME_DIR)).toThrow(StagingReceiptInputError);
    });
  }
});

describe('G-Backup staging-receipt producer — hash cross-check + tamper', () => {
  it('rejects an operator-provided portable hash that disagrees with source', () => {
    expect(() => buildStagingSignedReceipt(goodInputs({ assertPortableMigrationSetHash: 'f'.repeat(64) }), STAGING_RUNTIME_DIR)).toThrow(StagingReceiptInputError);
  });

  it('a tampered signature fails verification', () => {
    const out = produceStagingReceipt(goodInputs(), kp.privateKey, STAGING_RUNTIME_DIR);
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
    const out = produceStagingReceipt(goodInputs(), kp.privateKey, STAGING_RUNTIME_DIR);
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
    const out = produceStagingReceipt(goodInputs(), kp.privateKey, STAGING_RUNTIME_DIR);
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
      APPLIED_COUNT: '64',
    };
  }

  it('writes the 3 public files, none containing PRIVATE KEY material', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-receipt-'));
    try {
      runCli(baseEnv(dir), process.cwd(), () => {});
      const files = readdirSync(dir).sort();
      expect(files).toEqual(['staging-receipt.v2.json', 'trust-bundle.public.json', 'verification-metadata.json']);
      for (const f of files) {
        const content = readFileSync(join(dir, f), 'utf8');
        expect(content.includes('PRIVATE KEY')).toBe(false);
      }
      const meta = JSON.parse(readFileSync(join(dir, 'verification-metadata.json'), 'utf8'));
      expect(meta.selfVerified).toBe(true);
      expect(meta.pendingMigrationTags).toEqual(['0064_employee_chat']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the signing key env is absent (and writes nothing)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-receipt-'));
    try {
      const env = baseEnv(dir);
      delete env.GBACKUP_SIGNING_KEY_PEM_B64;
      expect(() => runCli(env, process.cwd(), () => {})).toThrow(/signing key/);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a placeholder source commit from env (fails closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'staging-receipt-'));
    try {
      expect(() => runCli({ ...baseEnv(dir), SOURCE_COMMIT: 'UNKNOWN' }, process.cwd(), () => {})).toThrow();
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
