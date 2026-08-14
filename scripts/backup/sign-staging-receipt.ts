import { type KeyObject, createPublicKey } from 'node:crypto';
import {
  type PendingMigrationEntry,
  type ReceiptV2,
  type RECEIPT_V2_ENVIRONMENTS,
  type SignedReceiptV2,
  signedReceiptV2Schema,
} from './receipt-v2-schema';
import { finalizeReceiptV2Id, isValidDeploymentNonce, receiptV2CanonicalHash } from './receipt-v2-canonical';
import { signReceiptV2 } from './receipt-v2-sign';
import {
  type ReceiptV2Expectation,
  verifyReceiptV2Parsed,
} from './receipt-v2-verify';
import {
  FLY_VOLUMES_ADAPTER_VERSION,
  FLY_VOLUMES_PROVIDER,
  PROVIDER_RAW_STATUS_CREATED,
  normalizeFlyVolumeSnapshot,
} from './provider-fly-volumes';
import {
  type ReceiptKeyEntry,
  PRIVATE_KEY_MARKER,
  RECEIPT_KEY_PURPOSE,
  loadReceiptKeyBundle,
} from './receipt-key-bundle';
import { readRuntimeMigrationSet } from './runtime-migration-set';
import { buildSourceManifestFromGit } from './source-manifest';

/**
 * G-Backup-B1/B2a — STAGING receipt-v2 PRODUCER (off-machine / CI utility).
 *
 * This is a thin ASSEMBLER over the accepted, already-reviewed receipt-v2 library. It invents NO new key format,
 * canonicalization, or schema: it collects the operator-supplied release facts, DERIVES the migration-set hashes
 * and canonical pending set from the checked-out source (so no hash is hand-copied), assembles a `SignedReceiptV2`,
 * signs it with {@link signReceiptV2}, and self-VERIFIES it with the runtime {@link verifyReceiptV2Parsed}. It only
 * ever emits PUBLIC material (the signed receipt + a public trust-bundle entry + safe metadata); the private key is
 * used to sign and is never serialized, logged, or returned. It performs NO Fly, snapshot, migration, or deploy
 * action — the snapshot facts are inputs, established by the external controller.
 *
 * Immutable staging facts are PINNED here; everything variable (nonce, snapshot id/times, db system id, image
 * digest, source commit) is an input and is rejected if placeholder/malformed.
 */

/**
 * The immutable per-environment release facts a receipt binds (Gate 3). Every producer entry point takes a pins
 * argument DEFAULTING to {@link STAGING_PINS}, so the accepted staging path is byte-identical; the production CLI
 * passes PRODUCTION_PINS (scripts/backup/production-pins.ts) explicitly.
 */
export interface ReleasePins {
  readonly environment: (typeof RECEIPT_V2_ENVIRONMENTS)[number];
  readonly targetApplication: string;
  readonly databaseApp: string;
  readonly sourceVolumeId: string;
  readonly databaseIdentity: string;
  readonly snapshotProvider: typeof FLY_VOLUMES_PROVIDER;
  readonly providerAdapterVersion: typeof FLY_VOLUMES_ADAPTER_VERSION;
  readonly expectedMigrationEndpoint: string;
  readonly expectedCommittedMigrationCount: number;
  readonly defaultAppliedCount: number;
}

export const STAGING_PINS: ReleasePins = {
  environment: 'staging',
  targetApplication: 'king-ai-ops-hub-staging',
  databaseApp: 'king-ai-hub-db-staging',
  sourceVolumeId: 'vol_4m3kmknl059qpd6v',
  databaseIdentity: 'king_ai_ops_hub_staging',
  snapshotProvider: FLY_VOLUMES_PROVIDER,
  providerAdapterVersion: FLY_VOLUMES_ADAPTER_VERSION,
  expectedMigrationEndpoint: '0056_milky_goliath',
  expectedCommittedMigrationCount: 57,
  /** Staging is at migration endpoint 0053 → 54 applied migrations; 0054–0056 are pending. */
  defaultAppliedCount: 54,
} as const;

/** Gate defaults (mirror scripts/migrate.ts buildGateConfigFromEnv): used for the producer's self-verification. */
export const SELF_VERIFY_MIN_RETENTION_DAYS = 7;
export const SELF_VERIFY_MAX_SNAPSHOT_AGE_MS = 30 * 60 * 1000;

