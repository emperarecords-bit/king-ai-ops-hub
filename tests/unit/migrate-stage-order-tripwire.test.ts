import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MIGRATE_STAGE_ORDER_TRIPWIRE_NOTE,
  MigrateStageOrderError,
  assertMigrateStageOrder,
  blankComments,
} from '../support/migrate-stage-order';

/**
 * `assertMigrateStageOrder` is a STRUCTURAL TRIPWIRE, not a deployment-safety validator. These tests pin that
 * meaning so neither operators nor future maintainers can drift into treating a green check as proof that a
 * migration is safe, a release will succeed, the receipt gate will pass, a database is compatible, or a rollback
 * is possible. Everything here is pure: fixtures are in-memory strings and committed source text; no database,
 * receipt verifier, deploy command, or migration runner is touched.
 */

const NL = '\n';

// A synthetic, fully-staged GOOD source (the reconciled B2a×P1c shape under one advisory lock).
const GOOD = [
  'async function main() {',
  '  await sql`select pg_advisory_lock(4021)`;',
  '  try {',
  '    await runPreMigrationGate(config);',
  '    await ensureAppSchema(sql);',
  '    await migrate(db, { migrationsFolder: "drizzle" });',
  '    await sql.unsafe(readFileSync("rls.sql", "utf8"));',
  '    await verifyBootstrap(sql);',
  '  } finally {',
  '    await sql`select pg_advisory_unlock(4021)`;',
  '    await sql.end();',
  '  }',
  '}',
  'main().catch((err) => { console.error(err); process.exit(1); });',
  '',
].join(NL);

describe('migrate-stage-order — structural tripwire semantics (static source check; NOT deployment validation)', () => {
  it('PASSES a well-shaped source and returns only located marker indices (no side effects, synchronous)', () => {
    const result = assertMigrateStageOrder(GOOD);
    // A pure, synchronous return of indices — not a Promise, not a safety verdict.
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.backupCall).toBeLessThan(result.ensureAppSchema);
    expect(result.ensureAppSchema).toBeLessThan(result.migrate);
    expect(result.migrate).toBeLessThan(result.rlsApply);
    expect(result.rlsApply).toBeLessThan(result.verify);
    // Deterministic: same input → same output (a pure function of the source text).
    expect(assertMigrateStageOrder(GOOD)).toEqual(result);
  });

  it('TRIPS when a stage marker is reordered (migrate before ensureAppSchema)', () => {
    const reordered = GOOD.replace('    await ensureAppSchema(sql);' + NL, '').replace(
      'await migrate(db, { migrationsFolder: "drizzle" });',
      'await migrate(db, { migrationsFolder: "drizzle" }); await ensureAppSchema(sql);',
    );
    expect(() => assertMigrateStageOrder(reordered)).toThrow(MigrateStageOrderError);
    try {
      assertMigrateStageOrder(reordered);
    } catch (e) {
      expect((e as MigrateStageOrderError).code).toBe('schema_after_migrate');
    }
  });

  it('TRIPS when a required stage marker is missing (no runPreMigrationGate seam)', () => {
    const missing = GOOD.replace('    await runPreMigrationGate(config);' + NL, '');
    try {
      assertMigrateStageOrder(missing);
      throw new Error('expected a trip');
    } catch (e) {
      expect(e).toBeInstanceOf(MigrateStageOrderError);
      expect((e as MigrateStageOrderError).code).toBe('backup_call_missing');
    }
  });

  it('TRIPS on a duplicate/ambiguous critical marker placed in the wrong position (first-match ordering)', () => {
    // A stray EARLY migrate() (before the gate) — first-match picks it, so the gate now sits AFTER migrate().
    const ambiguous = GOOD.replace(
      '  try {' + NL,
      '  try {' + NL + '    await migrate(db, { migrationsFolder: "early" });' + NL,
    );
    try {
      assertMigrateStageOrder(ambiguous);
      throw new Error('expected a trip');
    } catch (e) {
      expect(e).toBeInstanceOf(MigrateStageOrderError);
      expect((e as MigrateStageOrderError).code).toBe('backup_after_migrate');
    }
  });

  it('CANNOT be satisfied by markers that appear only inside comments', () => {
    // Replace the real gate call with a comment mentioning it — blankComments() erases comment text, so the
    // marker is absent and the tripwire trips exactly as if it were deleted. Textual mentions cannot fake a stage.
    const commentOnly = GOOD.replace(
      '    await runPreMigrationGate(config);',
      '    // await runPreMigrationGate(config);  <-- prose reference only, not a call',
    );
    expect(blankComments(commentOnly).includes('runPreMigrationGate')).toBe(false);
    try {
      assertMigrateStageOrder(commentOnly);
      throw new Error('expected a trip');
    } catch (e) {
      expect((e as MigrateStageOrderError).code).toBe('backup_call_missing');
    }
  });

  it('a comment listing every stage in the right order still TRIPS (comments are not calls)', () => {
    const allComments = [
      '// runPreMigrationGate(config); ensureAppSchema(sql); migrate(db); sql.unsafe(rls); verifyBootstrap(sql);',
      '// pg_advisory_lock pg_advisory_unlock sql.end() process.exit(1) main().catch(',
      'const x = 1;',
    ].join(NL);
    expect(() => assertMigrateStageOrder(allComments)).toThrow(MigrateStageOrderError);
  });
});

