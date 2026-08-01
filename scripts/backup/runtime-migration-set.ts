import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizeV1 } from '@/lib/canonical';

/**
 * G-Backup-B1 — RUNTIME-recomputable migration-set hash.
 *
 * The release image contains the baked `drizzle/` migration files but NO `.git`, so the portable Git-blob
 * `sourceMigrationSetHash` (source-manifest.ts) cannot be recomputed inside the release Machine. This module
 * computes a SEPARATE, `.git`-independent, cross-platform hash over the exact migration BYTES that will be
 * applied. It is bound in the receipt as a distinct field and must NOT be conflated with the portable hash.
 *
 * Stability: entries are sorted by migrationIndex; each entry carries (index, tag, canonical POSIX relative path,
 * byte length, sha256 of the exact file bytes). Duplicate indexes/tags/paths and non-canonical / traversal paths
 * are rejected. The digest is domain-separated and versioned.
 */

export const RUNTIME_MIGSET_DOMAIN = 'gbackup-runtime-migration-set/v1\n' as const;

export class RuntimeMigrationSetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeMigrationSetError';
  }
}

export interface RuntimeMigrationEntry {
  readonly migrationIndex: number;
  readonly migrationTag: string;
  /** repo-relative POSIX path of the migration file, e.g. `drizzle/0004_knowledge_k1.sql`. */
  readonly migrationPath: string;
  readonly byteLength: number;
  readonly sha256: string;
}

export interface RuntimeMigrationSet {
  readonly algorithmVersion: '1';
  readonly entries: RuntimeMigrationEntry[];
  readonly runtimeMigrationSetHash: string;
}

const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
const MIGRATION_TAG = /^[0-9]{4}_[a-z0-9_]+$/;

function assertCanonicalRelPath(p: string): void {
  if (typeof p !== 'string' || p.length === 0) throw new RuntimeMigrationSetError('empty migration path');
  if (p.includes('\\')) throw new RuntimeMigrationSetError('backslash in migration path');
  if (p.startsWith('/')) throw new RuntimeMigrationSetError('absolute migration path');
  for (const seg of p.split('/')) {
    if (seg.length === 0) throw new RuntimeMigrationSetError('empty path segment / repeated separator');
    if (seg === '.' || seg === '..') throw new RuntimeMigrationSetError('. or .. path segment');
    if (!SAFE_SEGMENT.test(seg)) throw new RuntimeMigrationSetError(`unsafe character in path segment ${JSON.stringify(seg)}`);
  }
}

/** Compute the runtime migration-set from a pre-read list of files (pure; used by tests + the reader below). */
export function computeRuntimeMigrationSet(
  files: readonly { migrationIndex: number; migrationTag: string; migrationPath: string; bytes: Buffer }[],
): RuntimeMigrationSet {
  const seenIdx = new Set<number>();
  const seenTag = new Set<string>();
  const seenPath = new Set<string>();
  const entries: RuntimeMigrationEntry[] = [];
  for (const f of files) {
    if (!Number.isInteger(f.migrationIndex) || f.migrationIndex < 0) throw new RuntimeMigrationSetError('invalid migrationIndex');
    if (!MIGRATION_TAG.test(f.migrationTag)) throw new RuntimeMigrationSetError(`invalid migrationTag ${JSON.stringify(f.migrationTag)}`);
    assertCanonicalRelPath(f.migrationPath);
    if (seenIdx.has(f.migrationIndex)) throw new RuntimeMigrationSetError(`duplicate migrationIndex ${f.migrationIndex}`);
    if (seenTag.has(f.migrationTag)) throw new RuntimeMigrationSetError(`duplicate migrationTag ${f.migrationTag}`);
    if (seenPath.has(f.migrationPath)) throw new RuntimeMigrationSetError(`duplicate migrationPath ${f.migrationPath}`);
    seenIdx.add(f.migrationIndex);
    seenTag.add(f.migrationTag);
    seenPath.add(f.migrationPath);
    entries.push({
      migrationIndex: f.migrationIndex,
      migrationTag: f.migrationTag,
      migrationPath: f.migrationPath,
      byteLength: f.bytes.length,
      sha256: createHash('sha256').update(f.bytes).digest('hex'),
    });
  }
  // Order is not trust-critical (sorted), but must be deterministic.
  entries.sort((a, b) => a.migrationIndex - b.migrationIndex);
  const runtimeMigrationSetHash = createHash('sha256')
    .update(RUNTIME_MIGSET_DOMAIN, 'utf8')
    .update(canonicalizeV1({ algorithmVersion: '1', entries }), 'utf8')
    .digest('hex');
  return { algorithmVersion: '1', entries, runtimeMigrationSetHash };
}

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

/**
 * Read the baked migration files from `<baseDir>/<folderName>` (default `drizzle`) and compute the runtime set.
 * Reads only local files (no `.git`, no DB, no network). Throws {@link RuntimeMigrationSetError} on any problem.
 */
export function readRuntimeMigrationSet(baseDir: string, folderName = 'drizzle'): RuntimeMigrationSet {
  let journal: { entries: JournalEntry[] };
  try {
    journal = JSON.parse(readFileSync(join(baseDir, folderName, 'meta', '_journal.json'), 'utf8')) as { entries: JournalEntry[] };
  } catch (e) {
    throw new RuntimeMigrationSetError(`cannot read migration journal: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(journal.entries)) throw new RuntimeMigrationSetError('journal.entries missing/not an array');
  const files = journal.entries.map((je) => {
    if (typeof je.tag !== 'string' || typeof je.idx !== 'number') throw new RuntimeMigrationSetError('malformed journal entry');
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(baseDir, folderName, `${je.tag}.sql`));
    } catch (e) {
      throw new RuntimeMigrationSetError(`cannot read ${je.tag}.sql: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { migrationIndex: je.idx, migrationTag: je.tag, migrationPath: `${folderName}/${je.tag}.sql`, bytes };
  });
  return computeRuntimeMigrationSet(files);
}
