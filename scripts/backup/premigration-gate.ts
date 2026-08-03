import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ReceiptV2Expectation, type ReceiptV2FailCode } from './receipt-v2-verify';
import {
  type ReceiptFetcher,
  type TransportControls,
  fetchAndVerifyReceiptV2,
} from './receipt-transport';
import { type PendingMigrationEntry } from './receipt-v2-schema';
import { type ReceiptKeyStore, loadReceiptKeyBundle } from './receipt-key-bundle';
import { FLY_VOLUMES_ADAPTER_VERSION, FLY_VOLUMES_PROVIDER } from './provider-fly-volumes';
import {
  type RuntimeMigrationSet,
  readRuntimeMigrationSet,
} from './runtime-migration-set';
import { isCanonicalDeploymentNonce, isNonZeroCanonicalUint64Decimal } from './receipt-v2-encoding';

/**
 * G-Backup-B2a — RELEASE-MACHINE pre-migration verification gate (consumer only).
 *
 * Protects the COMPLETE database-mutation boundary (`migrate()` AND `src/db/rls.sql`), not merely pending Drizzle
 * migrations. Runs under the caller's advisory lock, BEFORE any mutation. On staging it is FAIL-CLOSED by default:
 * missing/false/malformed/incomplete configuration aborts. Only a catalog-verified BOOTSTRAP_EMPTY database, or an
 * explicit LOCAL/dev/test bypass, may proceed without a signed receipt.
 *
 * It is `.git`-independent: the release image has no `.git`, so the portable Git-blob migration-set hash and the
 * exact source revision are BAKED into the image at build time and read from an immutable file. The trusted,
 * signed receipt (produced off-machine where git IS available) carries the migration-set binding the verifier
 * checks. This module NEVER imports the signer or any Fly snapshot authority (enforced by the import-boundary test).
 */

export type GateFailCode =
  | 'config_invalid'
  | 'config_incomplete'
  | 'bypass_not_allowed'
  | 'source_identity_invalid'
  | 'image_identity_invalid'
  | 'trust_bundle_invalid'
  | 'db_probe_failed'
  | 'system_identifier_invalid'
  | 'migration_table_missing_nonempty'
  | 'database_divergence'
  | 'verification_failed';

export class PreMigrationGateError extends Error {
  readonly code: GateFailCode;
  /** When code === 'verification_failed', the underlying B1 verifier code + step. */
  readonly verifyCode?: ReceiptV2FailCode | string;
  readonly step?: number;
  constructor(code: GateFailCode, message: string, extra?: { verifyCode?: ReceiptV2FailCode | string; step?: number }) {
    super(message);
    this.name = 'PreMigrationGateError';
    this.code = code;
    this.verifyCode = extra?.verifyCode;
    this.step = extra?.step;
  }
}

export type GateMode = 'bootstrap_bypass' | 'local_bypass' | 'verified';
export interface GateVerdict {
  readonly ok: true;
  readonly mode: GateMode;
  readonly detail: string;
  readonly receiptCanonicalHash?: string;
}

// -- Environment resolution --------------------------------------------------

export const GATE_ENVIRONMENTS = ['staging', 'production', 'local', 'development', 'test'] as const;
export type GateEnvironment = (typeof GATE_ENVIRONMENTS)[number];
/** The real staging Fly application. If the machine reports this app, the environment MUST resolve to staging. */
export const STAGING_APP_NAME = 'king-ai-ops-hub-staging' as const;

/**
 * Resolve the gate environment from explicit config, cross-checked against the Fly app identity so a real staging
 * machine cannot silently degrade to a bypass-eligible environment when `GBACKUP_ENVIRONMENT` is missing or wrong.
 */
export function resolveGateEnvironment(input: { gbackupEnvironment?: string | null; flyAppName?: string | null }): GateEnvironment {
  const raw = (input.gbackupEnvironment ?? '').trim();
  if (input.flyAppName === STAGING_APP_NAME) {
    if (raw !== 'staging') throw new PreMigrationGateError('config_invalid', `machine is ${STAGING_APP_NAME} but GBACKUP_ENVIRONMENT is ${JSON.stringify(raw)} (must be "staging")`);
    return 'staging';
  }
  if (raw === '') return 'local';
  if (!(GATE_ENVIRONMENTS as readonly string[]).includes(raw)) throw new PreMigrationGateError('config_invalid', `unknown GBACKUP_ENVIRONMENT ${JSON.stringify(raw)}`);
  return raw as GateEnvironment;
}

// -- Injected release inputs (baked at build time; read from the image) ------

