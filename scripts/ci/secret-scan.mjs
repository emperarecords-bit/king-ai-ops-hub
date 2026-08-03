/* eslint-disable no-console -- CI orchestration script: progress + diagnostics go to stdout/stderr by design. */
// CI-only, deterministic, repository-native secret scan (no external action, no network, no secrets required).
// Scans every tracked text file for high-confidence credential patterns and fails on any hit. Cloud/token key
// formats are enforced EVERYWHERE (they should never appear, even in tests). Private-key / JWT blocks are
// skipped under `tests/` because the G-Backup crypto/receipt suites legitimately embed generated TEST keys.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const SKIP_FILE = [
  /^package-lock\.json$/,
  /^scripts\/ci\/secret-scan\.mjs$/,
  /\.(png|jpe?g|gif|ico|webp|svg|pdf|zip|gz|tgz|woff2?|ttf|eot|node|wasm|lockb)$/i,
];

// `testAllowed: true` → skipped under tests/** (legitimate fixtures); enforced everywhere else and in non-test code.
const PATTERNS = [
  { re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, name: 'private key block', testAllowed: true },
  { re: /\beyJ[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}\b/, name: 'JWT-shaped token', testAllowed: true },
  { re: /\bAKIA[0-9A-Z]{16}\b/, name: 'AWS access key id', testAllowed: false },
  { re: /\bASIA[0-9A-Z]{16}\b/, name: 'AWS temporary key id', testAllowed: false },
  { re: /\bgh[pousr]_[0-9A-Za-z]{36,}\b/, name: 'GitHub token', testAllowed: false },
  { re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/, name: 'Slack token', testAllowed: false },
  { re: /\bsk_live_[0-9A-Za-z]{16,}\b/, name: 'Stripe live secret key', testAllowed: false },
  { re: /\bAIza[0-9A-Za-z_\-]{35}\b/, name: 'Google API key', testAllowed: false },
];

const NUL = String.fromCharCode(0);
const isTest = (f) => f.startsWith('tests/');
const files = execFileSync('git', ['ls-files'], { maxBuffer: 128 * 1024 * 1024 })
  .toString()
  .split('\n')
  .filter(Boolean);

let hits = 0;
for (const f of files) {
  if (SKIP_FILE.some((r) => r.test(f))) continue;
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (text.includes(NUL)) continue; // skip binary files
  const inTest = isTest(f);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const p of PATTERNS) {
      if (inTest && p.testAllowed) continue;
      if (p.re.test(lines[i])) {
        console.error(`[secret-scan] ${p.name} @ ${f}:${i + 1}`);
        hits++;
      }
    }
  }
}

if (hits > 0) {
  console.error(`[secret-scan] FAIL — ${hits} high-confidence secret pattern(s) found in tracked files.`);
  process.exit(1);
}
console.log(`[secret-scan] OK — scanned ${files.length} tracked files; no high-confidence secrets.`);
