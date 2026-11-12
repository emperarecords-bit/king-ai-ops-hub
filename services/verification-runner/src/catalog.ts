/**
 * Command-catalog resolution, runner side (design §2.1).
 *
 * The catalog is the ONLY source of what a check name means. A runner reads it, it never invents
 * it: `assertCommandsMatchCatalog` is what stops a tampered checkout from redefining `unit` as
 * `true` and shipping a green result.
 *
 * The digest MUST be computed the same way the Hub computes it — sha256 over the canonical JSON of
 * the whole parsed version file, NOT the raw bytes — so reformatting the file never changes its
 * identity. `tests/unit/verification-runner-catalog.test.ts` asserts this against the Hub's own
 * resolver over the real in-repo catalog.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical';

export interface ResolvedCatalog {
  readonly version: string;
  readonly digest: string;
  readonly commands: Readonly<Record<string, string>>;
}

/** Same guard as the Hub: a version token is a path-traversal-free identifier. */
const VERSION_RE = /^[A-Za-z0-9._-]+$/;

export class CatalogError extends Error {}

/**
 * Load one immutable catalog version. Fails CLOSED on anything unexpected, mirroring the Hub's
 * `loadVersion` rejections exactly — including refusing a catalog that declares a `__proto__`
 * check name. Returning null where the Hub returns null keeps the two in lockstep; a runner that
 * accepted a catalog the Hub rejects would produce evidence that can only ever be refused.
 */
export function loadCatalogVersion(catalogDir: string, version: string): ResolvedCatalog {
  if (!version || version === 'unpinned' || !VERSION_RE.test(version)) {
    throw new CatalogError(`unusable catalog version: ${JSON.stringify(version)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(catalogDir, 'versions', `${version}.json`), 'utf8'));
  } catch {
    throw new CatalogError(`catalog version ${version} is missing, unreadable, or not JSON`);
  }
  if (!parsed || typeof parsed !== 'object') throw new CatalogError(`catalog ${version} is not an object`);
  const obj = parsed as { version?: unknown; checks?: unknown };
  if (obj.version !== version) throw new CatalogError(`catalog ${version} declares version ${String(obj.version)}`);
  if (!obj.checks || typeof obj.checks !== 'object') throw new CatalogError(`catalog ${version} has no checks`);

  const commands: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of Object.keys(obj.checks as Record<string, unknown>)) {
    if (name === '__proto__') throw new CatalogError(`catalog ${version} declares a __proto__ check`);
    const def = (obj.checks as Record<string, unknown>)[name] as { command?: unknown } | null;
    const cmd = def?.command;
    if (typeof cmd !== 'string' || cmd.trim() === '') {
      throw new CatalogError(`catalog ${version} check ${name} has no command`);
    }
    commands[name] = cmd;
  }
  return { version, digest: createHash('sha256').update(canonicalJson(parsed)).digest('hex'), commands };
}

/**
 * Refuse to proceed unless the catalog we loaded is the one the contract was created against.
 *
 * Checking this locally is not redundant with the Hub's own `catalog_mismatch` rejection: catching
 * it here means we never RUN commands from a catalog whose results could not be accepted, which
 * saves a pointless build and, more importantly, prevents a runner from quietly executing commands
 * from a catalog nobody reviewed for this contract.
 */
export function assertCatalogPinMatches(contract: { catalogVersion: string; catalogDigest: string }, catalog: ResolvedCatalog): void {
  if (contract.catalogVersion !== catalog.version || contract.catalogDigest !== catalog.digest) {
    throw new CatalogError(
      `catalog pin mismatch: contract pins ${contract.catalogVersion}/${contract.catalogDigest.slice(0, 12)}…, ` +
        `local catalog is ${catalog.version}/${catalog.digest.slice(0, 12)}…`,
    );
  }
}

/** Every required check must exist in the pinned catalog, or we cannot run the contract at all. */
export function resolveRequiredCommands(
  requiredChecks: readonly string[],
  catalog: ResolvedCatalog,
): readonly { readonly name: string; readonly command: string }[] {
  return requiredChecks.map((name) => {
    const command = catalog.commands[name];
    if (typeof command !== 'string') {
      throw new CatalogError(`required check ${name} has no approved command in catalog ${catalog.version}`);
    }
    return { name, command };
  });
}

/**
 * Last line of defence before signing: every submitted check's command must equal the pinned
 * catalog entry. The Hub enforces this too (§2.1) — doing it here means a drifted harness record
 * fails loudly on the runner instead of as an opaque server rejection.
 */
export function assertCommandsMatchCatalog(
  checks: readonly { readonly name: string; readonly command: string }[],
  catalog: ResolvedCatalog,
): void {
  for (const c of checks) {
    const approved = catalog.commands[c.name];
    if (typeof approved !== 'string') {
      throw new CatalogError(`check ${c.name} is not in catalog ${catalog.version}`);
    }
    if (approved !== c.command) {
      throw new CatalogError(`check ${c.name} ran ${JSON.stringify(c.command)} but the catalog approves ${JSON.stringify(approved)}`);
    }
  }
}
