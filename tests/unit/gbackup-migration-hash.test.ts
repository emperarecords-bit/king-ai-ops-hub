import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_DRIZZLE_VERSION,
  MigrationReadError,
  committedBlobIdentity,
  computeExpectedMigrations,
  detectEol,
  eolVariant,
  hashBuffer,
  hashMigrationText,
  installedDrizzleVersion,
  migrationSetHash,
  readJournal,
  recognizedHashes,
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

describe('G-Backup-A EOL variant helpers (newline transform ONLY)', () => {
  const lf = Buffer.from('create table x (a int);\ncreate index i;\n', 'utf8');
  const crlf = Buffer.from('create table x (a int);\r\ncreate index i;\r\n', 'utf8');
  const mixed = Buffer.from('a\r\nb\nc\r\n', 'utf8');

  it('detectEol classifies LF / CRLF / MIXED byte-accurately', () => {
    expect(detectEol(lf)).toBe('LF');
    expect(detectEol(crlf)).toBe('CRLF');
    expect(detectEol(mixed)).toBe('MIXED');
    expect(detectEol(Buffer.from('no newlines', 'utf8'))).toBe('LF');
  });

  it('eolVariant is the exact opposite-newline transform; MIXED has none', () => {
    expect(hashBuffer(eolVariant(lf, 'LF')!)).toBe(hashBuffer(crlf)); // LF→CRLF equals the CRLF form
    expect(hashBuffer(eolVariant(crlf, 'CRLF')!)).toBe(hashBuffer(lf)); // CRLF→LF equals the LF form
    expect(eolVariant(mixed, 'MIXED')).toBeNull();
  });

  it('committedBlobIdentity + recognizedHashes recognize exactly the committed form and its one EOL variant', () => {
    const id = committedBlobIdentity(lf);
    expect(id.eol).toBe('LF');
    expect(id.committedBlobSha256).toBe(hashBuffer(lf));
    expect(id.recognizedVariantSha256).toBe(hashBuffer(crlf));
    expect(id.recognizedVariantType).toBe('LF_committed_CRLF_applied');
    const set = recognizedHashes(id);
    expect(set.has(hashBuffer(lf))).toBe(true);
    expect(set.has(hashBuffer(crlf))).toBe(true);
    // A whitespace change is NOT recognized (newline transform only).
    const spaced = Buffer.from(lf.toString('utf8').replace('int', 'int '), 'utf8');
    expect(set.has(hashBuffer(spaced))).toBe(false);
  });

  it('MIXED committed blob recognizes only its exact hash (no deterministic variant)', () => {
    const id = committedBlobIdentity(mixed);
    expect(id.recognizedVariantSha256).toBeNull();
    expect([...recognizedHashes(id)]).toEqual([hashBuffer(mixed)]);
  });
});
