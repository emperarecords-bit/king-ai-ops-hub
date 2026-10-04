import { readFileSync, writeFileSync } from 'node:fs';
import {
  type ReleasePins,
  STAGING_PINS,
  StagingReceiptInputError,
  buildSelfVerifyExpectation,
  deriveMigrationFacts,
} from '../backup/sign-staging-receipt';
import { inputsFromEnv } from './sign-staging-receipt';
import { loadReceiptKeyBundle } from '../backup/receipt-key-bundle';
import {
  DEFAULT_RECEIPT_TRANSPORT_MAX_BYTES,
  DEFAULT_RECEIPT_TRANSPORT_TIMEOUT_MS,
  type ReceiptFetcher,
  type TransportControls,
  createHttpsReceiptFetcher,
} from '../backup/receipt-transport';
import { type S3Config } from '../backup/s3-sigv4';
import {
  type PublishReceiptResult,
  type ReceiptObjectStore,
  ReceiptPublishError,
  createS3ReceiptObjectStore,
  publishSignedReceiptV2,
} from '../backup/publish-receipt';

/**
 * G-Backup — STAGING receipt PUBLISH CLI (the deployment-control step the signer workflow deliberately skips).
 *
 * It takes the ALREADY-SIGNED receipt artifact and publishes it, create-only, to the gate's deterministic HTTPS
 * locator, then re-fetches + re-verifies it anonymously — the thin wrapper over the reviewed pure publisher in
 * scripts/backup/publish-receipt.ts. It is a CONSUMER: it never holds the Ed25519 signing key.
 *
 * It rebuilds the trusted release EXPECTATION the SAME way the signer/gate do — reading the release facts from the
 * environment (shared `inputsFromEnv`), independently deriving the migration set from the checked-out source
 * (`deriveMigrationFacts`), and loading the public trust bundle — so the receipt is verified against
 * independently-recomputed facts, never against itself. Like the sign CLI, it runs from the repo checkout.
 *
 * The receipt-store credential is a DEDICATED, least-privilege key under its OWN `GBACKUP_RECEIPT_S3_*` names, never
 * the application document/VER-002 bucket credential (`AWS_*`/`S3_*`).
 */

function requireEnv(name: string, v: string | undefined): string {
  if (v === undefined || v.trim() === '') throw new StagingReceiptInputError(`${name}: missing`);
  return v.trim();
}

