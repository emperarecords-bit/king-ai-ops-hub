/* eslint-disable no-console -- CI orchestration script: progress + diagnostics go to stdout/stderr by design. */
// CI-only, deterministic, repository-native secret scan (no external action, no network, no secrets required).
// Scans every tracked text file for high-confidence credential patterns and fails on any hit. Cloud/token key
// formats are enforced EVERYWHERE (they should never appear, even in tests). Private-key / JWT blocks are
// skipped under `tests/` because the G-Backup crypto/receipt suites legitimately embed generated TEST keys.
//
// SELF-HYGIENE: this file must not itself contain a COMPLETE private-key PEM header line — the repository hygiene
// test (`gbackup-active-onboarding.test.ts`) greps every tracked non-test file for that exact marker. The
// detection regex is therefore assembled from FRAGMENTS at runtime, so the marker string never appears verbatim
// in this source while runtime detection is unchanged. A built-in `--selftest` proves both (no marker in the
// source; a synthetic private-key fixture is still detected).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SKIP_FILE = [
  /^package-lock\.json$/,
  /\.(png|jpe?g|gif|ico|webp|svg|pdf|zip|gz|tgz|woff2?|ttf|eot|node|wasm|lockb)$/i,
];

/**
 * Build the private-key PEM header matcher from fragments so this SOURCE file never contains the header marker
 * verbatim (neither the trailing form nor the leading BEGIN form), while the compiled regex still matches RSA /
 * EC / DSA / OpenSSH / PGP / generic private-key PEM headers at runtime.
 */
export function buildPrivateKeyHeaderRegex() {
  const dash5 = '-'.repeat(5);
  const priv = ['PRI', 'VATE'].join('');
  const key = ['K', 'EY'].join('');
  return new RegExp(`${dash5}BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?${priv} ${key}${dash5}`);
}

// `testAllowed: true` → skipped under tests/** (legitimate fixtures); enforced everywhere else and in non-test code.
export const PATTERNS = [
  { re: buildPrivateKeyHeaderRegex(), name: 'private key block', testAllowed: true },
  { re: /\beyJ[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/, name: 'JWT-shaped token', testAllowed: true },
  { re: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS access key id', testAllowed: false },
  { re: /\bASIA[0-9A-Z]{16}\b/, name: 'AWS temporary key id', testAllowed: false },
  { re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/, name: 'GitHub token', testAllowed: false },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, name: 'Slack token', testAllowed: false },
  { re: /\bsk_live_[0-9A-Za-z]{16,}\b/, name: 'Stripe live secret key', testAllowed: false },
  { re: /\bAIza[0-9A-Za-z_\-]{35}\b/, name: 'Google API key', testAllowed: false },
];

const NUL = String.fromCharCode(0);

/** True for a path treated as test-fixture space (private-key/JWT patterns are allow-listed there). */
export const isTestPath = (f) => f.startsWith('tests/');

/**
 * PURE. Scan one file's text and return findings as `{ name, line }` (1-indexed). Binary files (containing a NUL)
 * return no findings. Never returns the matched secret material — only the pattern name and line number.
 */
export function scanContent(text, { isTest = false } = {}) {
  const findings = [];
  if (typeof text !== 'string' || text.includes(NUL)) return findings; // skip binary / unreadable
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      if (isTest && p.testAllowed) continue;
      if (p.re.test(lines[i])) findings.push({ name: p.name, line: i + 1 });
    }
  }
  return findings;
}

/**
 * PURE (given a reader). Scan a list of files, returning `{ name, file, line }` findings. `readFile(path)` returns
 * the file text (or throws to skip); `isTest(path)` decides test-fixture allow-listing. No secret material is
 * carried on a finding.
 */
export function scanFiles({ files, readFile, isTest }) {
  const findings = [];
  for (const f of files) {
    if (SKIP_FILE.some((r) => r.test(f))) continue;
    let text;
    try {
      text = readFile(f);
    } catch {
      continue;
    }
    for (const c of scanContent(text, { isTest: isTest(f) })) findings.push({ name: c.name, file: f, line: c.line });
  }
  return findings;
}

