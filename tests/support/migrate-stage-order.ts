/**
 * TEST-ONLY, PURE **structural tripwire** over the SOURCE TEXT of `scripts/migrate.ts`.
 *
 * WHAT THIS IS. A static, pure string check: it parses the migrate.ts source and asserts that a fixed set of
 * stage MARKERS are present and appear in the expected TEXTUAL ORDER. It is a CI shape-guard — an expected-shape
 * assertion that trips when the migrate.ts source is edited into an unexpected shape — nothing more. It runs no
 * code, opens no database, and reasons only about the characters of the source string it is handed.
 *
 * WHAT A FAILURE MEANS. Someone changed `scripts/migrate.ts` so that an expected stage marker is missing or out of
 * the expected textual order. That is a signal to STOP and have a human read the migrate.ts diff before it lands —
 * it catches an accidental structural regression (a reordered/removed stage) at review time. A failure is a
 * prompt to inspect, not a proof of danger.
 *
 * WHAT A PASS MEANS — AND ALL IT MEANS. The expected markers were found in the expected textual order in the
 * source string. That is the entire claim. A green tripwire is a static shape match, not a safety verdict.
 *
 * WHAT A PASS DOES **NOT** ESTABLISH (do not read any of these into a green result):
 *   - that the stages EXECUTE in that order on every runtime code path (this reads text, not behavior);
 *   - that a migration is transactionally safe, reversible, or rollback-able;
 *   - that the database is compatible or that migrations will apply cleanly;
 *   - that the pre-migration receipt gate will verify, or that a release/deploy will succeed;
 *   - that the schema, journal, or SQL is semantically correct or production-ready.
 * This check is a structural tripwire only; it does not validate migration safety or deployment readiness.
 *
 * WHERE THE REAL AUTHORIZATION LIVES. Deployment is authorized at RUNTIME by the G-Backup pre-migration receipt
 * gate — `runPreMigrationGate(...)` in `scripts/migrate.ts`, implemented in `scripts/backup/premigration-gate.ts`
 * — and migrations execute only via the release command. This tripwire is never imported by app/worker/deploy or
 * CI-workflow runtime code, and its result must never be used to bypass or stand in for that runtime gate.
 * Operators and future maintainers MUST NOT treat a green tripwire as a manual GO decision.
 *
 * WHY A TRIPWIRE (not the old byte check). The prior onboarding guard asserted byte-identity of migrate.ts against
 * `main` (`git diff --name-only main..HEAD -- scripts/migrate.ts` empty), which was WRONG (it assumed a local
 * `main`, absent in a CI PR checkout — the failure that motivated this) and too blunt (P1c LEGITIMATELY edits
 * migrate.ts). This replaces it with a pure source-shape assertion: no git history, no branch name, no hardcoded
 * commit hash, and it never compares the file to itself — so it can be exercised POSITIVELY against the real
 * committed source and NEGATIVELY against synthetic bad-ordered sources.
 *
 * Branch-aware by design. Two stages are OPTIONAL and checked only WHEN PRESENT, so the SAME tripwire accepts
 * accepted-main (which has neither) and the later P1c/P1d migrate.ts (which add them):
 *   - `ensureAppSchema(` — the P1c fresh-bootstrap prerequisite;
 *   - `verifyBootstrap(` / `--verify` — the P1d full-bootstrap verification.
 *
 * Expected source-shape markers checked (see scripts/migrate.ts):
 *   1. the pre-migration seam (`preMigrationBackup()` / `runPreMigrationGate(`) appears BEFORE any schema or
 *      migration write marker;
 *   2. `ensureAppSchema(` (WHEN PRESENT) appears AFTER the seam and BEFORE `migrate(`;
 *   3. `migrate(` appears BEFORE the RLS apply markers (`rls.sql` read + `sql.unsafe(`);
 *   4. verification (`verifyBootstrap(` / `--verify`, WHEN PRESENT) appears only AFTER RLS;
 *   5. the fatal-failure markers are present (top-level `main().catch` → `process.exit(1)`);
 *   6. the advisory lock (`pg_advisory_lock`) + release/cleanup (`pg_advisory_unlock`, `sql.end`) markers are
 *      present, the lock marker before the schema/migration markers, release/cleanup markers after them;
 *   7. the pre-migration seam marker is not removed.
 * These are TEXTUAL-ORDER expectations over the source, not runtime guarantees.
 */

/**
 * Fail-closed disclaimer surfaced in every tripwire failure message and available to CI/test output. Passing this
 * check is NOT deployment authorization — the runtime receipt gate (`runPreMigrationGate`) is.
 */