const PLACEHOLDERS = new Set(['', 'UNKNOWN', 'unknown', 'PLACEHOLDER', 'placeholder', 'none', 'null', 'TODO']);
const HEX_COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const DIGEST_BOUND_IMAGE = /@sha256:[0-9a-f]{64}$/;
const SNAPSHOT_ID = /^vs_[A-Za-z0-9]+$/;
const KEY_ID = /^[A-Za-z0-9._-]{1,128}$/;
const UINT64_DEC = /^[1-9][0-9]{0,19}$/;

export class StagingReceiptInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StagingReceiptInputError';
  }
}

function reject(field: string, why: string): never {
  throw new StagingReceiptInputError(`${field}: ${why}`);
}
function requirePresent(field: string, v: string | undefined): string {
  if (v === undefined || PLACEHOLDERS.has(v.trim())) reject(field, 'missing or placeholder');
  return v.trim();
}

export type SnapshotDiscoveryInput =
  | { readonly method: 'create-response-id'; readonly createResponseSnapshotId: string; readonly listedSnapshotId: string }
  | {
      readonly method: 'unambiguous-list-diff';
      readonly preRequestSetDigest: string;
      readonly postRequestSetDigest: string;
      readonly candidateCount: number;
      readonly selectedCandidateId: string;
    };

/** Non-secret release facts. The private key is NOT part of this — it is passed separately, only to sign. */
export interface StagingReceiptInputs {
  readonly sourceCommit: string;
  readonly targetImageRef: string;
  readonly targetImageDigest: string;
  readonly deploymentNonce: string;
  readonly databaseSystemIdentifier: string;
  readonly snapshotId: string;
  readonly snapshotRequestedAt: string;
  readonly snapshotCreatedAt: string;
  readonly providerObservedAt: string;
  readonly retentionDays: number;
  readonly storedSizeBytes: number | null;
  readonly receiptCreatedAt: string;
  readonly expiresAt: string;
  readonly keyId: string;
  readonly discovery: SnapshotDiscoveryInput;
  /** How many migrations are already applied to staging (default 54 = endpoint 0053). Pending = the rest. */
  readonly appliedCount: number;
  /** Optional operator-provided hashes; if present they MUST equal the source-derived values (fail-closed). */
  readonly assertPortableMigrationSetHash?: string;
  readonly assertRuntimeMigrationSetHash?: string;
}

/** Derived, source-of-truth migration facts (from the checked-out drizzle tree; no hand-copied hash). */
export interface DerivedMigrationFacts {
  readonly portableMigrationSetHash: string;
  readonly runtimeMigrationSetHash: string;
  readonly pendingMigrations: PendingMigrationEntry[];
  readonly committedCount: number;
  readonly endpointTag: string;
}

/**
 * Where the SELECTED application source is read from. The runtime migration files come from a DATA-ONLY checkout
 * of the selected commit (`runtimeDir`); the portable Git-blob hash is read from that commit's blobs via the
 * TRUSTED workspace's git (`gitCommitish`, which the trusted checkout has in history as an ancestor of main). The
 * signer code itself always runs from the trusted workflow checkout — never from `runtimeDir`.
 */
export interface SourceLocation {
  readonly runtimeDir: string;
  readonly gitCommitish: string;
}

/** Derive the portable + runtime migration-set hashes and the canonical pending set from the selected source. */
export function deriveMigrationFacts(source: SourceLocation, appliedCount: number, pins: ReleasePins = STAGING_PINS): DerivedMigrationFacts {
  const runtime = readRuntimeMigrationSet(source.runtimeDir, 'drizzle');
  const sorted = [...runtime.entries].sort((a, b) => a.migrationIndex - b.migrationIndex);
  const committedCount = sorted.length;
  const endpointTag = sorted[committedCount - 1]?.migrationTag ?? '';
  if (endpointTag !== pins.expectedMigrationEndpoint) {
    reject('source', `migration endpoint ${JSON.stringify(endpointTag)} != pinned ${pins.expectedMigrationEndpoint}`);
  }
  if (committedCount !== pins.expectedCommittedMigrationCount) {
    reject('source', `committed migration count ${committedCount} != pinned ${pins.expectedCommittedMigrationCount}`);
  }
  if (!Number.isInteger(appliedCount) || appliedCount < 0 || appliedCount > committedCount) {
    reject('appliedCount', `must be an integer in [0, ${committedCount}]`);
  }
  const portableMigrationSetHash = buildSourceManifestFromGit(source.gitCommitish, 'drizzle').sourceMigrationSetHash;
  const pendingMigrations: PendingMigrationEntry[] = sorted
    .filter((e) => e.migrationIndex >= appliedCount)
    .map((e) => ({
      migrationIndex: e.migrationIndex,
      migrationTag: e.migrationTag,
      migrationPath: e.migrationPath,
      byteLength: e.byteLength,
      sha256: e.sha256,
    }));
  return { portableMigrationSetHash, runtimeMigrationSetHash: runtime.runtimeMigrationSetHash, pendingMigrations, committedCount, endpointTag };
}