function intEnv(v: string | undefined, dflt: number): number {
  if (v === undefined || v.trim() === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new StagingReceiptInputError(`expected a non-negative integer, got ${JSON.stringify(v)}`);
  return n;
}

function parseHostAllowlist(v: string): ReadonlySet<string> {
  const hosts = v.split(',').map((h) => h.trim()).filter((h) => h.length > 0);
  if (hosts.length === 0) throw new StagingReceiptInputError('GBACKUP_RECEIPT_HOSTS: no hosts');
  return new Set(hosts);
}

export function buildControls(env: NodeJS.ProcessEnv): TransportControls {
  return {
    maxBytes: intEnv(env.GBACKUP_TRANSPORT_MAX_BYTES, DEFAULT_RECEIPT_TRANSPORT_MAX_BYTES),
    timeoutMs: intEnv(env.GBACKUP_TRANSPORT_TIMEOUT_MS, DEFAULT_RECEIPT_TRANSPORT_TIMEOUT_MS),
    hostAllowlist: parseHostAllowlist(requireEnv('GBACKUP_RECEIPT_HOSTS', env.GBACKUP_RECEIPT_HOSTS)),
  };
}

/** The DEDICATED receipt-publish S3 credential — distinct from the app `AWS_*`/`S3_*` document-store credential. */
function buildReceiptS3Config(env: NodeJS.ProcessEnv): S3Config {
  return {
    endpoint: requireEnv('GBACKUP_RECEIPT_S3_ENDPOINT', env.GBACKUP_RECEIPT_S3_ENDPOINT).replace(/\/+$/, ''),
    region: requireEnv('GBACKUP_RECEIPT_S3_REGION', env.GBACKUP_RECEIPT_S3_REGION),
    bucket: requireEnv('GBACKUP_RECEIPT_S3_BUCKET', env.GBACKUP_RECEIPT_S3_BUCKET),
    accessKeyId: requireEnv('GBACKUP_RECEIPT_S3_ACCESS_KEY_ID', env.GBACKUP_RECEIPT_S3_ACCESS_KEY_ID),
    secretAccessKey: requireEnv('GBACKUP_RECEIPT_S3_SECRET_ACCESS_KEY', env.GBACKUP_RECEIPT_S3_SECRET_ACCESS_KEY),
  };
}

function parseTrustBundle(raw: string): readonly unknown[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new StagingReceiptInputError('GBACKUP_RECEIPT_TRUST_BUNDLE must be a JSON array');
  return parsed;
}

/** Test seam: inject a fake store/fetcher/clock so the suite never touches the network or real S3. */
export interface PublishCliDeps {
  readonly store?: ReceiptObjectStore;
  readonly fetcher?: ReceiptFetcher;
  readonly now?: () => Date;
}

/**
 * Build the expectation + wiring from env and publish. Returns the publish result (non-secret). Throws
 * (fail-closed) on any missing config, verification failure, overwrite attempt, or read-back mismatch.
 */
export async function runPublishCli(
  env: NodeJS.ProcessEnv,
  trustedDir: string,
  log: (m: string) => void = console.log,
  deps: PublishCliDeps = {},
  pins: ReleasePins = STAGING_PINS,
): Promise<PublishReceiptResult> {
  // The SELECTED application source is a data-only checkout; read ONLY migration files from it.
  const sourceDir = env.SOURCE_DIR && env.SOURCE_DIR.trim().length > 0 ? env.SOURCE_DIR : trustedDir;
  const receiptPath = requireEnv('RECEIPT_FILE', env.RECEIPT_FILE);
  const signedReceiptBytes = readFileSync(receiptPath);

  // Independently reconstruct the trusted release expectation (same inputs + source the signer/gate use).
  const inputs = inputsFromEnv(env, pins);
  const derived = deriveMigrationFacts({ runtimeDir: sourceDir, gitCommitish: inputs.sourceCommit }, inputs.appliedCount, pins);
  const load = loadReceiptKeyBundle(parseTrustBundle(requireEnv('GBACKUP_RECEIPT_TRUST_BUNDLE', env.GBACKUP_RECEIPT_TRUST_BUNDLE)));
  if (!load.ok) throw new StagingReceiptInputError(`trust bundle failed to load: ${load.code}`);
  const expectation = buildSelfVerifyExpectation(inputs, derived, load.store, pins);

  const controls = buildControls(env);
  const locator = {
    baseUrl: requireEnv('GBACKUP_RECEIPT_BASE_URL', env.GBACKUP_RECEIPT_BASE_URL),
    environment: pins.environment,
    targetApplication: pins.targetApplication,
    deploymentNonce: inputs.deploymentNonce,
  };

  // Real wiring (overridable in tests): authenticated create-only store + anonymous HTTPS read-back fetcher.
  const store = deps.store ?? createS3ReceiptObjectStore(buildReceiptS3Config(env));
  const fetcher = deps.fetcher ?? createHttpsReceiptFetcher(controls);

  const result = await publishSignedReceiptV2({
    signedReceiptBytes,
    expectation,
    expectedTargetImageDigest: inputs.targetImageDigest,
    locator,
    controls,
    store,
    fetcher,
    ...(deps.now ? { now: deps.now } : {}),
  });

  log(`Published ${pins.environment} receipt ${result.receiptId} — ${result.status}`);
  log(`  url=${result.url}`);
  log(`  sha256=${result.receiptSha256} pending=${result.pendingMigrationCount} nonce=${result.deploymentNonce}`);

  // Optional sanitized publication evidence (NON-SECRET only — safe to upload as a CI artifact).
  const evidencePath = env.PUBLISH_EVIDENCE_FILE?.trim();
  if (evidencePath) {
    const evidence = {
      status: result.status,
      publicUrl: result.url,
      objectKey: result.objectKey,
      receiptId: result.receiptId,
      receiptSha256: result.receiptSha256,
      receiptCanonicalHash: result.receiptCanonicalHash,
      byteLength: result.byteLength,
      sourceCommit: inputs.sourceCommit,
      targetImageDigest: inputs.targetImageDigest,
      deploymentNonce: result.deploymentNonce,
      pendingMigrationCount: result.pendingMigrationCount,
      publishedAtUtc: result.publishedAt,
    };
    writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
    log(`  evidence=${evidencePath}`);
  }
  return result;
}

// Execute only when run directly as the CLI script (not when imported by tests).
const entry = (process.argv[1] ?? '').replace(/\\/g, '/');
if (/scripts\/ci\/publish-receipt\.(ts|js|mjs)$/.test(entry)) {
  runPublishCli(process.env, process.cwd()).catch((e) => {
    const msg = e instanceof ReceiptPublishError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
    console.error(`[publish-receipt] FAILED: ${msg}`);
    process.exit(1);
  });
}