export const MIGRATE_STAGE_ORDER_TRIPWIRE_NOTE =
  'This check is a structural tripwire only; it does not validate migration safety or deployment readiness. ' +
  'Deployment is authorized at runtime by the G-Backup pre-migration receipt gate (runPreMigrationGate), not by this check.';

/**
 * Thrown when the structural tripwire trips (a stage marker is missing or out of the expected textual order).
 * The stable `.code` identifies which expectation failed. The message is suffixed with
 * {@link MIGRATE_STAGE_ORDER_TRIPWIRE_NOTE} so a CI failure states plainly that this is a shape check, not a
 * deployment-safety verdict.
 */
export class MigrateStageOrderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${message} — ${MIGRATE_STAGE_ORDER_TRIPWIRE_NOTE}`);
    this.name = 'MigrateStageOrderError';
    this.code = code;
  }
}

/**
 * Blank out `//` and block comments so markers written inside comments (e.g. the prose `... BEFORE migrate().`)
 * are not mistaken for real call sites, while PRESERVING string/template contents (markers like the `'rls.sql'`
 * string literal and the ``pg_advisory_lock`` inside the SQL template must survive). Replaces comment characters
 * with spaces so every retained marker keeps its original source index.
 */
export function blankComments(src: string): string {
  const out = src.split('');
  let mode: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' = 'code';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { out[i] = ' '; out[i + 1] = ' '; mode = 'line'; i += 2; continue; }
      if (c === '/' && d === '*') { out[i] = ' '; out[i + 1] = ' '; mode = 'block'; i += 2; continue; }
      if (c === "'") { mode = 'sq'; i++; continue; }
      if (c === '"') { mode = 'dq'; i++; continue; }
      if (c === '`') { mode = 'tpl'; i++; continue; }
      i++; continue;
    }
    if (mode === 'line') { if (c === '\n') mode = 'code'; else out[i] = ' '; i++; continue; }
    if (mode === 'block') { if (c === '*' && d === '/') { out[i] = ' '; out[i + 1] = ' '; mode = 'code'; i += 2; continue; } if (c !== '\n') out[i] = ' '; i++; continue; }
    if (mode === 'sq') { if (c === '\\') { i += 2; continue; } if (c === "'") mode = 'code'; i++; continue; }
    if (mode === 'dq') { if (c === '\\') { i += 2; continue; } if (c === '"') mode = 'code'; i++; continue; }
    /* tpl */ if (c === '\\') { i += 2; continue; } if (c === '`') mode = 'code'; i++; continue;
  }
  return out.join('');
}

export interface MigrateStageIndices {
  readonly backupCall: number;
  readonly advisoryLock: number;
  /** Index of the REQUIRED `ensureAppSchema(` stage (B2a×P1c contract). */
  readonly ensureAppSchema: number;
  readonly migrate: number;
  readonly rlsFile: number;
  readonly rlsApply: number;
  /** Index of the REQUIRED `verifyBootstrap(` stage (B2a×P1c contract). */
  readonly verify: number;
  readonly advisoryUnlock: number;
  readonly sqlEnd: number;
}

/**
 * PURE structural tripwire. Asserts the `scripts/migrate.ts` source has the expected stage MARKERS in the expected
 * TEXTUAL ORDER. Throws `MigrateStageOrderError` (with a stable `.code`) on the FIRST unmet expectation; returns
 * the located marker indices on success. Does NOT compare the source to git or to the current branch, and does NOT
 * execute anything — it reads only the characters of `rawSource`. A pass is a static shape match, NOT a
 * migration-safety or deployment-readiness verdict (see the file header and {@link MIGRATE_STAGE_ORDER_TRIPWIRE_NOTE}).
 */
