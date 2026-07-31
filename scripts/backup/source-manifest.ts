import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  type CommittedBlobIdentity,
  type JournalEntry,
  MigrationReadError,
  committedBlobIdentity,
} from './migration-hash';

/**
 * G-Backup-A — PORTABLE source identity (correction 1). The three migration identities are kept distinct:
 *
 *   1. sourceMigrationSetHash  — this file. Derived from ordered Git BLOB contents at an exact source commit,
 *      stable across OS / core.autocrlf. Bound into the signed backup receipt. Never depends on the transformed
 *      working tree.
 *   2. drizzleExecutionHash    — `migration-hash.ts` (sha256 of the raw file bytes present in the execution env).
 *   3. appliedExecutionHash    — the hash stored in `drizzle.__drizzle_migrations` (immutable historical evidence).
 *
 * A production release image may NOT contain `.git`, so the manifest is produced with git by the trusted
 * PRODUCER (G-Backup-B) and serialized to JSON; the release validator consumes the parsed JSON — no git needed.
 */

export const SOURCE_MANIFEST_VERSION = '1' as const;

export interface SourceManifestEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
  readonly committedBlobSha256: string;
  readonly eol: CommittedBlobIdentity['eol'];
  readonly recognizedVariantSha256: string | null;
  readonly recognizedVariantType: CommittedBlobIdentity['recognizedVariantType'];
}

export interface SourceManifest {
  readonly manifestVersion: string;
  readonly sourceCommit: string;
  readonly folder: string;
  readonly entries: SourceManifestEntry[];
  readonly sourceMigrationSetHash: string;
}

/** Deterministic portable set-hash over ordered (idx, tag, when, committedBlobSha256). Newline-transparent. */
export function computeSourceMigrationSetHash(entries: readonly SourceManifestEntry[]): string {
  const h = createHash('sha256');
  h.update('gbackup/source-migration-set/v1\n', 'utf8');
  for (const e of entries) h.update(`${e.idx} ${e.tag} ${e.when} ${e.committedBlobSha256}\n`, 'utf8');
  return h.digest('hex');
}

function gitShow(commit: string, repoPath: string): Buffer {
  // execFileSync (no shell) — commit + path are passed as argv, not interpolated into a command string.
  return execFileSync('git', ['show', `${commit}:${repoPath}`], { maxBuffer: 256 * 1024 * 1024 });
}

/**
 * PRODUCER-side: build a source manifest from Git blobs at `commit`. Reads the journal AND each migration's
 * bytes from the commit (not the working tree), so the result is byte-stable regardless of local checkout /
 * autocrlf. Throws MigrationReadError if git or a blob is unavailable (caller maps to DETECTOR_FAILURE).
 */
export function buildSourceManifestFromGit(commitish: string, folder = 'drizzle'): SourceManifest {
  // Resolve the commit-ish (e.g. "HEAD", "origin/main") to a full commit hash so the manifest is bound to an
  // exact, portable source commit rather than a moving ref.
  let commit: string;
  try {
    commit = execFileSync('git', ['rev-parse', '--verify', `${commitish}^{commit}`]).toString('utf8').trim();
  } catch (e) {
    throw new MigrationReadError(`cannot resolve commit '${commitish}': ${e instanceof Error ? e.message : String(e)}`);
  }
  let journal: { entries: JournalEntry[] };
  try {
    journal = JSON.parse(gitShow(commit, `${folder}/meta/_journal.json`).toString('utf8')) as { entries: JournalEntry[] };
  } catch (e) {
    throw new MigrationReadError(`cannot read journal from git ${commit}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(journal.entries)) throw new MigrationReadError('git journal.entries missing/not an array');

  const entries: SourceManifestEntry[] = [];
  for (const je of journal.entries) {
    if (typeof je.tag !== 'string' || typeof je.when !== 'number' || typeof je.idx !== 'number') {
      throw new MigrationReadError('malformed git journal entry');
    }
    let blob: Buffer;
    try {
      blob = gitShow(commit, `${folder}/${je.tag}.sql`);
    } catch (e) {
      throw new MigrationReadError(`cannot read ${je.tag}.sql from git ${commit}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const id = committedBlobIdentity(blob);
    entries.push({ idx: je.idx, tag: je.tag, when: je.when, ...id });
  }
  entries.sort((a, b) => a.idx - b.idx);
  return {
    manifestVersion: SOURCE_MANIFEST_VERSION,
    sourceCommit: commit,
    folder,
    entries,
    sourceMigrationSetHash: computeSourceMigrationSetHash(entries),
  };
}

// -- Serialization (validator side; no git required) -------------------------

const entrySchema = z
  .object({
    idx: z.number().int().nonnegative(),
    tag: z.string().min(1),
    when: z.number().int().nonnegative(),
    committedBlobSha256: z.string().regex(/^[0-9a-f]{64}$/),
    eol: z.enum(['LF', 'CRLF', 'MIXED']),
    recognizedVariantSha256: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    recognizedVariantType: z.enum(['LF_committed_CRLF_applied', 'CRLF_committed_LF_applied', 'none']),
  })
  .strict();

export const sourceManifestSchema = z
  .object({
    manifestVersion: z.literal(SOURCE_MANIFEST_VERSION),
    sourceCommit: z.string().regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/),
    folder: z.string().min(1),
    entries: z.array(entrySchema).min(1),
    sourceMigrationSetHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export function serializeSourceManifest(m: SourceManifest): string {
  return JSON.stringify(m);
}

/** Parse + validate a serialized manifest AND re-verify its set-hash (a manifest with a wrong hash is rejected). */
export function parseSourceManifest(input: unknown): SourceManifest {
  const parsed = sourceManifestSchema.parse(typeof input === 'string' ? JSON.parse(input) : input);
  const recomputed = computeSourceMigrationSetHash(parsed.entries);
  if (recomputed !== parsed.sourceMigrationSetHash) {
    throw new MigrationReadError('source manifest set-hash does not match its entries');
  }
  return parsed;
}
