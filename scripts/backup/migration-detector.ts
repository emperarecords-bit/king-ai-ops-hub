import { type Sql } from 'postgres';
import {
  EXPECTED_DRIZZLE_VERSION,
  type ExpectedMigration,
  MigrationReadError,
  computeExpectedMigrations,
  installedDrizzleVersion,
  recognizedHashes,
} from './migration-hash';
import { type SourceManifest, type SourceManifestEntry } from './source-manifest';
import { type LegacyEnvironment, type LegacyEvidenceManifest, legacyAttestationSchema } from './legacy-attestation-schema';
import { type LegacyTrustStore, validateAttestationBundle, verifyLegacyAttestation } from './legacy-attestation-verify';

/**
 * G-Backup-A — migration-state detector. Compares the APPLIED history (`drizzle.__drizzle_migrations`) against a
 * PORTABLE source manifest (Git blobs at an exact commit), recognizing exact deterministic LF/CRLF variants so a
 * line-ending-only difference is NOT a `HISTORICAL_HASH_MISMATCH`. The working-tree `drizzleExecutionHash` is
 * carried separately for diagnostics + pending-migration binding. Classifier is PURE; the reader does read-only
 * SELECTs. Only `NO_PENDING` and (catalog-verified, declared) `BOOTSTRAP_EMPTY` proceed without a backup.
 */

export const MIGRATION_STATES = [
  'NO_PENDING',
  'PENDING_FORWARD',
  'BOOTSTRAP_EMPTY',
  'HISTORICAL_HASH_MISMATCH',
  'UNKNOWN_DATABASE_DIVERGENCE',
  'MIGRATION_TABLE_MISSING_NONEMPTY',
  'DETECTOR_FAILURE',
] as const;
export type MigrationState = (typeof MIGRATION_STATES)[number];

export interface AppliedMigration {
  readonly hash: string;
  /** drizzle `created_at` (bigint) coerced to number; equals the journal `when`. */
  readonly createdAt: number;
  readonly id: number | null;
}

/** Working-tree execution bytes (drizzleExecutionHash), keyed by `when`. */
export interface RuntimeExecutionEntry {
  readonly when: number;
  readonly tag: string;
  readonly rawHash: string;
}

export interface VariantMatchDetail {
  readonly idx: number;
  readonly tag: string;
  readonly appliedHash: string;
  readonly committedSourceHash: string;
  readonly recognizedVariantType: SourceManifestEntry['recognizedVariantType'];
  readonly runtimeWorkingTreeHash: string | null;
  readonly runtimeEqualsApplied: boolean;
}

export interface RuntimeMismatchWarning {
  readonly idx: number;
  readonly tag: string;
  readonly appliedHash: string;
  readonly runtimeWorkingTreeHash: string | null;
}

export interface PendingBindingDetail {
  readonly idx: number;
  readonly tag: string;
  readonly runtimeWorkingTreeHash: string | null;
  readonly bindable: boolean;
  readonly reason: string;
}

export interface ClassifyInput {
  readonly source: readonly SourceManifestEntry[];
  readonly sourceMigrationSetHash: string;
  readonly applied: readonly AppliedMigration[] | null; // null = migrations table absent
  readonly runtime: readonly RuntimeExecutionEntry[];
  readonly migrationsTableMissing: boolean;
  readonly declaredBootstrap: boolean;
  /** Catalog-derived (correction 3): any user object outside the system/extension allowlist exists. */
  readonly hasUnexplainedUserObjects: boolean;
  /** The database identity equals the expected new-bootstrap target (never inferred). */
  readonly databaseIdentityMatches: boolean;
  /** Set of `String(journalTimestamp)` for migrations with a VERIFIED legacy execution attestation (G-Backup-A2).
   *  Populated by the reader AFTER cryptographic verification — the pure classifier only consumes it. */
  readonly legacyAttestedKeys?: ReadonlySet<string>;
}