export function assertMigrateStageOrder(rawSource: string): MigrateStageIndices {
  const source = blankComments(rawSource);
  const firstIndex = (re: RegExp, code: string, label: string): number => {
    const m = re.exec(source);
    if (!m) throw new MigrateStageOrderError(code, `scripts/migrate.ts is missing ${label}`);
    return m.index;
  };
  const firstIndexAny = (res: RegExp[], code: string, label: string): number => {
    let best = -1;
    for (const re of res) {
      const m = re.exec(source);
      if (m && (best < 0 || m.index < best)) best = m.index;
    }
    if (best < 0) throw new MigrateStageOrderError(code, `scripts/migrate.ts is missing ${label}`);
    return best;
  };

  // (7) the PRE-MIGRATION SAFETY SEAM must be present (not removed): either the best-effort backup
  // (`preMigrationBackup();`) OR the G-Backup-B2a verification gate (`runPreMigrationGate(...)`) that replaces it.
  // The `;` / `(` terminator distinguishes the invocation from the function definition or a bare import specifier.
  const backupCall = firstIndexAny(
    [/\bpreMigrationBackup\s*\(\s*\)\s*;/, /\brunPreMigrationGate\s*\(/],
    'backup_call_missing',
    'the pre-migration safety seam (preMigrationBackup(); or runPreMigrationGate(...))',
  );
  // (6) advisory lock + release + connection cleanup must be present.
  const advisoryLock = firstIndex(/pg_advisory_lock\b/, 'advisory_lock_missing', 'the pg_advisory_lock acquisition');
  const advisoryUnlock = firstIndex(/pg_advisory_unlock\b/, 'advisory_unlock_missing', 'the pg_advisory_unlock release');
  const sqlEnd = firstIndex(/\bsql\.end\s*\(/, 'sql_end_missing', 'the sql.end() connection cleanup');
  // (2/3) the drizzle migrate call (the import `{ migrate }` has no `(` so it is not matched).
  const migrate = firstIndex(/\bmigrate\s*\(/, 'migrate_missing', 'the migrate() call');
  // (3) RLS apply: the rls.sql read + the sql.unsafe application.
  const rlsFile = firstIndex(/rls\.sql\b/, 'rls_file_missing', 'the rls.sql read');
  const rlsApply = firstIndex(/\bsql\.unsafe\s*\(/, 'rls_apply_missing', 'the RLS apply (sql.unsafe(...))');
  // (2) REQUIRED bootstrap prerequisite; (4) REQUIRED verification — the final B2a×P1c contract wires BOTH the
  // fresh-database `ensureAppSchema` and the opt-in `verifyBootstrap` into scripts/migrate.ts, so their ABSENCE
  // is a failure (the stage-order check must not pass vacuously when a required P1c stage is missing).
  const ensureAppSchema = firstIndex(/\bensureAppSchema\s*\(/, 'ensure_app_schema_missing', 'the ensureAppSchema bootstrap prerequisite call');
  const verify = firstIndex(/\bverifyBootstrap\s*\(/, 'verify_missing', 'the verifyBootstrap verification call');

  // (5) failure remains fatal: a top-level main().catch handler that exits nonzero.
  if (!/\bmain\s*\([^)]*\)[\s\S]*?\.catch\s*\(/.test(source)) {
    throw new MigrateStageOrderError('no_top_level_catch', 'scripts/migrate.ts has no top-level main().catch handler');
  }
  if (!/process\.exit\s*\(\s*1\s*\)/.test(source)) {
    throw new MigrateStageOrderError('failure_not_fatal', 'a migration/RLS/verification failure is not fatal: no process.exit(1) in scripts/migrate.ts');
  }

  const requireOrder = (a: number, b: number, code: string, message: string): void => {
    if (!(a < b)) throw new MigrateStageOrderError(code, message);
  };

  // (1) the pre-migration safety seam (gate) runs BEFORE any schema creation OR migration write.
  requireOrder(backupCall, ensureAppSchema, 'backup_after_schema', 'the pre-migration gate must run BEFORE any schema creation (ensureAppSchema)');
  requireOrder(backupCall, migrate, 'backup_after_migrate', 'the pre-migration gate must run BEFORE migrate()');
  // (6) advisory lock acquired before the schema/migration work.
  requireOrder(advisoryLock, ensureAppSchema, 'lock_after_schema', 'the advisory lock must be acquired BEFORE the schema/migration work');
  requireOrder(advisoryLock, migrate, 'lock_after_migrate', 'the advisory lock must be acquired BEFORE migrate()');
  // (2) ensureAppSchema after the gate boundary and before migrate.
  requireOrder(ensureAppSchema, migrate, 'schema_after_migrate', 'ensureAppSchema must run AFTER the gate and BEFORE migrate()');
  // (3) migrate before RLS apply.
  requireOrder(migrate, rlsApply, 'rls_before_migrate', 'migrate() must run BEFORE the RLS apply (sql.unsafe)');
  // (4) verification only after RLS.
  requireOrder(rlsApply, verify, 'verify_before_rls', 'verification (verifyBootstrap) must run only AFTER the RLS apply');
  // (6) release + cleanup after ALL operational stages — verification runs BEFORE cleanup.
  requireOrder(migrate, advisoryUnlock, 'unlock_before_migrate', 'the advisory lock must be released AFTER the migration work');
  requireOrder(verify, advisoryUnlock, 'cleanup_before_verify', 'verification (verifyBootstrap) must run BEFORE cleanup (advisory unlock)');
  requireOrder(advisoryUnlock, sqlEnd, 'end_before_unlock', 'the connection cleanup (sql.end) must run after the advisory unlock');

  return { backupCall, advisoryLock, ensureAppSchema, migrate, rlsFile, rlsApply, verify, advisoryUnlock, sqlEnd };
}
