/**
 * TEST-ONLY, PURE checker for the deployment path `scripts/migrate.ts`.
 *
 * G-Backup-B1/B2a hygiene concern: the migrate command is the seam where the pre-migration backup boundary and
 * the future enforced backup gate live. A regression that reorders the safety stages — or swallows a failure, or
 * drops the advisory lock — would silently defeat that protection. The OLD onboarding test guarded this with a
 * byte-identity assertion (`git diff --name-only main..HEAD -- scripts/migrate.ts` must be empty), which was both
 * WRONG (it assumed a local branch named `main`, absent in a CI PR checkout — the failure that motivated this) and
 * too blunt (P1c LEGITIMATELY changes migrate.ts, so byte-identity says nothing about SAFETY).
 *
 * This checker replaces that with a SEMANTIC invariant: it parses the migrate.ts source and verifies the required
 * safety-stage ORDER and properties, permitting authorized changes and rejecting unsafe ones. It is a pure
 * function of the source text — no git history, no branch name, no hardcoded commit hash, and it never compares
 * the file to itself — so it can be exercised POSITIVELY against the real committed source and NEGATIVELY against
 * synthetic bad-ordered sources.
 *
 * Branch-aware by design. Two stages are OPTIONAL and verified only WHEN PRESENT, so the SAME checker accepts
 * accepted-main (which has neither) and the later P1c/P1d migrate.ts (which add them):
 *   - `ensureAppSchema(` — the P1c fresh-bootstrap prerequisite;
 *   - `verifyBootstrap(` / `--verify` — the P1d full-bootstrap verification.
 *
 * Required invariants (see scripts/migrate.ts):
 *   1. the pre-migration backup hook (`preMigrationBackup()`) runs BEFORE any schema or migration write;
 *   2. `ensureAppSchema(` (WHEN PRESENT) runs AFTER the backup boundary and BEFORE `migrate(`;
 *   3. `migrate(` runs BEFORE the RLS apply (`rls.sql` read + `sql.unsafe(`);
 *   4. verification (`verifyBootstrap(` / `--verify`, WHEN PRESENT) runs only AFTER RLS;
 *   5. a migration/RLS/verification failure remains FATAL (top-level `main().catch` → `process.exit(1)`);
 *   6. the advisory lock (`pg_advisory_lock`) + release/cleanup (`pg_advisory_unlock`, `sql.end`) remain present,
 *      lock acquired before the schema/migration work, released and connection closed after it;
 *   7. the migrate command does not bypass the backup seam (the backup call is not removed/short-circuited).
 */

export class MigrateStageOrderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
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
  /** -1 when the OPTIONAL `ensureAppSchema(` stage is absent (accepted-main). */
  readonly ensureAppSchema: number;
  readonly migrate: number;
  readonly rlsFile: number;
  readonly rlsApply: number;
  /** -1 when the OPTIONAL `verifyBootstrap(` stage is absent (accepted-main). */
  readonly verify: number;
  readonly advisoryUnlock: number;
  readonly sqlEnd: number;
}

/**
 * PURE. Verifies `scripts/migrate.ts` source preserves its safety-stage ordering + properties. Throws
 * `MigrateStageOrderError` (with a stable `.code`) on the FIRST violation; returns the located stage indices on
 * success (optional stages are `-1` when absent). Does NOT compare the source to git or to the current branch — it
 * reasons about the source itself.
 */
export function assertMigrateStageOrder(rawSource: string): MigrateStageIndices {
  const source = blankComments(rawSource);
  const firstIndex = (re: RegExp, code: string, label: string): number => {
    const m = re.exec(source);
    if (!m) throw new MigrateStageOrderError(code, `scripts/migrate.ts is missing ${label}`);
    return m.index;
  };
  const optionalIndex = (re: RegExp): number => {
    const m = re.exec(source);
    return m ? m.index : -1;
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
  // (2) OPTIONAL bootstrap prerequisite; (4) OPTIONAL verification — verified in order only when present.
  const ensureAppSchema = optionalIndex(/\bensureAppSchema\s*\(/);
  const verify = optionalIndex(/\bverifyBootstrap\s*\(/);

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

  // (1) backup before any schema OR migration write.
  if (ensureAppSchema >= 0) requireOrder(backupCall, ensureAppSchema, 'backup_after_schema', 'the pre-migration backup must run BEFORE any schema creation (ensureAppSchema)');
  requireOrder(backupCall, migrate, 'backup_after_migrate', 'the pre-migration backup must run BEFORE migrate()');
  // (6) advisory lock acquired before the schema/migration work.
  if (ensureAppSchema >= 0) requireOrder(advisoryLock, ensureAppSchema, 'lock_after_schema', 'the advisory lock must be acquired BEFORE the schema/migration work');
  requireOrder(advisoryLock, migrate, 'lock_after_migrate', 'the advisory lock must be acquired BEFORE migrate()');
  // (2) ensureAppSchema (when present) after the backup boundary and before migrate.
  if (ensureAppSchema >= 0) requireOrder(ensureAppSchema, migrate, 'schema_after_migrate', 'ensureAppSchema must run AFTER the backup boundary and BEFORE migrate()');
  // (3) migrate before RLS apply.
  requireOrder(migrate, rlsApply, 'rls_before_migrate', 'migrate() must run BEFORE the RLS apply (sql.unsafe)');
  // (4) verification (when present) only after RLS.
  if (verify >= 0) requireOrder(rlsApply, verify, 'verify_before_rls', 'verification (verifyBootstrap) must run only AFTER the RLS apply');
  // (6) release + cleanup after the migration work.
  requireOrder(migrate, advisoryUnlock, 'unlock_before_migrate', 'the advisory lock must be released AFTER the migration work');
  requireOrder(advisoryUnlock, sqlEnd, 'end_before_unlock', 'the connection cleanup (sql.end) must run after the advisory unlock');

  return { backupCall, advisoryLock, ensureAppSchema, migrate, rlsFile, rlsApply, verify, advisoryUnlock, sqlEnd };
}
