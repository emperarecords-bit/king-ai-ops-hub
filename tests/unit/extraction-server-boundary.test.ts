import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * P1d hardening H1 — server/worker-only extraction boundary.
 *
 * The provider-facing extraction implementations (`extractCandidatesForRun`, `extractKnowledgeForRun`) make a
 * DIRECT, un-fenced model call. In the crash-safe P1d run path the runner instead checkpoints the provider result
 * first (at-most-once, fenced) and only then applies proposals — so these direct entrypoints must never be reachable
 * from a browser/client bundle, and browser code may request extraction only through an authenticated server
 * boundary (a `'use server'` action) that funnels into the same durable path.
 *
 * The contract is enforced at COMPILE time by the `server-only` package (any import of a `server-only` module into a
 * Client Component graph is a build error). This is a STATIC regression guard that locks that contract in place:
 *   1. every module that owns or sits on the provider-facing extraction path imports `server-only`;
 *   2. no Client Component (`'use client'`) imports an extraction implementation module;
 *   3. no shared barrel re-exports an extraction implementation module (which would strip the guard);
 *   4. the direct provider-facing functions are declared ONLY inside the server-only extraction modules and are
 *      not re-exported elsewhere;
 *   5. the shared pure/type exports remain available to legitimate server/worker callers.
 *
 * It reads source text only — it never imports the extraction modules or calls a real provider.
 */

const ROOT = process.cwd();
const SRC = join(ROOT, 'src');

/** The two modules that own the provider-facing extraction implementation. */
const EXTRACTION_MODULES = ['src/domain/decisions/extraction.ts', 'src/domain/knowledge/extraction.ts'];
/** Additional server-side loaders that sit on the extraction import path and must carry the explicit guard. */
const GUARDED_PATH_MODULES = ['src/domain/knowledge/detail.ts'];
/** Direct, un-fenced provider-facing entrypoints that must stay inside the server-only modules. */
const DIRECT_PROVIDER_FNS = ['extractCandidatesForRun', 'extractKnowledgeForRun'];
/** Matches an import of either extraction implementation module. */
const EXTRACTION_IMPORT = /@\/domain\/(?:decisions|knowledge)\/extraction/;

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== '.next') out.push(...walk(p));
    } else if (/\.(?:ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const ALL_SRC = walk(SRC).map((p) => ({ rel: relative(ROOT, p).replace(/\\/g, '/'), src: readFileSync(p, 'utf8') }));

/** True if the file's leading directive (allowing leading comments) is `'use client'`. */
function isClientModule(src: string): boolean {
  return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/.test(src);
}

/** True if the file imports the `server-only` guard. */
function hasServerOnly(src: string): boolean {
  return /import ['"]server-only['"];/.test(src);
}

describe('extraction server/worker-only boundary (P1d H1)', () => {
  it('every provider-facing extraction module and its guarded loaders import server-only', () => {
    const missing = [...EXTRACTION_MODULES, ...GUARDED_PATH_MODULES].filter((m) => !hasServerOnly(read(m)));
    expect(missing, `these modules must import 'server-only': ${missing.join(', ')}`).toEqual([]);
  });

  it('no Client Component imports an extraction implementation module', () => {
    const offenders = ALL_SRC.filter((f) => isClientModule(f.src) && EXTRACTION_IMPORT.test(f.src)).map((f) => f.rel);
    expect(offenders, `client modules must not import extraction: ${offenders.join(', ')}`).toEqual([]);
  });

  it('no shared barrel re-exports an extraction implementation module', () => {
    const offenders = ALL_SRC.filter(
      (f) => /(?:^|\/)index\.ts$/.test(f.rel) && /export[\s\S]*?from\s*['"][^'"]*\/(?:decisions|knowledge)\/extraction['"]/.test(f.src),
    ).map((f) => f.rel);
    expect(offenders, `barrels must not re-export extraction: ${offenders.join(', ')}`).toEqual([]);
  });

  it('direct provider-facing extraction functions live only inside server-only modules and are not re-exported', () => {
    // Each direct function is declared in exactly one of the (server-only) extraction modules.
    for (const fn of DIRECT_PROVIDER_FNS) {
      const decls = EXTRACTION_MODULES.filter((m) => new RegExp(`export async function ${fn}\\b`).test(read(m)));
      expect(decls, `${fn} must be declared in exactly one server-only extraction module`).toHaveLength(1);
      expect(hasServerOnly(read(decls[0]!)), `${decls[0]} must be server-only`).toBe(true);
    }
    // No OTHER source file re-declares or re-exports these provider entrypoints (an `export` line naming one).
    const reexporters = ALL_SRC.filter((f) => {
      if (EXTRACTION_MODULES.includes(f.rel)) return false;
      return f.src
        .split('\n')
        .some((line) => /^\s*export\b/.test(line) && DIRECT_PROVIDER_FNS.some((fn) => new RegExp(`\\b${fn}\\b`).test(line)));
    }).map((f) => f.rel);
    expect(reexporters, `provider-facing extraction fns must not be re-exported: ${reexporters.join(', ')}`).toEqual([]);
  });

  it('shared pure/type extraction exports remain available to server/worker callers', () => {
    // The non-provider pieces the runner and server actions depend on must stay exported.
    expect(read('src/domain/decisions/extraction.ts')).toMatch(/export function parseAndValidateCandidates\b/);
    expect(read('src/domain/decisions/extraction.ts')).toMatch(/export async function applyDecisionCandidatesFromText\b/);
    expect(read('src/domain/knowledge/extraction.ts')).toMatch(/export async function applyKnowledgeCandidatesFromText\b/);
    expect(read('src/domain/knowledge/extraction.ts')).toMatch(/export async function listKnowledgeProposals\b/);
  });
});
