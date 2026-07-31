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

  it('builds an ordered manifest from Git blobs with a stable set-hash', () => {
    expect(manifest.manifestVersion).toBe('1');
    expect(manifest.entries.length).toBe(54);
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
    expect(parsed.entries.length).toBe(54);
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
