/**
 * VER-002 PR-8 — catalog resolution on the runner side (design §2.1).
 *
 * The catalog is what stops a tampered checkout redefining what a check MEANS. These tests pin the
 * fail-closed behaviour: every malformed or suspicious catalog is a refusal, and the digest is
 * computed over canonical JSON so reformatting the file never changes its identity.
 */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  loadCatalogVersion,
  assertCatalogPinMatches,
  resolveRequiredCommands,
  assertCommandsMatchCatalog,
  CatalogError,
} from '../../services/verification-runner/src/catalog';

/** Build a throwaway catalog dir holding one version file with the given raw contents. */
function catalogDir(version: string, raw: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'pr8-cat-'));
  mkdirSync(join(dir, 'versions'), { recursive: true });
  writeFileSync(join(dir, 'versions', `${version}.json`), raw, 'utf8');
  return dir;
}

const GOOD = JSON.stringify({
  version: '2026-09-21',
  checks: { unit: { command: 'npm run test:unit' }, lint: { command: 'npm run lint' } },
});

describe('PR-8 catalog — loading fails closed', () => {
  it('loads a well-formed version and exposes its commands', () => {
    const c = loadCatalogVersion(catalogDir('2026-09-21', GOOD), '2026-09-21');
    expect(c.version).toBe('2026-09-21');
    expect(c.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(c.commands.unit).toBe('npm run test:unit');
  });

  it('refuses the unpinned sentinel and a path-traversing version token', () => {
    const dir = catalogDir('2026-09-21', GOOD);
    expect(() => loadCatalogVersion(dir, 'unpinned')).toThrow(CatalogError);
    expect(() => loadCatalogVersion(dir, '../../etc/passwd')).toThrow(CatalogError);
    expect(() => loadCatalogVersion(dir, '')).toThrow(CatalogError);
  });

  it('refuses a missing file, invalid JSON, and a non-object body', () => {
    expect(() => loadCatalogVersion(catalogDir('a', GOOD), 'b')).toThrow(/missing, unreadable, or not JSON/);
    expect(() => loadCatalogVersion(catalogDir('a', '{not json'), 'a')).toThrow(/missing, unreadable, or not JSON/);
    expect(() => loadCatalogVersion(catalogDir('a', '"a string"'), 'a')).toThrow(/not an object/);
  });

  it('refuses a file whose declared version disagrees with its filename', () => {
    const raw = JSON.stringify({ version: 'OTHER', checks: { unit: { command: 'x' } } });
    expect(() => loadCatalogVersion(catalogDir('2026-09-21', raw), '2026-09-21')).toThrow(/declares version OTHER/);
  });

  it('refuses a catalog with no checks, or a check with an empty command', () => {
    expect(() => loadCatalogVersion(catalogDir('v', JSON.stringify({ version: 'v' })), 'v')).toThrow(/no checks/);
    const blank = JSON.stringify({ version: 'v', checks: { unit: { command: '   ' } } });
    expect(() => loadCatalogVersion(catalogDir('v', blank), 'v')).toThrow(/has no command/);
  });

  it('refuses a catalog that tries to declare a __proto__ check', () => {
    const raw = '{"version":"v","checks":{"__proto__":{"command":"x"},"unit":{"command":"y"}}}';
    expect(() => loadCatalogVersion(catalogDir('v', raw), 'v')).toThrow(/__proto__/);
  });

  it('computes the digest over canonical JSON, so reformatting does not change identity', () => {
    const pretty = JSON.stringify(JSON.parse(GOOD), null, 4);
    const reordered = JSON.stringify({
      checks: { lint: { command: 'npm run lint' }, unit: { command: 'npm run test:unit' } },
      version: '2026-09-21',
    });
    const a = loadCatalogVersion(catalogDir('2026-09-21', GOOD), '2026-09-21').digest;
    const b = loadCatalogVersion(catalogDir('2026-09-21', pretty), '2026-09-21').digest;
    const c = loadCatalogVersion(catalogDir('2026-09-21', reordered), '2026-09-21').digest;
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('changes the digest when a command actually changes', () => {
    const changed = JSON.stringify({
      version: '2026-09-21',
      checks: { unit: { command: 'npm run test:unit -- --bail' }, lint: { command: 'npm run lint' } },
    });
    const a = loadCatalogVersion(catalogDir('2026-09-21', GOOD), '2026-09-21').digest;
    const b = loadCatalogVersion(catalogDir('2026-09-21', changed), '2026-09-21').digest;
    expect(b).not.toBe(a);
  });
});

describe('PR-8 catalog — pin and command enforcement', () => {
  const catalog = loadCatalogVersion(catalogDir('2026-09-21', GOOD), '2026-09-21');

  it('accepts a contract pinned to exactly this catalog', () => {
    expect(() =>
      assertCatalogPinMatches({ catalogVersion: catalog.version, catalogDigest: catalog.digest }, catalog),
    ).not.toThrow();
  });

  it('refuses a contract pinned to another version or digest', () => {
    expect(() => assertCatalogPinMatches({ catalogVersion: 'other', catalogDigest: catalog.digest }, catalog)).toThrow(/pin mismatch/);
    expect(() => assertCatalogPinMatches({ catalogVersion: catalog.version, catalogDigest: 'f'.repeat(64) }, catalog)).toThrow(/pin mismatch/);
  });

  it('resolves every required check to its approved command', () => {
    expect(resolveRequiredCommands(['unit', 'lint'], catalog)).toEqual([
      { name: 'unit', command: 'npm run test:unit' },
      { name: 'lint', command: 'npm run lint' },
    ]);
  });

  it('refuses a required check that the catalog does not define', () => {
    expect(() => resolveRequiredCommands(['unit', 'e2e'], catalog)).toThrow(/required check e2e has no approved command/);
  });

  it('refuses to attest a command that is not the approved one', () => {
    expect(() => assertCommandsMatchCatalog([{ name: 'unit', command: 'npm run test:unit' }], catalog)).not.toThrow();
    expect(() => assertCommandsMatchCatalog([{ name: 'unit', command: 'true' }], catalog)).toThrow(/catalog approves/);
    expect(() => assertCommandsMatchCatalog([{ name: 'ghost', command: 'x' }], catalog)).toThrow(/not in catalog/);
  });
});