export interface ClassifyResult {
  readonly state: MigrationState;
  readonly pendingTags: string[];
  readonly sourceMigrationSetHash: string;
  readonly exactExecutionMatches: number;
  readonly lineEndingVariantMatches: number;
  readonly variantDetails: VariantMatchDetail[];
  readonly legacyAttestedMatches: number;
  readonly legacyAttestedDetails: { idx: number; tag: string; appliedHash: string }[];
  /** Supplied-but-invalid attestations (correction 4): structured, non-secret. Migration stays blocked. */
  readonly invalidLegacyAttestations: { idx: number | null; tag: string | null; reasonCode: string; keyId: string | null }[];
  readonly unknownHistoricalMismatches: number;
  readonly unknownDatabaseDivergences: number;
  readonly runtimeMismatchWarnings: RuntimeMismatchWarning[];
  readonly pendingBindable: boolean;
  readonly pendingBindingDetails: PendingBindingDetail[];
  readonly detail: string;
}

function empty(state: MigrationState, sourceMigrationSetHash: string, detail: string): ClassifyResult {
  return {
    state,
    pendingTags: [],
    sourceMigrationSetHash,
    exactExecutionMatches: 0,
    lineEndingVariantMatches: 0,
    variantDetails: [],
    legacyAttestedMatches: 0,
    legacyAttestedDetails: [],
    invalidLegacyAttestations: [],
    unknownHistoricalMismatches: 0,
    unknownDatabaseDivergences: 0,
    runtimeMismatchWarnings: [],
    pendingBindable: false,
    pendingBindingDetails: [],
    detail,
  };
}

