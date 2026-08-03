import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Focused self-test for the CI secret scanner (scripts/ci/secret-scan.mjs). The scanner is a `.mjs` run directly
// by node in CI (allowJs:false blocks importing it from TS), so this test exercises it through its `--selftest`
// entrypoint via a child process rather than importing it.
const SCANNER = join('scripts', 'ci', 'secret-scan.mjs');

describe('CI secret-scan — self-hygiene + detection', () => {
  it('the scanner source contains no complete private-key PEM header marker', () => {
    // Assemble the markers from fragments so THIS test file never contains them verbatim either.
    const priv = ['PRI', 'VATE'].join('');
    const key = ['K', 'EY'].join('');
    const dash5 = '-'.repeat(5);
    const src = readFileSync(SCANNER, 'utf8');
    expect(src.includes(`${priv} ${key}${dash5}`)).toBe(false); // "PRIVATE KEY-----"
    expect(src.includes(`BEGIN ${priv} ${key}`)).toBe(false); // "BEGIN PRIVATE KEY"
  });

  it('built-in self-test: a synthetic private-key fixture is detected, only path:line reported, no key leaked', () => {
    // execFileSync throws on a nonzero exit, so a self-test failure fails this test.
    const out = execFileSync('node', [SCANNER, '--selftest'], { encoding: 'utf8' });
    expect(out).toMatch(/synthetic\/leaked-credential\.pem:1/); // path:line surfaced
    expect(out).not.toMatch(/NOT-A-REAL-KEY/); // key material never printed
    expect(out).toContain('[secret-scan:selftest] OK');
  });
});
