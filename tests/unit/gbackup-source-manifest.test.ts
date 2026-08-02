import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MigrationReadError } from '../../scripts/backup/migration-hash';
import {
  buildSourceManifestFromGit,
  computeSourceMigrationSetHash,
  parseSourceManifest,
  serializeSourceManifest,
} from '../../scripts/backup/source-manifest';

describe('G-Backup-A portable source manifest (Git-blob identity)', () => {
  const manifest = buildSourceManifestFromGit('HEAD', 'drizzle');

  // The producer reads the COMMITTED journal at HEAD, so the manifest's entry count must equal that journal's
  // entry count — read here the SAME way the producer does. This is PROVABLY invariant to whether an
  // uncommitted migration (e.g. 0055) exists in the working tree: on a clean base HEAD-journal=N ⇒ manifest N
  // ⇒ equal; once that migration is committed HEAD-journal=N+1 ⇒ manifest N+1 ⇒ equal; while it lives only in
  // the working tree the producer (git HEAD:) ignores it entirely ⇒ still equal. The absolute-count assertion
  // that previously hard-coded 54 broke the moment a new migration (0054) was committed — this does not.
  const committedJournal = JSON.parse(
    execFileSync('git', ['show', 'HEAD:drizzle/meta/_journal.json']).toString('utf8'),
  ) as { entries: unknown[] };

  it('builds an ordered manifest from Git blobs with a stable set-hash', () => {
    expect(manifest.manifestVersion).toBe('1');
    expect(manifest.entries.length).toBe(committedJournal.entries.length);
    // Floor: the migration set never silently shrinks below the count present when this expectation was set.
    expect(manifest.entries.length).toBeGreaterThanOrEqual(54);
    for (let i = 1; i < manifest.entries.length; i++) expect(manifest.entries[i]!.idx).toBeGreaterThan(manifest.entries[i - 1]!.idx);
    expect(manifest.sourceMigrationSetHash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeSourceMigrationSetHash(manifest.entries)).toBe(manifest.sourceMigrationSetHash);
    // committed blobs are LF (git-normalized) → each entry advertises an LF→CRLF recognized variant.
    expect(manifest.entries.every((e) => e.committedBlobSha256.match(/^[0-9a-f]{64}$/))).toBe(true);
    expect(manifest.entries.some((e) => e.eol === 'LF' && e.recognizedVariantType === 'LF_committed_CRLF_applied')).toBe(true);
  });

  it('the source set-hash is derived from committed blobs, not the working tree (OS/EOL-stable by construction)', () => {
    // Building at the same commit twice is identical regardless of local checkout line endings.
    const again = buildSourceManifestFromGit('HEAD', 'drizzle');
    expect(again.sourceMigrationSetHash).toBe(manifest.sourceMigrationSetHash);
  });

  it('serialize → parse round-trips and re-verifies the set-hash', () => {
    const s = serializeSourceManifest(manifest);
    const parsed = parseSourceManifest(s);
    expect(parsed.sourceMigrationSetHash).toBe(manifest.sourceMigrationSetHash);
    expect(parsed.entries.length).toBe(committedJournal.entries.length);
  });

  it('DRIFT SENSITIVITY: reordering or tampering with a journal entry changes computeSourceMigrationSetHash', () => {
    // Count-derived expectations must not weaken detection: the set-hash is over ordered (idx, tag, when,
    // committedBlobSha256) tuples, so any reorder / retag / hash-mutation of an entry changes the set-hash.
    expect(computeSourceMigrationSetHash(manifest.entries)).toBe(manifest.sourceMigrationSetHash);
    // Reorder the last two entries → different set-hash.
    const reordered = [...manifest.entries];
    const n = reordered.length;
    [reordered[n - 1], reordered[n - 2]] = [reordered[n - 2]!, reordered[n - 1]!];
    expect(computeSourceMigrationSetHash(reordered)).not.toBe(manifest.sourceMigrationSetHash);
    // Tamper with one entry's committed blob hash → different set-hash.
    const tampered = manifest.entries.map((e, i) => (i === 0 ? { ...e, committedBlobSha256: 'a'.repeat(64) } : e));
    expect(computeSourceMigrationSetHash(tampered)).not.toBe(manifest.sourceMigrationSetHash);
    // Retag one entry → different set-hash.
    const retagged = manifest.entries.map((e, i) => (i === 0 ? { ...e, tag: `${e.tag}_TAMPERED` } : e));
    expect(computeSourceMigrationSetHash(retagged)).not.toBe(manifest.sourceMigrationSetHash);
  });

  it('a manifest whose set-hash does not match its entries is rejected', () => {
    const tampered = { ...manifest, sourceMigrationSetHash: 'f'.repeat(64) };
    expect(() => parseSourceManifest(tampered)).toThrow(MigrationReadError);
  });

  it('a tampered entry hash (recomputed set-hash differs) is rejected', () => {
    const bad = structuredClone(manifest) as typeof manifest;
    (bad.entries[0] as { committedBlobSha256: string }).committedBlobSha256 = 'a'.repeat(64);
    expect(() => parseSourceManifest(bad)).toThrow(); // set-hash mismatch or schema
  });

  it('an unknown/invalid commit fails as MigrationReadError', () => {
    expect(() => buildSourceManifestFromGit('0000000000000000000000000000000000000000', 'drizzle')).toThrow(MigrationReadError);
  });
});
