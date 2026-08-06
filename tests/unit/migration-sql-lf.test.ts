import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

/**
 * Migration SQL must be LF-only.
 *
 * The G-Backup runtime-migration-set hash (scripts/backup/runtime-migration-set.ts) is a sha256 over the EXACT
 * migration file BYTES, so a CRLF-vs-LF difference changes the hash. On Windows with `core.autocrlf=true` a naive
 * checkout would materialize CRLF and derive a non-reproducible runtime hash; `.gitattributes` pins the migration
 * SQL glob to `text eol=lf` to prevent that. This regression check fails if any COMMITTED migration SQL blob
 * contains a CRLF (`0D 0A`).
 *
 * It reads the INDEX blob bytes via git (`git show :<path>`), NOT the working-tree file — so it is independent of
 * the developer's `core.autocrlf` / `core.eol` and passes identically on Linux and Windows. It never rewrites files.
 */

/** All tracked migration SQL files under `drizzle/` (any depth), matching the `.gitattributes` glob. */
function committedMigrationSqlFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '--', 'drizzle'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out
    .split('\n')
    .map((s) => s.trim())
    .filter((f) => f.endsWith('.sql'));
}

/** The exact committed/staged blob bytes for a tracked path (no smudge filter, no EOL conversion). */
function indexBlobBytes(path: string): Buffer {
  return execFileSync('git', ['show', `:${path}`], { maxBuffer: 64 * 1024 * 1024 });
}

describe('migration SQL line endings (G-Backup runtime-hash determinism)', () => {
  const files = committedMigrationSqlFiles();

  it('finds the committed migration SQL files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('no committed drizzle SQL file contains CRLF (0D 0A)', () => {
    const CRLF = Buffer.from('\r\n');
    const offenders = files.filter((f) => indexBlobBytes(f).includes(CRLF));
    expect(offenders, `CRLF found in committed migration SQL (must be LF): ${offenders.join(', ')}`).toEqual([]);
  });
});
