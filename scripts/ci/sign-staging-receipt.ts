import { type KeyObject, createPrivateKey } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type SnapshotDiscoveryInput,
  type StagingReceiptInputs,
  SELF_VERIFY_MIN_RETENTION_DAYS,
  STAGING_PINS,
  StagingReceiptInputError,
  assertNoPrivateMaterial,
  buildVerificationMetadata,
  produceStagingReceipt,
} from '../backup/sign-staging-receipt';
import { PRIVATE_KEY_MARKER } from '../backup/receipt-key-bundle';

/**
 * CLI wrapper (invoked by the manual GitHub Actions workflow) around the PURE staging-receipt producer in
 * scripts/backup/sign-staging-receipt.ts. This file is the ONLY one that touches the private key + the filesystem:
 * it materializes the key from env (never the argv/inputs), signs + self-verifies via the pure module, and writes
 * ONLY the signed receipt + public trust bundle + safe metadata. The private key is never written or logged.
 */

function requireEnv(name: string, v: string | undefined): string {
  if (v === undefined || v.trim() === '') throw new StagingReceiptInputError(`${name}: missing`);
  return v.trim();
}

function loadPrivateKeyFromEnv(env: NodeJS.ProcessEnv): KeyObject {
  const b64 = env.GBACKUP_SIGNING_KEY_PEM_B64;
  const raw = env.GBACKUP_SIGNING_KEY_PEM;
  let pem: string;
  if (b64 && b64.trim().length > 0) pem = Buffer.from(b64, 'base64').toString('utf8');
  else if (raw && raw.trim().length > 0) pem = raw;
  else throw new StagingReceiptInputError('signing key: set GBACKUP_SIGNING_KEY_PEM_B64 (preferred) or GBACKUP_SIGNING_KEY_PEM');
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    // Never echo the PEM in the error surface.
    throw new StagingReceiptInputError('signing key: not a valid private key PEM');
  }
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new StagingReceiptInputError('signing key: must be an ed25519 PRIVATE key (PKCS#8 PEM)');
  }
  return key;
}

function optInt(v: string | undefined): number | undefined {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

export function inputsFromEnv(env: NodeJS.ProcessEnv): StagingReceiptInputs {
  const method = requireEnv('SNAPSHOT_DISCOVERY_METHOD', env.SNAPSHOT_DISCOVERY_METHOD);
  let discovery: SnapshotDiscoveryInput;
  if (method === 'create-response-id') {
    const id = requireEnv('CREATE_RESPONSE_SNAPSHOT_ID', env.CREATE_RESPONSE_SNAPSHOT_ID);
    discovery = { method: 'create-response-id', createResponseSnapshotId: id, listedSnapshotId: id };
  } else if (method === 'unambiguous-list-diff') {
    discovery = {
      method: 'unambiguous-list-diff',
      preRequestSetDigest: requireEnv('PRE_REQUEST_SET_DIGEST', env.PRE_REQUEST_SET_DIGEST),
      postRequestSetDigest: requireEnv('POST_REQUEST_SET_DIGEST', env.POST_REQUEST_SET_DIGEST),
      candidateCount: 1,
      selectedCandidateId: requireEnv('SNAPSHOT_ID', env.SNAPSHOT_ID),
    };
  } else {
    throw new StagingReceiptInputError('SNAPSHOT_DISCOVERY_METHOD: must be create-response-id or unambiguous-list-diff');
  }
  const stored = optInt(env.STORED_SIZE_BYTES);
  const applied = optInt(env.APPLIED_COUNT);
  return {
    sourceCommit: env.SOURCE_COMMIT ?? '',
    targetImageRef: env.TARGET_IMAGE_REF ?? '',
    targetImageDigest: env.TARGET_IMAGE_DIGEST ?? '',
    deploymentNonce: env.DEPLOYMENT_NONCE ?? '',
    databaseSystemIdentifier: env.DATABASE_SYSTEM_IDENTIFIER ?? '',
    snapshotId: env.SNAPSHOT_ID ?? '',
    snapshotRequestedAt: env.SNAPSHOT_REQUESTED_AT ?? '',
    snapshotCreatedAt: env.SNAPSHOT_CREATED_AT ?? '',
    providerObservedAt: env.PROVIDER_OBSERVED_AT ?? '',
    retentionDays: optInt(env.RETENTION_DAYS) ?? SELF_VERIFY_MIN_RETENTION_DAYS,
    storedSizeBytes: stored === undefined ? null : stored,
    receiptCreatedAt: env.RECEIPT_CREATED_AT ?? '',
    expiresAt: env.EXPIRES_AT ?? '',
    keyId: env.KEY_ID ?? '',
    discovery,
    appliedCount: applied === undefined ? STAGING_PINS.defaultAppliedCount : applied,
    assertPortableMigrationSetHash: env.ASSERT_PORTABLE_MIGRATION_SET_HASH || undefined,
    assertRuntimeMigrationSetHash: env.ASSERT_RUNTIME_MIGRATION_SET_HASH || undefined,
  };
}

export function runCli(env: NodeJS.ProcessEnv, trustedDir: string, log: (m: string) => void = console.log): void {
  const outDir = env.OUTPUT_DIR ?? join(trustedDir, 'receipt-out');
  // The SELECTED application source is a DATA-ONLY checkout (SOURCE_DIR). We read only its migration files from it;
  // the reviewed signer/verifier code runs from the trusted workspace (this process's cwd = trustedDir), and the
  // portable Git-blob hash is read from inputs.sourceCommit in the trusted workspace's git. Default to trustedDir so
  // local/test invocation (where the trusted checkout IS the selected source) still works.
  const sourceDir = env.SOURCE_DIR && env.SOURCE_DIR.trim().length > 0 ? env.SOURCE_DIR : trustedDir;
  const privateKey = loadPrivateKeyFromEnv(env);
  const inputs = inputsFromEnv(env);
  const out = produceStagingReceipt(inputs, privateKey, sourceDir);

  const receiptJson = JSON.stringify(out.receipt, null, 2);
  const trustBundleJson = JSON.stringify([out.publicTrustEntry], null, 2);
  const metadata = buildVerificationMetadata(out);

  // Fail-closed: never let private material reach an emitted file.
  assertNoPrivateMaterial('signed receipt', receiptJson);
  assertNoPrivateMaterial('trust bundle', trustBundleJson);
  assertNoPrivateMaterial('metadata', metadata);

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'staging-receipt.v2.json'), receiptJson + '\n', 'utf8');
  writeFileSync(join(outDir, 'trust-bundle.public.json'), trustBundleJson + '\n', 'utf8');
  writeFileSync(join(outDir, 'verification-metadata.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8');

  log(`Signed + self-verified staging receipt ${out.receipt.receiptId}`);
  log(`  canonicalHash=${out.canonicalHash}`);
  log(`  keyId=${out.receipt.keyId} pending=[${out.derived.pendingMigrations.map((p) => p.migrationTag).join(', ')}] endpoint=${out.derived.endpointTag}`);
  log(`  wrote receipt + public trust bundle + metadata to ${outDir} (private key NOT written)`);
}

// Execute only when run directly as the CLI script (not when imported by tests).
const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
if (/scripts\/ci\/sign-staging-receipt\.(ts|js|mjs)$/.test(entry)) {
  try {
    runCli(process.env, process.cwd());
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[sign-staging-receipt] FAILED: ${msg.includes(PRIVATE_KEY_MARKER) ? '<redacted>' : msg}`);
    process.exit(1);
  }
}