/** Validate operator inputs against canonical formats + placeholder rejection + digest-bound image ref. */
export function validateStagingInputs(inputs: StagingReceiptInputs): void {
  const commit = requirePresent('sourceCommit', inputs.sourceCommit);
  if (!HEX_COMMIT.test(commit)) reject('sourceCommit', 'not a 40/64-hex commit');
  const ref = requirePresent('targetImageRef', inputs.targetImageRef);
  if (!DIGEST_BOUND_IMAGE.test(ref)) reject('targetImageRef', 'must be digest-bound (…@sha256:<64hex>)');
  const digest = requirePresent('targetImageDigest', inputs.targetImageDigest);
  if (!IMAGE_DIGEST.test(digest)) reject('targetImageDigest', 'not a sha256:<64hex> digest');
  if (!ref.endsWith(`@${digest}`)) reject('targetImageDigest', 'does not match the digest bound into targetImageRef');
  const nonce = requirePresent('deploymentNonce', inputs.deploymentNonce);
  if (!isValidDeploymentNonce(nonce)) reject('deploymentNonce', 'not a canonical 128-bit nonce (hex32 or base64url22)');
  const sysId = requirePresent('databaseSystemIdentifier', inputs.databaseSystemIdentifier);
  if (!UINT64_DEC.test(sysId)) reject('databaseSystemIdentifier', 'not a nonzero canonical uint64 decimal');
  const snap = requirePresent('snapshotId', inputs.snapshotId);
  if (!SNAPSHOT_ID.test(snap)) reject('snapshotId', 'not a vs_… snapshot id');
  const keyId = requirePresent('keyId', inputs.keyId);
  if (!KEY_ID.test(keyId)) reject('keyId', 'not a valid key id');
  if (!Number.isInteger(inputs.retentionDays) || inputs.retentionDays < SELF_VERIFY_MIN_RETENTION_DAYS) {
    reject('retentionDays', `must be an integer ≥ ${SELF_VERIFY_MIN_RETENTION_DAYS}`);
  }
}

/** Derive the PUBLIC trust-bundle entry from the private key (public material only; never emits private bytes). */
export function derivePublicTrustEntry(privateKey: KeyObject, keyId: string): ReceiptKeyEntry {
  if (privateKey.asymmetricKeyType !== 'ed25519') reject('signingKey', 'not an ed25519 key');
  // Derive the PUBLIC key from the private one. The intermediate private PEM is transient (never logged/written);
  // the emitted entry carries only the SPKI PUBLIC key.
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const publicKeyPem = createPublicKey({ key: privatePem, format: 'pem' }).export({ type: 'spki', format: 'pem' }).toString();
  if (publicKeyPem.includes(PRIVATE_KEY_MARKER)) reject('signingKey', 'derived public PEM unexpectedly contains private marker');
  return { keyId, algorithm: 'ed25519', publicKeyPem, purpose: RECEIPT_KEY_PURPOSE, status: 'active' };
}

/**
 * Assemble + schema-validate + finalize the receipt id (PURE; no signing, no key). The migration facts are derived
 * from the SELECTED source: runtime files from `runtimeDir` (a data-only checkout of `inputs.sourceCommit`) and the
 * portable Git-blob hash from `inputs.sourceCommit` in the trusted workspace's git — so the receipt binds the exact
 * selected application source, and the commit used for derivation is identical to the commit written into the receipt.
 */