/** Render a finding as `path:line` + pattern name ONLY — never the detected secret. */
export function formatFinding(f) {
  return `[secret-scan] ${f.name} @ ${f.file}:${f.line}`;
}

/** CLI: scan every tracked text file; fail on any hit. */
function main() {
  const files = execFileSync('git', ['ls-files'], { maxBuffer: 128 * 1024 * 1024 })
    .toString()
    .split('\n')
    .filter(Boolean);
  const findings = scanFiles({ files, readFile: (f) => readFileSync(f, 'utf8'), isTest: isTestPath });
  for (const f of findings) console.error(formatFinding(f));
  if (findings.length > 0) {
    console.error(`[secret-scan] FAIL — ${findings.length} high-confidence secret pattern(s) found in tracked files.`);
    process.exit(1);
  }
  console.log(`[secret-scan] OK — scanned ${files.length} tracked files; no high-confidence secrets.`);
}

/**
 * Built-in self-test (`--selftest`): proves the scanner does NOT regress the repository hygiene invariant and
 * still detects a private key. Reports only `path:line` — never the synthetic key material. Uses no real key.
 */
function selfTest() {
  const errors = [];
  const priv = ['PRI', 'VATE'].join('');
  const key = ['K', 'EY'].join('');
  const dash5 = '-'.repeat(5);

  // (1) the scanner SOURCE must not contain a complete PEM header marker.
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  if (src.includes(`${priv} ${key}${dash5}`) || src.includes(`BEGIN ${priv} ${key}`)) {
    errors.push('scanner source contains a complete private-key PEM header marker');
  }

  // (2) a synthetic tracked-file fixture with a private-key header IS detected (built at runtime, not a real key).
  const fakeHeader = `${dash5}BEGIN RSA ${priv} ${key}${dash5}`;
  const fixturePath = 'synthetic/leaked-credential.pem';
  const fixtureContent = `${fakeHeader}\nNOT-A-REAL-KEY-0000000000000000000000\n${dash5}END RSA ${priv} ${key}${dash5}\n`;
  const findings = scanFiles({ files: [fixturePath], readFile: () => fixtureContent, isTest: () => false });
  if (findings.length !== 1) errors.push(`expected exactly 1 finding, got ${findings.length}`);
  const f0 = findings[0];
  if (!f0 || f0.file !== fixturePath || f0.line !== 1 || f0.name !== 'private key block') {
    errors.push('finding did not report the private-key header at the correct path:line');
  }

  // (3) a finding carries ONLY {name,file,line} — no secret material.
  if (f0 && Object.keys(f0).sort().join(',') !== 'file,line,name') {
    errors.push('finding carries fields beyond {name,file,line}');
  }

  // (4) rendered output shows path:line and does NOT leak key material.
  const rendered = f0 ? formatFinding(f0) : '';
  if (!rendered.includes(`${fixturePath}:1`)) errors.push('rendered finding is missing path:line');
  if (rendered.includes('NOT-A-REAL-KEY') || rendered.includes(fakeHeader)) errors.push('rendered finding leaked key material');

  // (5) a test-path fixture with the SAME header is allow-listed (private-key is testAllowed under tests/).
  const testFindings = scanFiles({ files: ['tests/fixtures/whatever.pem'], readFile: () => fixtureContent, isTest: isTestPath });
  if (testFindings.length !== 0) errors.push('private-key header under tests/ should be allow-listed');

  if (errors.length > 0) {
    for (const e of errors) console.error(`[secret-scan:selftest] FAIL — ${e}`);
    process.exit(1);
  }
  console.log(`[secret-scan:selftest] detection OK — ${rendered.replace('[secret-scan] ', '')}`);
  console.log('[secret-scan:selftest] OK — no PEM marker in source; synthetic key detected; path:line only.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--selftest')) selfTest();
  else main();
}
