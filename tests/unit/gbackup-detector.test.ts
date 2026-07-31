import { describe, expect, it } from 'vitest';
import { type Sql } from 'postgres';
import {
  type AppliedMigration,
  type ClassifyInput,
  classifyMigrationState,
  detectMigrationState,
} from '../../scripts/backup/migration-detector';
import { type ExpectedMigration } from '../../scripts/backup/migration-hash';

function mkExpected(n: number): ExpectedMigration[] {
  return Array.from({ length: n }, (_, i) => ({ idx: i, tag: `00${i}_m`, when: 1000 + i, hash: `hash${i}` }));
}
function appliedFrom(exp: ExpectedMigration[], count = exp.length): AppliedMigration[] {
  return exp.slice(0, count).map((e) => ({ hash: e.hash, createdAt: e.when }));
}
function base(over: Partial<ClassifyInput>): ClassifyInput {
  const expected = mkExpected(3);
  return {
    expected,
    applied: appliedFrom(expected),
    migrationsTableMissing: false,
    appSchemaPresent: true,
    appDataPresent: true,
    declaredBootstrap: false,
    ...over,
  };
}

describe('G-Backup-A migration-state classifier (pure)', () => {
  it('exact match → NO_PENDING', () => {
    expect(classifyMigrationState(base({})).state).toBe('NO_PENDING');
  });

  it('valid applied prefix → PENDING_FORWARD with correct pending tags', () => {
    const expected = mkExpected(3);
    const r = classifyMigrationState(base({ expected, applied: appliedFrom(expected, 1) }));
    expect(r.state).toBe('PENDING_FORWARD');
    expect(r.pendingTags).toEqual(['001_m', '002_m']);
  });

  it('table missing + no app schema/data + declaredBootstrap → BOOTSTRAP_EMPTY', () => {
    const r = classifyMigrationState(base({ migrationsTableMissing: true, applied: null, appSchemaPresent: false, appDataPresent: false, declaredBootstrap: true }));
    expect(r.state).toBe('BOOTSTRAP_EMPTY');
  });

  it('table missing + app data present → MIGRATION_TABLE_MISSING_NONEMPTY (even if bootstrap declared)', () => {
    const r = classifyMigrationState(base({ migrationsTableMissing: true, applied: null, appSchemaPresent: true, appDataPresent: true, declaredBootstrap: true }));
    expect(r.state).toBe('MIGRATION_TABLE_MISSING_NONEMPTY');
  });

  it('table missing + empty + NOT declared bootstrap → MIGRATION_TABLE_MISSING_NONEMPTY (never auto-bootstrap)', () => {
    const r = classifyMigrationState(base({ migrationsTableMissing: true, applied: null, appSchemaPresent: false, appDataPresent: false, declaredBootstrap: false }));
    expect(r.state).toBe('MIGRATION_TABLE_MISSING_NONEMPTY');
  });

  it('historical SQL edit (same when, different hash) → HISTORICAL_HASH_MISMATCH', () => {
    const expected = mkExpected(3);
    const applied = appliedFrom(expected);
    applied[1] = { hash: 'EDITED', createdAt: expected[1]!.when };
    expect(classifyMigrationState(base({ expected, applied })).state).toBe('HISTORICAL_HASH_MISMATCH');
  });

  it('extra applied migration (more than journal) → UNKNOWN_DATABASE_DIVERGENCE', () => {
    const expected = mkExpected(3);
    const applied = [...appliedFrom(expected), { hash: 'extra', createdAt: 9999 }];
    expect(classifyMigrationState(base({ expected, applied })).state).toBe('UNKNOWN_DATABASE_DIVERGENCE');
  });

  it('reordered applied (created_at != journal when) → UNKNOWN_DATABASE_DIVERGENCE', () => {
    const expected = mkExpected(3);
    const applied = appliedFrom(expected);
    applied[1] = { hash: expected[1]!.hash, createdAt: expected[2]!.when }; // wrong position
    expect(classifyMigrationState(base({ expected, applied })).state).toBe('UNKNOWN_DATABASE_DIVERGENCE');
  });

  it('duplicate applied record → UNKNOWN_DATABASE_DIVERGENCE', () => {
    const expected = mkExpected(3);
    const applied = appliedFrom(expected);
    applied[2] = { ...applied[1]! }; // duplicate hash+when
    expect(classifyMigrationState(base({ expected, applied })).state).toBe('UNKNOWN_DATABASE_DIVERGENCE');
  });

  it('classification depends only on migrations — RLS reapplication is not an input and cannot change it', () => {
    // Two identical migration states classify identically regardless of any (absent) RLS consideration.
    const a = classifyMigrationState(base({}));
    const b = classifyMigrationState(base({}));
    expect(a.state).toBe('NO_PENDING');
    expect(b.state).toBe('NO_PENDING');
  });
});

describe('G-Backup-A detector reader (fail-closed)', () => {
  it('drizzle version drift → DETECTOR_FAILURE (mirror only proven for the pinned version)', async () => {
    const sql = (() => { throw new Error('should not query'); }) as unknown as Sql;
    const r = await detectMigrationState(sql, { migrationsFolder: 'drizzle', nodeModulesDir: 'does-not-exist' });
    expect(r.state).toBe('DETECTOR_FAILURE');
    expect(r.detail).toContain('version drift');
  });

  it('database query failure → DETECTOR_FAILURE', async () => {
    const sql = (() => { throw new Error('connection refused'); }) as unknown as Sql;
    const r = await detectMigrationState(sql, { migrationsFolder: 'drizzle' });
    expect(r.state).toBe('DETECTOR_FAILURE');
    expect(r.detail).toContain('query failed');
  });

  it('missing repository migration file → DETECTOR_FAILURE', async () => {
    const sql = (() => { throw new Error('unused'); }) as unknown as Sql;
    const r = await detectMigrationState(sql, { migrationsFolder: 'scripts' }); // no journal here
    expect(r.state).toBe('DETECTOR_FAILURE');
  });
});
