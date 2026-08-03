import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { committedBlobIdentity, readJournal } from '../../scripts/backup/migration-hash';
import {
  buildSourceManifestFromGit,
  computeSourceMigrationSetHash,
  type SourceManifest,
  type SourceManifestEntry,
} from '../../scripts/backup/source-manifest';

/**
 * TEST-ONLY helper: the "expected migration set for DB-comparison". The G-Backup detector/onboarding DB
 * tests compare a test database's APPLIED migration history to a source manifest. A test DB is migrated from
 * the working-tree `drizzle/` directory, which — on this branch — includes an UNCOMMITTED migration (`0055`)
 * that `buildSourceManifestFromGit('HEAD')` (which reads committed git blobs only) cannot see.
 *
 * This helper derives the expected set from the SAME authoritative source the DB was actually migrated from,
 * so `appliedCount === expected` holds whether the DB is at committed-HEAD level or HEAD + an uncommitted
 * tail, WITHOUT ever hard-coding a count:
 *
 *   - Committed entries (present at git HEAD) keep their exact git-blob identity — so a database that applied
 *     an IRREGULAR historical form of a committed migration (e.g. the documented mixed-EOL `0004`) is still
 *     correctly a HISTORICAL_HASH_MISMATCH; committed identity is unchanged from production behaviour.
 *   - Any uncommitted working-tree tail (a migration in the filesystem journal but not at git HEAD) is
 *     appended with the portable committed-blob identity it WOULD carry once committed: git normalises CRLF→LF
 *     on commit, so the committed form is the LF-normalisation of the working-tree bytes, and its recognised
 *     variant is exactly the CRLF working-tree bytes drizzle actually applied.
 *
 * The result stays drift-sensitive: every entry carries its own `committedBlobSha256` and the whole set is
 * bound by `computeSourceMigrationSetHash`, so a missing / extra / reordered / hash-modified migration still
 * changes the manifest. Only the COUNT is derived from disk, never asserted as a literal.
 */
export function buildDbComparisonManifest(folder = 'drizzle'): SourceManifest {
  const git = buildSourceManifestFromGit('HEAD', folder);
  const fsJournal = readJournal(folder);
  const gitTags = new Set(git.entries.map((e) => e.tag));

  const extras: SourceManifestEntry[] = [];
  for (const je of fsJournal.entries) {
    if (gitTags.has(je.tag)) continue; // committed — keep the exact git-blob identity
    const raw = readFileSync(join(folder, `${je.tag}.sql`));
    // git's clean filter normalises CRLF→LF on commit; the committed blob is the LF form of the working tree.
    const lfForm = Buffer.from(raw.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    extras.push({ idx: je.idx, tag: je.tag, when: je.when, ...committedBlobIdentity(lfForm) });
  }

  if (extras.length === 0) return git; // committed-HEAD case: filesystem journal == git HEAD journal

  const entries = [...git.entries, ...extras].sort((a, b) => a.idx - b.idx);
  return { ...git, entries, sourceMigrationSetHash: computeSourceMigrationSetHash(entries) };
}