/** PURE classifier. No I/O. */
export function classifyMigrationState(inp: ClassifyInput): ClassifyResult {
  const setHash = inp.sourceMigrationSetHash;
  const runtimeByWhen = new Map(inp.runtime.map((r) => [r.when, r]));

  // Source journal validity: strictly-increasing `when`, unique tags (else the repo journal is malformed).
  for (let i = 1; i < inp.source.length; i++) {
    if (inp.source[i]!.when <= inp.source[i - 1]!.when) {
      return empty('DETECTOR_FAILURE', setHash, `repository journal timestamps are duplicated or unordered at idx ${inp.source[i]!.idx}`);
    }
  }
  if (new Set(inp.source.map((s) => s.tag)).size !== inp.source.length) {
    return empty('DETECTOR_FAILURE', setHash, 'repository journal has duplicate tags');
  }

  // (1) migrations tracking table absent → catalog-complete bootstrap gate (correction 3).
  if (inp.migrationsTableMissing || inp.applied === null) {
    if (inp.hasUnexplainedUserObjects) {
      return empty('MIGRATION_TABLE_MISSING_NONEMPTY', setHash, 'migration tracking table absent but unexplained user objects exist');
    }
    if (inp.declaredBootstrap && inp.databaseIdentityMatches) {
      return { ...empty('BOOTSTRAP_EMPTY', setHash, 'declared bootstrap: no migration table, no unexplained user objects, identity matches'), pendingTags: inp.source.map((s) => s.tag) };
    }
    const why = !inp.declaredBootstrap ? 'not declared bootstrap' : 'database identity does not match the expected bootstrap target';
    return empty('MIGRATION_TABLE_MISSING_NONEMPTY', setHash, `migration tracking table absent and ${why}; refusing to auto-initialize`);
  }

  const A = inp.applied;
  const S = inp.source;

  // (2) duplicate / impossible applied records (correction 6).
  const seenHash = new Set<string>();
  const seenWhen = new Set<number>();
  for (const a of A) {
    if (seenWhen.has(a.createdAt)) return empty('UNKNOWN_DATABASE_DIVERGENCE', setHash, `duplicate applied created_at ${a.createdAt}`);
    if (seenHash.has(a.hash)) return empty('UNKNOWN_DATABASE_DIVERGENCE', setHash, 'duplicate applied hash in an impossible position');
    seenWhen.add(a.createdAt);
    seenHash.add(a.hash);
  }
  // Applied must be non-decreasing by created_at (ordering intact).
  for (let i = 1; i < A.length; i++) {
    if (A[i]!.createdAt <= A[i - 1]!.createdAt) {
      return empty('UNKNOWN_DATABASE_DIVERGENCE', setHash, `applied migrations out of order at position ${i}`);
    }
  }
  if (A.length > S.length) {
    return empty('UNKNOWN_DATABASE_DIVERGENCE', setHash, `database has ${A.length} applied migrations but source has ${S.length}`);
  }

  // (3) prefix map with recognized-variant + legacy-attested awareness (accumulate; decide state at end).
  const variantDetails: VariantMatchDetail[] = [];
  const legacyAttestedDetails: { idx: number; tag: string; appliedHash: string }[] = [];
  const runtimeMismatchWarnings: RuntimeMismatchWarning[] = [];
  const unknownMismatchTags: string[] = [];
  const attested = inp.legacyAttestedKeys ?? new Set<string>();
  let exact = 0;
  let variant = 0;
  for (let i = 0; i < A.length; i++) {
    const a = A[i]!;
    const s = S[i]!;
    if (a.createdAt !== s.when) {
      return empty('UNKNOWN_DATABASE_DIVERGENCE', setHash, `applied[${i}] created_at ${a.createdAt} != source when ${s.when} (cannot map 1:1)`);
    }
    const recognized = recognizedHashes(s);
    const rt = runtimeByWhen.get(s.when) ?? null;
    const runtimeEqualsApplied = rt != null && rt.rawHash === a.hash;
    if (a.hash === s.committedBlobSha256) {
      exact++;
    } else if (recognized.has(a.hash)) {
      variant++;
      variantDetails.push({ idx: s.idx, tag: s.tag, appliedHash: a.hash, committedSourceHash: s.committedBlobSha256, recognizedVariantType: s.recognizedVariantType, runtimeWorkingTreeHash: rt?.rawHash ?? null, runtimeEqualsApplied });
    } else if (attested.has(String(s.when))) {
      // A VERIFIED legacy execution attestation (verified by the reader) covers exactly this migration.
      legacyAttestedDetails.push({ idx: s.idx, tag: s.tag, appliedHash: a.hash });
    } else {
      unknownMismatchTags.push(s.tag);
    }
    if (!runtimeEqualsApplied) {
      runtimeMismatchWarnings.push({ idx: s.idx, tag: s.tag, appliedHash: a.hash, runtimeWorkingTreeHash: rt?.rawHash ?? null });
    }
  }

  // (4) pending forward + pending-binding to the portable source.
  const pending = S.slice(A.length);
  const pendingBindingDetails: PendingBindingDetail[] = pending.map((s) => {
    const rt = runtimeByWhen.get(s.when) ?? null;
    if (!rt) return { idx: s.idx, tag: s.tag, runtimeWorkingTreeHash: null, bindable: false, reason: 'no runtime file present for this pending migration' };
    const bindable = recognizedHashes(s).has(rt.rawHash);
    return { idx: s.idx, tag: s.tag, runtimeWorkingTreeHash: rt.rawHash, bindable, reason: bindable ? 'runtime bytes are an exact committed-source or recognized EOL variant' : 'runtime bytes are neither the committed source nor a recognized EOL variant' };
  });
  const pendingBindable = pendingBindingDetails.every((d) => d.bindable);

  const common = {
    sourceMigrationSetHash: setHash,
    exactExecutionMatches: exact,
    lineEndingVariantMatches: variant,
    variantDetails,
    legacyAttestedMatches: legacyAttestedDetails.length,
    legacyAttestedDetails,
    invalidLegacyAttestations: [] as { idx: number | null; tag: string | null; reasonCode: string; keyId: string | null }[],
    unknownDatabaseDivergences: 0,
    runtimeMismatchWarnings,
    pendingBindingDetails,
  };

  // Any unrecognized (not exact, not EOL variant, not legacy-attested) applied hash → fail closed.
  if (unknownMismatchTags.length > 0) {
    return { ...common, state: 'HISTORICAL_HASH_MISMATCH', pendingTags: [], pendingBindable: false, unknownHistoricalMismatches: unknownMismatchTags.length, detail: `applied hash for ${unknownMismatchTags.join(', ')} matches neither committed source, recognized EOL variant, nor a valid legacy attestation` };
  }

  if (A.length === S.length) {
    return { ...common, state: 'NO_PENDING', pendingTags: [], pendingBindable: true, unknownHistoricalMismatches: 0, detail: `all ${S.length} migrations applied (${exact} exact, ${variant} EOL variant, ${legacyAttestedDetails.length} legacy-attested)` };
  }
  return { ...common, state: 'PENDING_FORWARD', pendingTags: pending.map((s) => s.tag), pendingBindable, unknownHistoricalMismatches: 0, detail: `${pending.length} unapplied forward migration(s); pendingBindable=${pendingBindable}` };
}