export function buildStagingSignedReceipt(inputs: StagingReceiptInputs, runtimeDir: string, pins: ReleasePins = STAGING_PINS): { signed: SignedReceiptV2; derived: DerivedMigrationFacts } {
  validateStagingInputs(inputs);
  const derived = deriveMigrationFacts({ runtimeDir, gitCommitish: inputs.sourceCommit }, inputs.appliedCount, pins);
  if (inputs.assertPortableMigrationSetHash && inputs.assertPortableMigrationSetHash !== derived.portableMigrationSetHash) {
    reject('portableMigrationSetHash', 'operator-provided value does not match the source-derived value');
  }
  if (inputs.assertRuntimeMigrationSetHash && inputs.assertRuntimeMigrationSetHash !== derived.runtimeMigrationSetHash) {
    reject('runtimeMigrationSetHash', 'operator-provided value does not match the source-derived value');
  }

  // Normalize provider evidence (reuses the accepted adapter; enforces requested ≤ created ≤ observed timeline).
  const discoveryEvidence =
    inputs.discovery.method === 'create-response-id'
      ? { createResponseSnapshotId: inputs.discovery.createResponseSnapshotId, listedSnapshotId: inputs.discovery.listedSnapshotId }
      : {
          preRequestSetDigest: inputs.discovery.preRequestSetDigest,
          postRequestSetDigest: inputs.discovery.postRequestSetDigest,
          candidateCount: inputs.discovery.candidateCount,
          selectedCandidateId: inputs.discovery.selectedCandidateId,
        };
  const norm = normalizeFlyVolumeSnapshot(
    {
      id: inputs.snapshotId,
      status: PROVIDER_RAW_STATUS_CREATED,
      volumeId: pins.sourceVolumeId,
      databaseApp: pins.databaseApp,
      createdAt: inputs.snapshotCreatedAt,
      retentionDays: inputs.retentionDays,
      ...(inputs.storedSizeBytes != null ? { storedSizeBytes: inputs.storedSizeBytes } : {}),
    },
    {
      snapshotRequestedAt: inputs.snapshotRequestedAt,
      providerObservedAt: inputs.providerObservedAt,
      snapshotDiscoveryMethod: inputs.discovery.method,
      discoveryEvidence,
    },
  );
  const e = norm.evidence;

  const signed = finalizeReceiptV2Id({
    schemaVersion: '2',
    canonicalizationVersion: 1,
    receiptId: `rcpt2_${'0'.repeat(64)}`,
    environment: pins.environment,
    targetApplication: pins.targetApplication,
    databaseApp: pins.databaseApp,
    sourceVolumeId: pins.sourceVolumeId,
    databaseSystemIdentifier: inputs.databaseSystemIdentifier,
    snapshotProvider: 'fly-volumes',
    providerSnapshotStatus: e.providerSnapshotStatus,
    canonicalSnapshotStatus: 'complete',
    snapshotDiscoveryMethod: inputs.discovery.method,
    snapshotDiscoveryEvidence: discoveryEvidence,
    snapshotId: e.snapshotId,
    snapshotRequestedAt: e.snapshotRequestedAt,
    snapshotCreatedAt: e.snapshotCreatedAt,
    providerObservedAt: e.providerObservedAt,
    retentionDays: inputs.retentionDays,
    storedSizeBytes: inputs.storedSizeBytes,
    normalizedProviderEvidenceDigest: norm.normalizedProviderEvidenceDigest,
    providerAdapterVersion: pins.providerAdapterVersion,
    sourceCommit: inputs.sourceCommit,
    targetImageRef: inputs.targetImageRef,
    targetImageDigest: inputs.targetImageDigest,
    deploymentNonce: inputs.deploymentNonce,
    portableMigrationSetHash: derived.portableMigrationSetHash,
    runtimeMigrationSetHash: derived.runtimeMigrationSetHash,
    pendingMigrations: derived.pendingMigrations,
    receiptCreatedAt: inputs.receiptCreatedAt,
    expiresAt: inputs.expiresAt,
    signatureAlgorithm: 'ed25519',
    keyId: inputs.keyId,
  });

  const check = signedReceiptV2Schema.safeParse(signed);
  if (!check.success) reject('receipt', `assembled receipt fails schema: ${check.error.issues[0]?.message ?? 'invalid'}`);
  return { signed, derived };
}

export interface StagingReceiptOutput {
  readonly receipt: ReceiptV2;
  readonly canonicalHash: string;
  readonly publicTrustEntry: ReceiptKeyEntry;
  readonly derived: DerivedMigrationFacts;
}

/**
 * Build the self-verification expectation — the SAME shape the release gate constructs — so producing a receipt
 * exercises the exact runtime verifier. `keyStore` must be a trust store loaded from the derived public entry.
 */
