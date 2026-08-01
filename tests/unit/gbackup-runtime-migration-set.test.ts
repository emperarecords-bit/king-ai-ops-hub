import { describe, expect, it } from 'vitest';
import { buildSourceManifestFromGit } from '../../scripts/backup/source-manifest';
import {
  RuntimeMigrationSetError,
  computeRuntimeMigrationSet,
  readRuntimeMigrationSet,
} from '../../scripts/backup/runtime-migration-set';

const F = (i: number, tag: string, body: string) => ({ migrationIndex: i, migrationTag: tag, migrationPath: `drizzle/${tag}.sql`, bytes: Buffer.from(body, 'utf8') });
const BASE = [F(1, '0001_alpha', 'CREATE TABLE a();\n'), F(0, '0000_seed', 'SELECT 1;\n')];
const PINNED = 'f4e33fb61231ec40eedc5d7f4c7a168bd330723701f3e2a510cf19d7a5059048';

describe('G-Backup-B1 runtime migration-set hash', () => {
  it('is stable/deterministic and pinned (cross-platform: bytes + POSIX path only)', () => {
    expect(computeRuntimeMigrationSet(BASE).runtimeMigrationSetHash).toBe(PINNED);
    expect(computeRuntimeMigrationSet(BASE).runtimeMigrationSetHash).toBe(computeRuntimeMigrationSet(BASE).runtimeMigrationSetHash);
  });
  it('input path ordering does not alter the result (entries are sorted by index)', () => {
    const reordered = [BASE[0]!, BASE[1]!];
    const other = [BASE[1]!, BASE[0]!];
    expect(computeRuntimeMigrationSet(reordered).runtimeMigrationSetHash).toBe(computeRuntimeMigrationSet(other).runtimeMigrationSetHash);
  });
  it('an exact-byte mutation changes the hash', () => {
    const mutated = [F(0, '0000_seed', 'SELECT 1;\n'), F(1, '0001_alpha', 'CREATE TABLE a( );\n')];
    expect(computeRuntimeMigrationSet(mutated).runtimeMigrationSetHash).not.toBe(PINNED);
  });
  it('preserves byte distinctions (trailing newline matters)', () => {
    const a = [F(0, '0000_seed', 'SELECT 1;')];
    const b = [F(0, '0000_seed', 'SELECT 1;\n')];
    expect(computeRuntimeMigrationSet(a).runtimeMigrationSetHash).not.toBe(computeRuntimeMigrationSet(b).runtimeMigrationSetHash);
  });
  it('rejects duplicate index / tag / path', () => {
    expect(() => computeRuntimeMigrationSet([F(0, '0000_a', 'x'), F(0, '0001_b', 'y')])).toThrow(RuntimeMigrationSetError);
    expect(() => computeRuntimeMigrationSet([F(0, '0000_a', 'x'), F(1, '0000_a', 'y')])).toThrow(RuntimeMigrationSetError);
    expect(() => computeRuntimeMigrationSet([{ migrationIndex: 0, migrationTag: '0000_a', migrationPath: 'drizzle/dup.sql', bytes: Buffer.from('x') }, { migrationIndex: 1, migrationTag: '0001_b', migrationPath: 'drizzle/dup.sql', bytes: Buffer.from('y') }])).toThrow(RuntimeMigrationSetError);
  });
  it('rejects traversal / non-canonical paths', () => {
    expect(() => computeRuntimeMigrationSet([{ migrationIndex: 0, migrationTag: '0000_a', migrationPath: 'drizzle/../x.sql', bytes: Buffer.from('x') }])).toThrow(RuntimeMigrationSetError);
    expect(() => computeRuntimeMigrationSet([{ migrationIndex: 0, migrationTag: '0000_a', migrationPath: '/abs/x.sql', bytes: Buffer.from('x') }])).toThrow(RuntimeMigrationSetError);
    expect(() => computeRuntimeMigrationSet([{ migrationIndex: 0, migrationTag: '0000_a', migrationPath: 'drizzle\\x.sql', bytes: Buffer.from('x') }])).toThrow(RuntimeMigrationSetError);
  });
  it('reads the real baked drizzle folder and is DISTINCT from the portable git-blob set-hash', () => {
    const runtime = readRuntimeMigrationSet(process.cwd(), 'drizzle');
    expect(runtime.runtimeMigrationSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(runtime.entries.length).toBeGreaterThan(0);
    const portable = buildSourceManifestFromGit('HEAD', 'drizzle').sourceMigrationSetHash;
    expect(runtime.runtimeMigrationSetHash).not.toBe(portable); // two distinct, non-conflated hashes
  });
});