export interface ReleaseJournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}
export interface ReleaseSourceInputs {
  readonly journal: readonly ReleaseJournalEntry[];
  readonly runtimeSet: RuntimeMigrationSet;
  /** Baked, immutable. Git-derived; produced off-machine. */
  readonly sourceCommit: string;
  readonly portableMigrationSetHash: string;
}

const HEX_COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const PLACEHOLDERS = new Set(['', 'UNKNOWN', 'unknown', 'PLACEHOLDER', 'none', 'null']);
/** A digest-bound (immutable) image reference: `<repo>[:tag]@sha256:<64 hex>`. */
const DIGEST_BOUND_IMAGE = /@sha256:[0-9a-f]{64}$/;

/** Enforce an IMMUTABLE, digest-bound runtime image identity. Rejects placeholder / tag-only / malformed-digest. */
export function assertDigestBoundImageRef(ref: string): void {
  if (PLACEHOLDERS.has(ref)) throw new PreMigrationGateError('image_identity_invalid', 'image identity is missing/placeholder');
  if (!ref.includes('@')) throw new PreMigrationGateError('image_identity_invalid', 'image identity is tag-only / not digest-bound');
  if (!DIGEST_BOUND_IMAGE.test(ref)) throw new PreMigrationGateError('image_identity_invalid', 'image identity digest is malformed');
}

interface BakedSourceIdentity {
  readonly sourceCommit: string;
  readonly portableMigrationSetHash: string;
}