export function buildSelfVerifyExpectation(
  inputs: StagingReceiptInputs,
  derived: DerivedMigrationFacts,
  keyStore: ReceiptV2Expectation['keyStore'],
  pins: ReleasePins = STAGING_PINS,
): ReceiptV2Expectation {
  return {
    environment: pins.environment,
    allowProductionEnvironment: pins.environment === 'production',
    targetApplication: pins.targetApplication,
    databaseApp: pins.databaseApp,
    sourceVolumeId: pins.sourceVolumeId,
    databaseSystemIdentifier: inputs.databaseSystemIdentifier,
    snapshotProvider: FLY_VOLUMES_PROVIDER,
    providerAdapterVersion: pins.providerAdapterVersion,
    minRetentionDays: SELF_VERIFY_MIN_RETENTION_DAYS,
    maxSnapshotAgeMs: SELF_VERIFY_MAX_SNAPSHOT_AGE_MS,
    sourceCommit: inputs.sourceCommit,
    targetImageRef: inputs.targetImageRef,
    deploymentNonce: inputs.deploymentNonce,
    portableMigrationSetHash: derived.portableMigrationSetHash,
    runtimeMigrationSetHash: derived.runtimeMigrationSetHash,
    pendingMigrations: derived.pendingMigrations,
    migrationStartedAt: new Date(Date.parse(inputs.receiptCreatedAt) + 1000),
    supportedSchemaVersions: new Set(['2']),
    supportedAlgorithms: new Set(['ed25519']),
    keyStore,
  };
}

/** Build → sign → self-verify. Returns ONLY public material. Throws if verification does not pass. */
export function produceStagingReceipt(inputs: StagingReceiptInputs, privateKey: KeyObject, runtimeDir: string, pins: ReleasePins = STAGING_PINS): StagingReceiptOutput {
  const publicTrustEntry = derivePublicTrustEntry(privateKey, inputs.keyId);
  const { signed, derived } = buildStagingSignedReceipt(inputs, runtimeDir, pins);
  const receipt = signReceiptV2(signed, privateKey);
  const canonicalHash = receiptV2CanonicalHash(signed);

  // Self-verify with the runtime verifier + the derived public trust — the SAME code path the release gate runs.
  const keyLoad = loadReceiptKeyBundle([publicTrustEntry]);
  if (!keyLoad.ok) throw new Error(`derived public trust bundle failed to load: ${keyLoad.code}`);
  const exp = buildSelfVerifyExpectation(inputs, derived, keyLoad.store, pins);
  const result = verifyReceiptV2Parsed(receipt, exp);
  if (!result.ok) throw new Error(`self-verification failed at step ${result.step} (${result.code}): ${result.detail}`);
  return { receipt, canonicalHash, publicTrustEntry, derived };
}

/**
 * A safety scan: the string form of any artifact we emit MUST NOT contain private-key material. Fail-closed so a
 * refactor can never leak the signer into an uploaded artifact or a log line.
 */
export function assertNoPrivateMaterial(label: string, value: unknown): void {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (s.includes(PRIVATE_KEY_MARKER)) throw new Error(`${label} unexpectedly contains private-key material`);
}

/** PUBLIC verification metadata (safe to publish alongside the receipt). Never carries secret/private material. */
export function buildVerificationMetadata(out: StagingReceiptOutput): Record<string, unknown> {
  return {
    receiptId: out.receipt.receiptId,
    canonicalHash: out.canonicalHash,
    keyId: out.receipt.keyId,
    environment: out.receipt.environment,
    targetApplication: out.receipt.targetApplication,
    databaseApp: out.receipt.databaseApp,
    sourceVolumeId: out.receipt.sourceVolumeId,
    sourceCommit: out.receipt.sourceCommit,
    targetImageRef: out.receipt.targetImageRef,
    targetImageDigest: out.receipt.targetImageDigest,
    deploymentNonce: out.receipt.deploymentNonce,
    portableMigrationSetHash: out.receipt.portableMigrationSetHash,
    runtimeMigrationSetHash: out.receipt.runtimeMigrationSetHash,
    pendingMigrationTags: out.derived.pendingMigrations.map((p) => p.migrationTag),
    committedMigrationCount: out.derived.committedCount,
    migrationEndpoint: out.derived.endpointTag,
    selfVerified: true,
  };
}