describe('migrate-stage-order — a PASS invokes no database, receipt verifier, deploy command, or migration runner', () => {
  const moduleSource = readFileSync(join('tests', 'support', 'migrate-stage-order.ts'), 'utf8');

  it('the tripwire module imports nothing (no runtime dependency it could invoke)', () => {
    // A pure text checker has zero imports — it cannot reach a db client, provider, receipt signer/verifier,
    // deploy command, or migration runner because it depends on none of them.
    const importLines = moduleSource.split(NL).filter((l) => /^\s*import\b/.test(l));
    expect(importLines).toEqual([]);
  });

  it('the tripwire module loads no module and reaches no db / provider / deploy dependency', () => {
    // No module-loading construct of any kind (import statements already asserted above; also no require()/
    // dynamic import()). And no dependency-loader token for a db client, provider, or shell/deploy surface.
    // NOTE: the string `runPreMigrationGate` legitimately appears here — as a DETECTION regex that finds the
    // seam marker in migrate.ts's TEXT, and as a doc pointer to the real gate — so it is NOT forbidden; the
    // invariant is that the module IMPORTS/INVOKES nothing, which the tokens below (loader constructs) capture.
    const forbidden = ['require(', 'import(', "from '", '@/db', 'postgres', 'drizzle-orm', 'child_process', 'node:'];
    const hits = forbidden.filter((token) => moduleSource.includes(token));
    expect(hits, `tripwire must load/reach nothing, but found: ${hits.join(', ')}`).toEqual([]);
  });

  it('exercising the tripwire is synchronous and self-contained (returns indices, throws nothing external)', () => {
    // If a PASS silently reached a database/receipt/deploy path, this pure call could not complete synchronously
    // with only an in-memory string and no environment. It does — proving the check is inert beyond parsing.
    const before = process.env;
    const result = assertMigrateStageOrder(GOOD);
    expect(process.env).toBe(before); // no env mutation
    expect(Object.keys(result).sort()).toEqual(
      ['advisoryLock', 'advisoryUnlock', 'backupCall', 'ensureAppSchema', 'migrate', 'rlsApply', 'rlsFile', 'sqlEnd', 'verify'].sort(),
    );
  });
});

describe('migrate-stage-order — deploy-path separation (the tripwire is not wired into runtime/deploy/CI)', () => {
  /** Files (repo-relative) importing the tripwire by module specifier, restricted to a path set. */
  function importersUnder(...paths: string[]): string[] {
    let out = '';
    try {
      out = execFileSync('git', ['grep', '-l', 'migrate-stage-order', '--', ...paths], { encoding: 'utf8' });
    } catch {
      out = ''; // git grep exits nonzero when there are zero matches
    }
    return out.split(NL).map((s) => s.trim()).filter(Boolean);
  }

  it('no runtime app code (src/) imports the tripwire', () => {
    expect(importersUnder('src')).toEqual([]);
  });

  it('no deploy/release script or migration entrypoint imports the tripwire', () => {
    // scripts/migrate.ts (the release-command migration entrypoint) and the receipt gate must not depend on it —
    // the tripwire inspects migrate.ts as text; migrate.ts must never import the thing that inspects it.
    expect(importersUnder('scripts')).toEqual([]);
    expect(readFileSync(join('scripts', 'migrate.ts'), 'utf8').includes('migrate-stage-order')).toBe(false);
    expect(readFileSync(join('scripts', 'backup', 'premigration-gate.ts'), 'utf8').includes('migrate-stage-order')).toBe(false);
  });

  it('no CI workflow references the tripwire as a deploy gate', () => {
    expect(importersUnder('.github')).toEqual([]);
  });

  it('the tripwire IS exercised from the test tree (sanity: the separation checks above are meaningful)', () => {
    expect(importersUnder('tests').length).toBeGreaterThan(0);
  });
});

describe('migrate-stage-order — user-facing wording identifies a tripwire, not a deployment validator', () => {
  const moduleSource = readFileSync(join('tests', 'support', 'migrate-stage-order.ts'), 'utf8');

  it('exports a fail-closed disclaimer that denies deployment authorization', () => {
    expect(MIGRATE_STAGE_ORDER_TRIPWIRE_NOTE).toMatch(/structural tripwire only/i);
    expect(MIGRATE_STAGE_ORDER_TRIPWIRE_NOTE).toMatch(/does not validate migration safety or deployment readiness/i);
    expect(MIGRATE_STAGE_ORDER_TRIPWIRE_NOTE).toMatch(/runPreMigrationGate/);
  });

  it('every trip surfaces the disclaimer in its message (fail-closed, visible in CI output)', () => {
    try {
      assertMigrateStageOrder(GOOD.replace('    await runPreMigrationGate(config);' + NL, ''));
      throw new Error('expected a trip');
    } catch (e) {
      expect((e as Error).message).toContain(MIGRATE_STAGE_ORDER_TRIPWIRE_NOTE);
    }
  });

  it('the module documents itself as a structural tripwire and lists its non-guarantees', () => {
    expect(moduleSource).toMatch(/structural tripwire/i);
    // The header enumerates what a PASS does NOT establish, and where real authorization lives.
    expect(moduleSource).toMatch(/DOES \*\*NOT\*\* ESTABLISH/);
    expect(moduleSource).toMatch(/deployment is authorized at runtime/i);
    expect(moduleSource).toMatch(/MUST NOT treat a green tripwire as a manual GO/i);
    // The overstated framing is gone: the module must not describe itself as validating/proving safety.
    expect(moduleSource).not.toMatch(/verifies the required[\s\S]{0,40}safety-stage/i);
  });

  it('the consuming integration test labels the suite a structural tripwire, not deployment validation', () => {
    const onboarding = readFileSync(join('tests', 'integration', 'gbackup-active-onboarding.test.ts'), 'utf8');
    expect(onboarding).toMatch(/stage-order structural tripwire \(static source check; not deployment validation\)/);
  });
});