/** Read + shape-check the baked source-identity JSON. Format problems throw; VALUE validity is judged by the gate. */
export function readBakedSourceIdentity(sourceIdentityPath: string): BakedSourceIdentity {
  let text: string;
  try {
    text = readFileSync(sourceIdentityPath, 'utf8');
  } catch (e) {
    throw new PreMigrationGateError('source_identity_invalid', `cannot read baked source identity: ${e instanceof Error ? e.message : String(e)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PreMigrationGateError('source_identity_invalid', 'baked source identity is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new PreMigrationGateError('source_identity_invalid', 'baked source identity is not an object');
  const o = parsed as Record<string, unknown>;
  if (typeof o.sourceCommit !== 'string' || typeof o.portableMigrationSetHash !== 'string') {
    throw new PreMigrationGateError('source_identity_invalid', 'baked source identity is missing sourceCommit/portableMigrationSetHash strings');
  }
  return { sourceCommit: o.sourceCommit, portableMigrationSetHash: o.portableMigrationSetHash };
}

/** Load the release source inputs from the image (journal + runtime set + baked identity). Used by migrate.ts. */
export function loadReleaseSourceInputs(baseDir: string, sourceIdentityPath: string, migrationsFolder = 'drizzle'): ReleaseSourceInputs {
  let journal: { entries: ReleaseJournalEntry[] };
  try {
    journal = JSON.parse(readFileSync(join(baseDir, migrationsFolder, 'meta', '_journal.json'), 'utf8')) as { entries: ReleaseJournalEntry[] };
  } catch (e) {
    throw new PreMigrationGateError('source_identity_invalid', `cannot read migration journal: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(journal.entries)) throw new PreMigrationGateError('source_identity_invalid', 'journal.entries missing/not an array');
  const runtimeSet = readRuntimeMigrationSet(baseDir, migrationsFolder);
  const baked = readBakedSourceIdentity(sourceIdentityPath);
  return {
    journal: journal.entries.map((e) => ({ idx: e.idx, tag: e.tag, when: e.when })),
    runtimeSet,
    sourceCommit: baked.sourceCommit,
    portableMigrationSetHash: baked.portableMigrationSetHash,
  };
}

// -- DB probe (injected; read-only) ------------------------------------------

export interface AppliedRow {
  readonly hash: string;
  readonly createdAt: number;
  readonly id: number | null;
}
/** Read-only catalog probe. All git-independent; runs SELECTs only. Implemented over `postgres` in migrate.ts. */
export interface GateDbProbe {
  migrationsTableMissing(): Promise<boolean>;
  appliedRows(): Promise<readonly AppliedRow[]>;
  hasUnexplainedUserObjects(): Promise<boolean>;
  currentDatabase(): Promise<string>;
  /** PostgreSQL system identifier from `pg_control_system()`, as a canonical unsigned-64-bit decimal string. */
  systemIdentifier(): Promise<string>;
}

// -- Gate configuration ------------------------------------------------------

export interface GateConfig {
  readonly environment: GateEnvironment;
  /** Honored ONLY when environment is local/development/test AND no Fly runtime identity is present. */
  readonly bypass: boolean;
  /** True if ANY Fly runtime identity env is present (FLY_APP_NAME / FLY_MACHINE_ID / FLY_ALLOC_ID / FLY_IMAGE_REF). */
  readonly flyRuntimePresent: boolean;
  readonly declaredBootstrap: boolean;
  readonly expectedDatabaseIdentity: string;
  // Receipt-verification config (required when a non-empty database on staging/production needs a receipt):
  readonly deploymentNonce?: string;
  readonly receiptBaseUrl?: string;
  readonly hostAllowlist?: ReadonlySet<string>;
  readonly trustBundleEntries?: readonly unknown[];
  readonly targetApplication?: string;
  readonly databaseApp?: string;
  readonly sourceVolumeId?: string;
  readonly expectedImageRef?: string;
  readonly minRetentionDays: number;
  readonly maxSnapshotAgeMs: number;
  readonly transportMaxBytes: number;
  readonly transportTimeoutMs: number;
}

export interface GateDeps {
  readonly config: GateConfig;
  /** Lazily loads the baked source inputs — invoked ONLY on the non-empty verified path (not for bypass/bootstrap),
   *  so local bypass and bootstrap never require the baked file to be present. */
  readonly loadSource: () => ReleaseSourceInputs;
  readonly probe: GateDbProbe;
  readonly fetcher: ReceiptFetcher;
  /** The single authoritative time (DDL start); passed to the verifier as migrationStartedAt. */
  readonly now: Date;
}

function isEnforced(env: GateEnvironment): boolean {
  return env === 'staging' || env === 'production';
}

/** Compute the exact canonical pending set (journal entries after the applied prefix), matching the B1 schema. */
function computeExpectedPending(source: ReleaseSourceInputs, applied: readonly AppliedRow[]): PendingMigrationEntry[] {
  const setByTag = new Map(source.runtimeSet.entries.map((e) => [e.migrationTag, e]));
  const journalSorted = [...source.journal].sort((a, b) => a.when - b.when);
  const pending = journalSorted.slice(applied.length);
  return pending
    .map((j) => {
      const e = setByTag.get(j.tag);
      if (!e) throw new PreMigrationGateError('database_divergence', `journal tag ${j.tag} has no baked migration file`);
      return { migrationIndex: e.migrationIndex, migrationTag: e.migrationTag, migrationPath: e.migrationPath, byteLength: e.byteLength, sha256: e.sha256 };
    })
    .sort((a, b) => a.migrationIndex - b.migrationIndex);
}

/** Structural, git-independent divergence checks on the applied history vs the baked journal prefix. */
function assertAppliedIsCleanPrefix(source: ReleaseSourceInputs, applied: readonly AppliedRow[]): void {
  const journalSorted = [...source.journal].sort((a, b) => a.when - b.when);
  if (applied.length > journalSorted.length) throw new PreMigrationGateError('database_divergence', `database has ${applied.length} applied migrations but the image journal has ${journalSorted.length}`);
  const seenHash = new Set<string>();
  const seenWhen = new Set<number>();
  for (let i = 0; i < applied.length; i++) {
    const a = applied[i]!;
    if (seenWhen.has(a.createdAt)) throw new PreMigrationGateError('database_divergence', `duplicate applied created_at ${a.createdAt}`);
    if (seenHash.has(a.hash)) throw new PreMigrationGateError('database_divergence', 'duplicate applied hash');
    if (i > 0 && !(applied[i - 1]!.createdAt < a.createdAt)) throw new PreMigrationGateError('database_divergence', `applied migrations out of order at position ${i}`);
    if (a.createdAt !== journalSorted[i]!.when) throw new PreMigrationGateError('database_divergence', `applied[${i}] created_at ${a.createdAt} does not match the image journal prefix`);
    seenHash.add(a.hash);
    seenWhen.add(a.createdAt);
  }
}

function requireConfig<T>(v: T | undefined | null, name: string): T {
  if (v === undefined || v === null) throw new PreMigrationGateError('config_incomplete', `missing gate configuration: ${name}`);
  return v;
}

function buildReceiptExpectation(deps: GateDeps, source: ReleaseSourceInputs, systemId: string, expectedPending: PendingMigrationEntry[], keyStore: ReceiptKeyStore): { locator: { baseUrl: string; environment: string; targetApplication: string; deploymentNonce: string }; controls: TransportControls; exp: ReceiptV2Expectation } {
  const c = deps.config;
  const nonce = requireConfig(c.deploymentNonce, 'deploymentNonce');
  if (!isCanonicalDeploymentNonce(nonce)) throw new PreMigrationGateError('config_invalid', 'deploymentNonce is not a canonical 128-bit nonce');
  const baseUrl = requireConfig(c.receiptBaseUrl, 'receiptBaseUrl');
  const hostAllowlist = requireConfig(c.hostAllowlist, 'hostAllowlist');
  if (hostAllowlist.size === 0) throw new PreMigrationGateError('config_invalid', 'hostAllowlist is empty');
  const targetApplication = requireConfig(c.targetApplication, 'targetApplication');
  const databaseApp = requireConfig(c.databaseApp, 'databaseApp');
  const sourceVolumeId = requireConfig(c.sourceVolumeId, 'sourceVolumeId');
  const targetImageRef = requireConfig(c.expectedImageRef, 'expectedImageRef');
  // On staging/production the accepted runtime identity MUST be immutable (digest-bound) and will be compared
  // exactly against the signed receipt by the B1 verifier (image_ref_mismatch). Tag-only refs are mutable → rejected.
  if (isEnforced(deps.config.environment)) assertDigestBoundImageRef(targetImageRef);
  if (!HEX_COMMIT.test(source.sourceCommit) || PLACEHOLDERS.has(source.sourceCommit)) {
    throw new PreMigrationGateError('source_identity_invalid', 'baked sourceCommit is missing/placeholder/malformed');
  }
  if (!SHA256_HEX.test(source.portableMigrationSetHash) || PLACEHOLDERS.has(source.portableMigrationSetHash)) {
    throw new PreMigrationGateError('source_identity_invalid', 'baked portableMigrationSetHash is missing/placeholder/malformed');
  }
  const exp: ReceiptV2Expectation = {
    environment: deps.config.environment === 'production' ? 'production' : 'staging',
    targetApplication,
    databaseApp,
    sourceVolumeId,
    databaseSystemIdentifier: systemId,
    snapshotProvider: FLY_VOLUMES_PROVIDER,
    providerAdapterVersion: FLY_VOLUMES_ADAPTER_VERSION,
    minRetentionDays: c.minRetentionDays,
    maxSnapshotAgeMs: c.maxSnapshotAgeMs,
    sourceCommit: source.sourceCommit,
    targetImageRef,
    deploymentNonce: nonce,
    portableMigrationSetHash: source.portableMigrationSetHash,
    runtimeMigrationSetHash: source.runtimeSet.runtimeMigrationSetHash,
    pendingMigrations: expectedPending,
    migrationStartedAt: deps.now,
    supportedSchemaVersions: new Set(['2']),
    supportedAlgorithms: new Set(['ed25519']),
    keyStore,
  };
  return {
    locator: { baseUrl, environment: exp.environment, targetApplication, deploymentNonce: nonce },
    controls: { maxBytes: c.transportMaxBytes, timeoutMs: c.transportTimeoutMs, hostAllowlist },
    exp,
  };
}

/**
 * Run the pre-migration gate. Returns a verdict ONLY when it is safe to proceed to database mutation; otherwise
 * throws {@link PreMigrationGateError} (fail-closed). The caller MUST NOT run `migrate()` or `rls.sql` unless this
 * resolves to a verdict.
 */
export async function runPreMigrationGate(deps: GateDeps): Promise<GateVerdict> {
  const env = deps.config.environment;

  // 1. Bypass policy: allowed ONLY when the environment is explicitly local/development/test AND there is NO Fly
  //    runtime identity. Staging, production, and any process carrying Fly runtime identity are refused.
  if (deps.config.bypass) {
    if (isEnforced(env)) throw new PreMigrationGateError('bypass_not_allowed', `explicit gate bypass is not permitted in ${env}`);
    if (deps.config.flyRuntimePresent) throw new PreMigrationGateError('bypass_not_allowed', 'explicit gate bypass is not permitted while Fly runtime identity is present');
    return { ok: true, mode: 'local_bypass', detail: `explicit bypass honored in ${env}` };
  }

  // 2. DB probe (fail-closed on any error).
  let migrationsTableMissing: boolean;
  let applied: readonly AppliedRow[];
  let unexplained: boolean;
  let currentDb: string;
  let systemId: string;
  try {
    migrationsTableMissing = await deps.probe.migrationsTableMissing();
    if (migrationsTableMissing) {
      unexplained = await deps.probe.hasUnexplainedUserObjects();
      currentDb = await deps.probe.currentDatabase();
      applied = [];
    } else {
      unexplained = false;
      currentDb = await deps.probe.currentDatabase();
      applied = await deps.probe.appliedRows();
    }
    systemId = await deps.probe.systemIdentifier();
  } catch (e) {
    throw new PreMigrationGateError('db_probe_failed', `database probe failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isNonZeroCanonicalUint64Decimal(systemId)) {
    throw new PreMigrationGateError('system_identifier_invalid', 'pg_control_system() returned a non-canonical or zero system identifier');
  }

  // 3. Bootstrap decision. Only a catalog-verified empty database may proceed without a receipt.
  if (migrationsTableMissing) {
    if (unexplained) throw new PreMigrationGateError('migration_table_missing_nonempty', 'migration table absent but unexplained user objects exist');
    if (!deps.config.declaredBootstrap) throw new PreMigrationGateError('migration_table_missing_nonempty', 'migration table absent and not declared bootstrap');
    if (currentDb !== deps.config.expectedDatabaseIdentity) throw new PreMigrationGateError('migration_table_missing_nonempty', 'migration table absent and database identity does not match the expected bootstrap target');
    return { ok: true, mode: 'bootstrap_bypass', detail: 'catalog-verified BOOTSTRAP_EMPTY: no migration table, no unexplained user objects, identity matches' };
  }

  // 4. Non-empty database: structural divergence checks, then a MANDATORY signed-receipt verification —
  //    including NO_PENDING, because src/db/rls.sql can still mutate state.
  let source: ReleaseSourceInputs;
  try {
    source = deps.loadSource();
  } catch (e) {
    if (e instanceof PreMigrationGateError) throw e;
    throw new PreMigrationGateError('source_identity_invalid', `cannot load baked source inputs: ${e instanceof Error ? e.message : String(e)}`);
  }
  assertAppliedIsCleanPrefix(source, applied);
  const expectedPending = computeExpectedPending(source, applied);

  // Load the trust bundle from validated config (public keys only).
  const trustEntries = requireConfig(deps.config.trustBundleEntries, 'trustBundleEntries');
  const load = loadReceiptKeyBundle(trustEntries);
  if (!load.ok) throw new PreMigrationGateError('trust_bundle_invalid', `receipt trust bundle failed to load: ${load.code}`);

  const { locator, controls, exp } = buildReceiptExpectation(deps, source, systemId, expectedPending, load.store);
  const result = await fetchAndVerifyReceiptV2(deps.fetcher, locator, controls, exp);
  if (!result.ok) {
    throw new PreMigrationGateError('verification_failed', `receipt verification failed (${result.stage}): ${result.code}`, { verifyCode: result.code, step: result.step });
  }
  return { ok: true, mode: 'verified', detail: `receipt verified for ${expectedPending.length} pending migration(s)`, receiptCanonicalHash: result.receiptCanonicalHash };
}

// -- Migration connection cleanup (advisory-unlock + close; never mask the primary failure) -------------------

/** Redact `scheme://user:pass@host` credentials from any diagnostic string before it is logged. */
export function redactSecrets(s: string): string {
  return s.replace(/\/\/[^@\s/]+@/g, '//***@');
}

export interface MigrationCleanupOps {
  /** Whether the advisory lock was actually acquired (unlock is attempted only then). */
  readonly locked: boolean;
  unlock(): Promise<void>;
  end(): Promise<void>;
}

/**
 * Finalize the migration connection on EVERY post-acquisition path:
 *  - attempt advisory unlock (only if the lock was acquired), then attempt `end()` — even if unlock failed;
 *  - a cleanup failure NEVER replaces an earlier (gate / migrate / rls) failure — the primary error is rethrown;
 *  - if nothing failed earlier, a cleanup failure is surfaced;
 *  - diagnostics are structured and credential-redacted.
 */
export async function finalizeMigrationConnection(primaryError: unknown, ops: MigrationCleanupOps, log: (m: string) => void = console.error): Promise<void> {
  const cleanupErrors: string[] = [];
  if (ops.locked) {
    try {
      await ops.unlock();
    } catch (e) {
      cleanupErrors.push(`advisory_unlock: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
    }
  }
  try {
    await ops.end();
  } catch (e) {
    cleanupErrors.push(`connection_close: ${redactSecrets(e instanceof Error ? e.message : String(e))}`);
  }
  if (primaryError !== null && primaryError !== undefined) {
    if (cleanupErrors.length > 0) log(`[migrate] cleanup issues after a primary failure (primary rethrown): ${cleanupErrors.join('; ')}`);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw new Error(`[migrate] post-migration cleanup failed: ${cleanupErrors.join('; ')}`);
}