// -- Read-only reader --------------------------------------------------------

export interface DetectResult extends ClassifyResult {
  readonly appliedCount: number | null;
  readonly drizzleVersion: string | null;
  readonly runtimeExecution: ExpectedMigration[];
}

/**
 * Read-only detector. Requires a trusted `sourceManifest` (from `buildSourceManifestFromGit` or a parsed JSON
 * manifest) — a missing manifest yields DETECTOR_FAILURE for governed use. Runs only SELECTs. Any connection,
 * parse, filesystem, journal, query, or drizzle-version-drift problem yields DETECTOR_FAILURE (fail closed).
 */
export async function detectMigrationState(
  sql: Sql,
  opts: {
    sourceManifest: SourceManifest | null;
    migrationsFolder: string;
    declaredBootstrap?: boolean;
    expectedDatabaseIdentity?: string;
    nodeModulesDir?: string;
    /** G-Backup-A2: verified-if-valid legacy attestations for specific historical migrations. Each is
     *  cryptographically verified against the trusted store + the exact source entry + the applied hash before
     *  it can contribute a LEGACY_ATTESTED_MATCH. An empty/absent bundle keeps every mismatch fail-closed. */
    legacyAttestationBundle?: {
      attestations: unknown[];
      /** A VALIDATED trust store (from `loadTrustBundle`) — never a raw caller record. */
      store: LegacyTrustStore;
      evidenceManifests?: Record<string, LegacyEvidenceManifest>;
      /** Trusted runtime scope config — verified exactly against each attestation (never wildcard). */
      scope: { repositoryId: string; applicationId: string; environment: LegacyEnvironment; migrationNamespace: string };
      /** Deterministic verification time for approval-time validation. */
      verificationTime: Date;
      maxClockSkewMs?: number;
    };
  },
): Promise<DetectResult> {
  const drizzleVersion = installedDrizzleVersion(opts.nodeModulesDir);
  const fail = (detail: string): DetectResult => ({
    ...empty('DETECTOR_FAILURE', opts.sourceManifest?.sourceMigrationSetHash ?? '', detail),
    appliedCount: null,
    drizzleVersion,
    runtimeExecution: [],
  });

  if (drizzleVersion !== EXPECTED_DRIZZLE_VERSION) {
    return fail(`drizzle-orm version drift: expected ${EXPECTED_DRIZZLE_VERSION}, found ${drizzleVersion ?? 'unknown'} — re-verify the hash adapter`);
  }
  if (!opts.sourceManifest) {
    return fail('no trusted source manifest available; refusing governed classification');
  }

  let runtime: ExpectedMigration[];
  try {
    runtime = computeExpectedMigrations(opts.migrationsFolder); // working-tree drizzleExecutionHash
  } catch (e) {
    if (e instanceof MigrationReadError) return fail(`runtime migration read failed: ${e.message}`);
    return fail(`unexpected runtime read error: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const reg = await sql<{ t: string | null }[]>`select to_regclass('drizzle.__drizzle_migrations')::text as t`;
    const migrationsTableMissing = reg[0]?.t == null;

    let hasUnexplainedUserObjects = false;
    let databaseIdentityMatches = true;
    if (migrationsTableMissing) {
      // Catalog-complete probe (correction 3): any user relation/function outside system + extension allowlist.
      const rel = await sql<{ n: number }[]>`
        select count(*)::int as n
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r','p','S','v','m')
          and n.nspname not in ('pg_catalog','information_schema','pg_toast')
          and n.nspname not like 'pg\\_temp\\_%' and n.nspname not like 'pg\\_toast\\_temp\\_%'
          and not exists (select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')`;
      const fn = await sql<{ n: number }[]>`
        select count(*)::int as n
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname not in ('pg_catalog','information_schema','pg_toast')
          and not exists (select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')`;
      hasUnexplainedUserObjects = (rel[0]?.n ?? 0) > 0 || (fn[0]?.n ?? 0) > 0;
      if (opts.expectedDatabaseIdentity != null) {
        const db = await sql<{ d: string }[]>`select current_database() as d`;
        databaseIdentityMatches = db[0]?.d === opts.expectedDatabaseIdentity;
      }
    }

    let applied: AppliedMigration[] | null = null;
    if (!migrationsTableMissing) {
      const rows = await sql<{ hash: string; created_at: string; id: number }[]>`
        select id, hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at asc, id asc`;
      applied = rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at), id: r.id ?? null }));
    }

    // Verify any supplied legacy attestations (bundle rules + crypto + exact scope) BEFORE classification. Only
    // a fully-verified attestation contributes a key; a supplied-but-invalid one is surfaced explicitly and the
    // migration stays fail-closed.
    const legacyAttestedKeys = new Set<string>();
    const invalidLegacyAttestations: { idx: number | null; tag: string | null; reasonCode: string; keyId: string | null }[] = [];
    const bundle = opts.legacyAttestationBundle;
    if (bundle && applied) {
      const bundleValid = validateAttestationBundle(bundle.attestations);
      if (!bundleValid.ok) {
        invalidLegacyAttestations.push({ idx: null, tag: null, reasonCode: 'bundle_invalid', keyId: null });
      } else {
        const appliedByWhen = new Map(applied.map((a) => [a.createdAt, a.hash]));
        const sourceByWhen = new Map(opts.sourceManifest.entries.map((s) => [s.when, s]));
        for (const raw of bundle.attestations) {
          const parsed = legacyAttestationSchema.safeParse(raw);
          if (!parsed.success) {
            invalidLegacyAttestations.push({ idx: null, tag: null, reasonCode: 'schema_invalid', keyId: null });
            continue;
          }
          const att = parsed.data;
          const s = sourceByWhen.get(att.journalTimestamp);
          const appliedHash = appliedByWhen.get(att.journalTimestamp);
          if (!s || appliedHash == null) {
            invalidLegacyAttestations.push({ idx: att.migrationIndex, tag: att.migrationTag, reasonCode: 'scope_mismatch', keyId: att.keyId });
            continue;
          }
          const res = verifyLegacyAttestation(
            att,
            {
              repositoryId: bundle.scope.repositoryId,
              applicationId: bundle.scope.applicationId,
              environment: bundle.scope.environment,
              migrationNamespace: bundle.scope.migrationNamespace,
              migrationPath: `${bundle.scope.migrationNamespace}/${s.tag}.sql`,
              migrationIndex: s.idx,
              migrationTag: s.tag,
              journalTimestamp: s.when,
              sourceBlobHash: s.committedBlobSha256,
              appliedHash,
              supportedVersions: new Set(['1']),
              supportedAlgorithms: new Set(['ed25519']),
              evidenceManifest: bundle.evidenceManifests?.[att.migrationTag],
              verificationTime: bundle.verificationTime,
              maxClockSkewMs: bundle.maxClockSkewMs,
            },
            bundle.store,
          );
          if (res.ok) legacyAttestedKeys.add(String(s.when));
          else invalidLegacyAttestations.push({ idx: s.idx, tag: s.tag, reasonCode: res.reasonCode, keyId: res.keyId });
        }
      }
    }

    const result = classifyMigrationState({
      source: opts.sourceManifest.entries,
      sourceMigrationSetHash: opts.sourceManifest.sourceMigrationSetHash,
      applied,
      runtime: runtime.map((r) => ({ when: r.when, tag: r.tag, rawHash: r.hash })),
      legacyAttestedKeys,
      migrationsTableMissing,
      declaredBootstrap: opts.declaredBootstrap ?? false,
      hasUnexplainedUserObjects,
      databaseIdentityMatches,
    });
    return { ...result, invalidLegacyAttestations, appliedCount: applied ? applied.length : null, drizzleVersion, runtimeExecution: runtime };
  } catch (e) {
    return fail(`database query failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
