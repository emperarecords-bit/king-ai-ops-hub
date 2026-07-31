import { type Sql } from 'postgres';
import {
  EXPECTED_DRIZZLE_VERSION,
  type ExpectedMigration,
  MigrationReadError,
  computeExpectedMigrations,
  installedDrizzleVersion,
  migrationSetHash,
} from './migration-hash';

/**
 * G-Backup-A — migration-state detector. Compares the repository migration history (journal + drizzle-compatible
 * hashes) against the applied set in `drizzle.__drizzle_migrations`, and classifies the environment into one of
 * seven explicit states. ONLY `NO_PENDING` and `BOOTSTRAP_EMPTY` may proceed without a preexisting-data backup;
 * every other state is fail-closed. The classifier is PURE; the reader performs read-only SELECTs.
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
}

export interface ClassifyInput {
  readonly expected: readonly ExpectedMigration[];
  /** Applied rows ordered by created_at asc; null when the migrations table is absent. */
  readonly applied: readonly AppliedMigration[] | null;
  readonly migrationsTableMissing: boolean;
  /** Any known Hub application table exists. */
  readonly appSchemaPresent: boolean;
  /** Any known Hub application table has ≥1 row. */
  readonly appDataPresent: boolean;
  /** The operator explicitly declared this a NEW bootstrap database. Never inferred. */
  readonly declaredBootstrap: boolean;
}

export interface ClassifyResult {
  readonly state: MigrationState;
  readonly pendingTags: string[];
  readonly expectedSetHash: string;
  readonly detail: string;
}

/** PURE classifier. No I/O. Deterministic. */
export function classifyMigrationState(inp: ClassifyInput): ClassifyResult {
  const expectedSetHash = migrationSetHash(inp.expected);
  const base = { pendingTags: [] as string[], expectedSetHash };

  // (1) migrations tracking table absent.
  if (inp.migrationsTableMissing || inp.applied === null) {
    if (inp.appSchemaPresent || inp.appDataPresent) {
      return { state: 'MIGRATION_TABLE_MISSING_NONEMPTY', ...base, detail: 'migration tracking table absent but application schema/data present' };
    }
    if (inp.declaredBootstrap) {
      return { state: 'BOOTSTRAP_EMPTY', pendingTags: inp.expected.map((m) => m.tag), expectedSetHash, detail: 'empty database explicitly declared bootstrap' };
    }
    // Empty, but not explicitly declared bootstrap: refuse to auto-initialize an unrecognized environment.
    return { state: 'MIGRATION_TABLE_MISSING_NONEMPTY', ...base, detail: 'migration tracking table absent and environment not declared bootstrap; refusing to auto-initialize' };
  }

  const A = inp.applied;
  const J = inp.expected;

  // (2) duplicate applied records.
  const seenHash = new Set<string>();
  const seenWhen = new Set<number>();
  for (const a of A) {
    if (seenHash.has(a.hash) || seenWhen.has(a.createdAt)) {
      return { state: 'UNKNOWN_DATABASE_DIVERGENCE', ...base, detail: 'duplicate applied migration record' };
    }
    seenHash.add(a.hash);
    seenWhen.add(a.createdAt);
  }

  // (3) database has MORE applied than the repo journal.
  if (A.length > J.length) {
    return { state: 'UNKNOWN_DATABASE_DIVERGENCE', ...base, detail: `database has ${A.length} applied migrations but repo journal has ${J.length}` };
  }

  // (4) applied must be a valid prefix: same order by `when`, same hash.
  for (let i = 0; i < A.length; i++) {
    if (A[i]!.createdAt !== J[i]!.when) {
      return { state: 'UNKNOWN_DATABASE_DIVERGENCE', ...base, detail: `applied[${i}] created_at ${A[i]!.createdAt} does not match journal when ${J[i]!.when} (reorder/divergence)` };
    }
    if (A[i]!.hash !== J[i]!.hash) {
      return { state: 'HISTORICAL_HASH_MISMATCH', ...base, detail: `applied[${i}] hash differs from repository hash for ${J[i]!.tag} (historical migration edited)` };
    }
  }

  // (5) exact match, or valid forward-pending.
  if (A.length === J.length) {
    return { state: 'NO_PENDING', ...base, detail: 'database and repository migration histories match exactly' };
  }
  const pendingTags = J.slice(A.length).map((m) => m.tag);
  return { state: 'PENDING_FORWARD', pendingTags, expectedSetHash, detail: `${pendingTags.length} unapplied forward migration(s)` };
}

