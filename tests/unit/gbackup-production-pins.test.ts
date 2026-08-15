import { execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_PINS } from '../../scripts/backup/production-pins';
import {
  STAGING_PINS,
  type StagingReceiptInputs,
  buildSelfVerifyExpectation,
  deriveMigrationFacts,
  produceStagingReceipt,
} from '../../scripts/backup/sign-staging-receipt';
import { loadReceiptKeyBundle } from '../../scripts/backup/receipt-key-bundle';
import { verifyReceiptV2Parsed } from '../../scripts/backup/receipt-v2-verify';
import { readRuntimeMigrationSet } from '../../scripts/backup/runtime-migration-set';

/**
 * Gate 3 — production release pins. Three jobs:
 *  1. CONSISTENCY TRIPWIRE: the pinned migration endpoint/count must equal the repository's ACTUAL migration set,
 *     so adding a migration fails CI here until production-pins.ts is consciously updated in a reviewed PR.
 *  2. END-TO-END: the shared producer, given PRODUCTION_PINS and an ephemeral key, signs and SELF-VERIFIES a
 *     production-environment receipt over the real repository source — zero network, zero real-key material.
 *  3. FAIL-CLOSED DEFAULT: without the explicit `allowProductionEnvironment` opt-in, the verifier still rejects a
 *     production receipt (`production_rejected`) — the pre-Gate-3 exclusion is the default, not a memory.
 */

const HEAVY_TIMEOUT = 60_000; // portable git-blob manifest + runtime hashing over 61 migrations is disk/git-bound

function makeInputs(sourceCommit: string, nonceByte: string, snapshotId: string): StagingReceiptInputs {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const digest = `sha256:${nonceByte.repeat(32)}`;
  return {
    sourceCommit,
    targetImageRef: `registry.fly.io/king-ai-ops-hub-prod@${digest}`,
    targetImageDigest: digest,
    deploymentNonce: nonceByte.repeat(16),
    databaseSystemIdentifier: '7673854635852591781',
    snapshotId,
    snapshotRequestedAt: iso(now - 300_000),
    snapshotCreatedAt: iso(now - 240_000),
    providerObservedAt: iso(now - 180_000),
    retentionDays: 30,
    storedSizeBytes: null,
    receiptCreatedAt: iso(now),
    expiresAt: iso(now + 3_600_000),
    keyId: 'prod-dbr-2026-08',
    discovery: { method: 'create-response-id', createResponseSnapshotId: snapshotId, listedSnapshotId: snapshotId },
    appliedCount: PRODUCTION_PINS.defaultAppliedCount,
  };
}

describe('production pins — consistency with the repository', () => {
  const runtime = readRuntimeMigrationSet(process.cwd(), 'drizzle');
  const sorted = [...runtime.entries].sort((a, b) => a.migrationIndex - b.migrationIndex);

  it('pins the actual migration endpoint and count (bump production-pins.ts when adding a migration)', () => {
    expect(PRODUCTION_PINS.expectedMigrationEndpoint).toBe(sorted[sorted.length - 1]!.migrationTag);
    expect(PRODUCTION_PINS.expectedCommittedMigrationCount).toBe(sorted.length);
  });

  it('is unmistakably production and distinct from staging in every identity field', () => {
    expect(PRODUCTION_PINS.environment).toBe('production');
    for (const field of ['targetApplication', 'databaseApp', 'sourceVolumeId', 'databaseIdentity'] as const) {
      expect(PRODUCTION_PINS[field], field).not.toBe(STAGING_PINS[field]);
      expect(PRODUCTION_PINS[field].length).toBeGreaterThan(0);
    }
    // Production deployed through 0062 on 2026-08-15 (63 applied); the default applied
    // count must never exceed the committed set (that would mean a pin typo).
    expect(PRODUCTION_PINS.defaultAppliedCount).toBe(63);
    expect(PRODUCTION_PINS.defaultAppliedCount).toBeLessThanOrEqual(PRODUCTION_PINS.expectedCommittedMigrationCount);
  });
});

describe('production pins — the shared producer signs + self-verifies a production receipt', () => {
  const head = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();

  it('produces a verified production-environment receipt over the real source with an ephemeral key', { timeout: HEAVY_TIMEOUT }, () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const out = produceStagingReceipt(makeInputs(head, 'ab', 'vs_testpins0001'), privateKey, process.cwd(), PRODUCTION_PINS);

    expect(out.receipt.environment).toBe('production');
    expect(out.receipt.targetApplication).toBe('king-ai-ops-hub-prod');
    expect(out.receipt.sourceVolumeId).toBe('vol_vlye16958n6x6ed4');
    expect(out.receipt.keyId).toBe('prod-dbr-2026-08');
    // Pending set = committed set minus what production has already applied.
    expect(out.derived.pendingMigrations.length).toBe(
      PRODUCTION_PINS.expectedCommittedMigrationCount - PRODUCTION_PINS.defaultAppliedCount,
    );
    expect(out.derived.endpointTag).toBe(PRODUCTION_PINS.expectedMigrationEndpoint);
    // Self-verification already ran inside produceStagingReceipt (it throws on failure) — reaching here IS the proof.
    expect(out.publicTrustEntry.purpose).toBe('deployment_backup_receipt');
  });

  it('the verifier still rejects a production receipt when the explicit opt-in flag is absent (fail-closed default)', { timeout: HEAVY_TIMEOUT }, () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const inputs = makeInputs(head, 'cd', 'vs_testpins0002');
    const out = produceStagingReceipt(inputs, privateKey, process.cwd(), PRODUCTION_PINS);
    const keyLoad = loadReceiptKeyBundle([out.publicTrustEntry]);
    if (!keyLoad.ok) throw new Error('trust load failed');
    const exp = {
      ...buildSelfVerifyExpectation(inputs, deriveMigrationFacts({ runtimeDir: process.cwd(), gitCommitish: head }, PRODUCTION_PINS.defaultAppliedCount, PRODUCTION_PINS), keyLoad.store, PRODUCTION_PINS),
      allowProductionEnvironment: false,
    };
    const result = verifyReceiptV2Parsed(out.receipt, exp);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('production_rejected');
  });
});
