/**
 * VER-002 PR-3 — trusted, preserved command catalogs.
 *
 * The catalog (check-name → approved command) is resolved SERVER-SIDE from version-controlled files
 * in the Hub repo (config/verification-catalogs). A caller can never supply catalog contents or an
 * authoritative digest: creation pins the (version, digest) the server resolves, and ingestion
 * re-resolves the pinned version server-side and fails CLOSED if it is missing or its digest differs.
 *
 * Version files are immutable snapshots, so a contract pinned to an old version stays verifiable after
 * the catalog moves on. The digest is SHA-256 over the canonical JSON (recursively sorted keys) of the
 * parsed version object — not the raw bytes — so reformatting never changes identity.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from './signing';

export interface ResolvedCatalog {
  readonly version: string;
  readonly digest: string;
  /** check name → exact approved command. */
  readonly commands: Readonly<Record<string, string>>;
}

export interface CatalogResolver {
  /** The catalog a NEW contract for this project should pin (per-project pointer, else default). */
  current(projectId: string): ResolvedCatalog | null;
  /** Re-resolve a pinned version by identity (used at ingest). Null ⇒ missing ⇒ fail closed. */
  byVersion(version: string): ResolvedCatalog | null;
}

/** Sentinel stored on contracts that predate catalog pinning; ingestion rejects these (fail closed). */
export const UNPINNED_CATALOG_VERSION = 'unpinned';

function catalogDir(): string {
  return process.env.VERIFICATION_CATALOG_DIR ?? join(process.cwd(), 'config', 'verification-catalogs');
}

/** A version token must be a safe, path-traversal-free identifier. */
const VERSION_RE = /^[A-Za-z0-9._-]+$/;

function loadVersion(version: string): ResolvedCatalog | null {
  if (!version || version === UNPINNED_CATALOG_VERSION || !VERSION_RE.test(version)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(catalogDir(), 'versions', `${version}.json`), 'utf8'));
  } catch {
    return null; // missing/unreadable/invalid JSON ⇒ fail closed
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as { version?: unknown; checks?: unknown };
  if (obj.version !== version || !obj.checks || typeof obj.checks !== 'object') return null;
  const commands: Record<string, string> = {};
  for (const [name, def] of Object.entries(obj.checks as Record<string, unknown>)) {
    const cmd = (def as { command?: unknown } | null)?.command;
    if (typeof cmd !== 'string' || cmd.trim() === '') return null;
    commands[name] = cmd;
  }
  const digest = createHash('sha256').update(canonicalJson(parsed)).digest('hex');
  return { version, digest, commands };
}

/** The default, file-backed resolver reading the trusted in-repo catalog directory. */
export function fileCatalogResolver(): CatalogResolver {
  return {
    current(projectId: string): ResolvedCatalog | null {
      let cur: unknown;
      try {
        cur = JSON.parse(readFileSync(join(catalogDir(), 'current.json'), 'utf8'));
      } catch {
        return null;
      }
      const c = cur as { default?: unknown; projects?: Record<string, unknown> } | null;
      const perProject = c?.projects && typeof c.projects === 'object' ? c.projects[projectId] : undefined;
      const version = typeof perProject === 'string' ? perProject : typeof c?.default === 'string' ? c.default : null;
      return version ? loadVersion(version) : null;
    },
    byVersion(version: string): ResolvedCatalog | null {
      return loadVersion(version);
    },
  };
}