/** Known Hub application tables probed to distinguish a clean bootstrap from an unrecognized non-empty DB. */
const APP_TABLES = ['organizations', 'profiles', 'projects', 'tasks', 'usage_events', 'audit_logs'] as const;

export interface DetectResult extends ClassifyResult {
  readonly expected: ExpectedMigration[];
  readonly appliedCount: number | null;
  readonly drizzleVersion: string | null;
}

/**
 * Read-only detector. Runs SELECTs only (regclass probes + counts + the migrations table). Any connection,
 * parse, filesystem, journal, query, or version-drift problem yields DETECTOR_FAILURE (fail closed).
 *
 * `declaredBootstrap` MUST come from an explicit operator declaration — the detector never infers bootstrap.
 */
export async function detectMigrationState(
  sql: Sql,
  opts: { migrationsFolder: string; declaredBootstrap?: boolean; nodeModulesDir?: string },
): Promise<DetectResult> {
  const drizzleVersion = installedDrizzleVersion(opts.nodeModulesDir);
  const failure = (detail: string, expected: ExpectedMigration[] = []): DetectResult => ({
    state: 'DETECTOR_FAILURE',
    pendingTags: [],
    expectedSetHash: expected.length ? migrationSetHash(expected) : '',
    detail,
    expected,
    appliedCount: null,
    drizzleVersion,
  });

  // Version guard: the hash mirror is only proven for the pinned version.
  if (drizzleVersion !== EXPECTED_DRIZZLE_VERSION) {
    return failure(`drizzle-orm version drift: expected ${EXPECTED_DRIZZLE_VERSION}, found ${drizzleVersion ?? 'unknown'} — re-verify the hash adapter before proceeding`);
  }

  let expected: ExpectedMigration[];
  try {
    expected = computeExpectedMigrations(opts.migrationsFolder);
  } catch (e) {
    if (e instanceof MigrationReadError) return failure(`repository migration read failed: ${e.message}`);
    return failure(`unexpected migration read error: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    const reg = await sql<{ t: string | null }[]>`select to_regclass('drizzle.__drizzle_migrations')::text as t`;
    const migrationsTableMissing = reg[0]?.t == null;

    // App-schema / app-data probe (read-only).
    let appSchemaPresent = false;
    let appDataPresent = false;
    for (const t of APP_TABLES) {
      const r = await sql<{ t: string | null }[]>`select to_regclass(${'public.' + t})::text as t`;
      if (r[0]?.t != null) {
        appSchemaPresent = true;
        const c = await sql<{ n: number }[]>`select count(*)::int as n from ${sql(t)}`;
        if ((c[0]?.n ?? 0) > 0) {
          appDataPresent = true;
          break;
        }
      }
    }

    let applied: AppliedMigration[] | null = null;
    if (!migrationsTableMissing) {
      const rows = await sql<{ hash: string; created_at: string }[]>`
        select hash, created_at::text as created_at from drizzle.__drizzle_migrations order by created_at asc, id asc`;
      applied = rows.map((r) => ({ hash: r.hash, createdAt: Number(r.created_at) }));
    }

    const result = classifyMigrationState({
      expected,
      applied,
      migrationsTableMissing,
      appSchemaPresent,
      appDataPresent,
      declaredBootstrap: opts.declaredBootstrap ?? false,
    });
    return { ...result, expected, appliedCount: applied ? applied.length : null, drizzleVersion };
  } catch (e) {
    return failure(`database query failed: ${e instanceof Error ? e.message : String(e)}`, expected);
  }
}
