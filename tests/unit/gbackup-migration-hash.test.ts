import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_DRIZZLE_VERSION,
  MigrationReadError,
  computeExpectedMigrations,
  hashMigrationText,
  installedDrizzleVersion,
  migrationSetHash,
  readJournal,
} from '../../scripts/backup/migration-hash';

describe('G-Backup-A migration hashing (drizzle 0.45.2 mirror)', () => {
  it('hashMigrationText is sha256 over the raw text (known empty-string vector)', () => {
    expect(hashMigrationText('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(hashMigrationText('SELECT 1;')).toBe(createHash('sha256').update('SELECT 1;').digest('hex'));
  });

  it('installed drizzle matches the pinned EXPECTED_DRIZZLE_VERSION', () => {
    expect(installedDrizzleVersion()).toBe(EXPECTED_DRIZZLE_VERSION);
  });

  it('computeExpectedMigrations reads the repo journal, ordered, drizzle-compatible hashes', () => {
    const migs = computeExpectedMigrations('drizzle');
    expect(migs.length).toBe(54);
    // ordered by idx ascending
    for (let i = 1; i < migs.length; i++) expect(migs[i]!.idx).toBeGreaterThan(migs[i - 1]!.idx);
    const last = migs[migs.length - 1]!;
    expect(last.tag).toBe('0053_pricing_foundations');
    // hash equals sha256 of the raw file (the exact drizzle algorithm)
    const raw = readFileSync('drizzle/0053_pricing_foundations.sql', 'utf8');
    expect(last.hash).toBe(createHash('sha256').update(raw).digest('hex'));
  });

  it('migrationSetHash is deterministic and order-sensitive', () => {
    const migs = computeExpectedMigrations('drizzle');
    expect(migrationSetHash(migs)).toBe(migrationSetHash(migs));
    expect(migrationSetHash(migs)).toMatch(/^[0-9a-f]{64}$/);
    const swapped = [migs[1]!, migs[0]!, ...migs.slice(2)];
    expect(migrationSetHash(swapped)).not.toBe(migrationSetHash(migs));
  });

  it('readJournal throws MigrationReadError on a missing journal', () => {
    expect(() => readJournal('does/not/exist')).toThrow(MigrationReadError);
  });

  it('computeExpectedMigrations throws MigrationReadError when a folder has no journal', () => {
    expect(() => computeExpectedMigrations('scripts')).toThrow(MigrationReadError);
  });
});
