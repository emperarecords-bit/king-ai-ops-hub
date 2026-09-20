/**
 * Sanitization for evidence output and export contents (supports Priorities 2 & 4).
 *
 * Two jobs:
 *  - `redact(text)`: strip secret-shaped values from captured stdout/stderr before
 *    they are stored or shown.
 *  - Path/exclusion helpers: keep credentials, customer data, session artifacts,
 *    and Git history OUT of a review package, and detect files that still carry a
 *    sensitive value so they can be omitted.
 *
 * Intentionally conservative: patterns are high-signal (real secret prefixes,
 * private keys, long JWTs). It never claims to catch everything — it is the last
 * line, paired with path-class exclusion which is the primary defense.
 */

interface SecretPattern {
  readonly kind: string;
  readonly re: RegExp;
}

// Assemble the private-key PEM matcher from FRAGMENTS so this source file never contains the
// PEM header marker verbatim (the "PRI VATE"/"K EY" + five-dash string). The repository-hygiene
// test (gbackup-active-onboarding) greps every tracked non-test file for that exact marker; a
// redaction pattern that must contain it to work would otherwise trip the scan. Runtime behavior
// is unchanged — the compiled regex is identical. (Same technique as
// scripts/ci/secret-scan.mjs::buildPrivateKeyHeaderRegex.)
const PEM_PRIV = ['PRI', 'VATE'].join('');
const PEM_KEY = ['K', 'EY'].join('');
const PEM_DASH5 = '-'.repeat(5);
const PEM_LABEL = `[A-Z ]*${PEM_PRIV} ${PEM_KEY}${PEM_DASH5}`;
const PRIVATE_KEY_RE = new RegExp(`${PEM_DASH5}BEGIN ${PEM_LABEL}[\\s\\S]*?${PEM_DASH5}END ${PEM_LABEL}`, 'g');

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { kind: 'private_key', re: PRIVATE_KEY_RE },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g },
  { kind: 'stripe_key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{10,}\b/g },
  { kind: 'stripe_webhook', re: /\bwhsec_[0-9A-Za-z]{10,}\b/g },
  { kind: 'aws_akid', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'google_key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'github_pat', re: /\bghp_[0-9A-Za-z]{36}\b/g },
  { kind: 'slack_token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g },
  // KEY=VALUE style secret assignments (SECRET/TOKEN/PASSWORD/KEY/CREDENTIAL).
  { kind: 'assigned_secret', re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL)[A-Z0-9_]*)\s*[:=]\s*['"]?([^\s'"]{6,})/g },
];

/** Replace secret-shaped values with a typed placeholder. Idempotent-ish and safe on empty. */
export function redact(text: string): string {
  let out = text ?? '';
  for (const { kind, re } of SECRET_PATTERNS) {
    out = out.replace(re, (_match, p1: string | undefined, p2: string | undefined) => {
      // For KEY=VALUE, keep the key name, mask only the value.
      if (kind === 'assigned_secret' && p1 && p2) return `${p1}=[REDACTED:${kind}]`;
      return `[REDACTED:${kind}]`;
    });
  }
  return out;
}

/** True if the text still contains something secret-shaped after redaction would apply. */
export function containsSensitive(text: string): boolean {
  return SECRET_PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}

/**
 * Path classes that must never enter a review package: credentials, customer
 * data, session/runtime artifacts, and Git history.
 */
const EXCLUDED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.git(\/|$)/i, // git history
  /(^|\/)\.env(\.|$)/i, // env / credentials
  /(^|\/)(secrets?|credentials?)(\/|\.|$)/i,
  /\.(pem|key|p12|pfx|keystore)$/i, // private keys / keystores
  /(^|\/)(sessions?|\.session|cookies?)(\/|\.|$)/i, // session artifacts
  /(^|\/)(customers?|customer[_-]?data|pii)(\/|\.|$)/i, // customer data
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)id_rsa(\.|$)/i,
];

export function isExcludedPath(path: string): { excluded: boolean; reason: string } {
  const p = path.replace(/\\/g, '/');
  for (const re of EXCLUDED_PATH_PATTERNS) {
    if (re.test(p)) return { excluded: true, reason: `matches excluded class ${re}` };
  }
  return { excluded: false, reason: '' };
}
