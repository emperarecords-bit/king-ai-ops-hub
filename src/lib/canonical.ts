import { createHash } from 'node:crypto';

/**
 * Canonicalization v1 — a standalone, pure, deterministic JSON canonicalizer + SHA-256 hasher for
 * governance boundary hashing (P1a). It is intentionally ISOLATED from the orchestration engine's
 * `canonicalJson` (src/orchestration/actions.ts): governance hashing must never be perturbed by a change
 * made for run-action extraction, and vice versa. No I/O, no DB, no provider access — pure functions only.
 *
 * v1 rules:
 *  - UTF-8 + Unicode NFC normalization of every string value AND every object key.
 *  - Object keys ordered lexicographically by UTF-16 code unit (stable, locale-independent).
 *  - Arrays: DESIGNATED "set" fields (by key name) are sorted by canonical form + de-duplicated;
 *    all other arrays are SEQUENCES and preserve order.
 *  - DESIGNATED "path" fields are normalized as repo-relative POSIX paths (reject `.`/`..`, backslashes,
 *    empty/duplicate segments; case-sensitive).
 *  - Canonical decimal numbers (no exponent, no trailing zeros); non-finite rejected; bigint allowed.
 *  - Omitted (absent/undefined) keys are dropped; an explicit `null` is preserved — the two are distinct.
 *  - Control characters (C0 + DEL) are rejected in any string or key.
 *  - The hash domain is versioned: the digest input is prefixed with the canonicalization version, so a
 *    future v2 produces a DIFFERENT digest for identical data (a separate hash domain).
 */

export const CANONICALIZATION_VERSION = 1 as const;
export const HASH_ALGORITHM = 'sha256' as const;

export class CanonicalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalizationError';
  }
}

// C0 control chars (U+0000-U+001F) and DEL (U+007F) are rejected everywhere.
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c <= 0x1f || c === 0x7f) return true;
  }
  return false;
}

export interface CanonicalizeOptions {
  /** Key names whose array values are treated as SETS (sorted + de-duplicated). */
  readonly setFields?: ReadonlySet<string>;
  /** Key names whose string values are normalized as repo-relative POSIX paths. */
  readonly pathFields?: ReadonlySet<string>;
}

/** Normalize a repo-relative POSIX path. Rejects traversal, backslashes, control chars, empty segments. */
export function normalizeRepoPath(input: string): string {
  if (typeof input !== 'string') throw new CanonicalizationError('path must be a string');
  if (hasControlChar(input)) throw new CanonicalizationError('control character in path');
  const nfc = input.normalize('NFC');
  if (nfc.includes('\\')) throw new CanonicalizationError('backslash not allowed in repo-relative POSIX path');
  const trimmed = nfc.replace(/^\/+/, '').replace(/\/+$/, '');
  if (trimmed.length === 0) throw new CanonicalizationError('empty path');
  const segments = trimmed.split('/');
  for (const seg of segments) {
    if (seg === '') throw new CanonicalizationError('empty path segment (consecutive slashes)');
    if (seg === '.' || seg === '..') throw new CanonicalizationError('path traversal (.,..) not allowed');
  }
  return segments.join('/'); // case-sensitive: segments preserved as-is
}

function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) throw new CanonicalizationError('non-finite number');
  if (Number.isInteger(n)) return Object.is(n, -0) ? '0' : n.toString();
  let s = n.toString();
  if (s.includes('e') || s.includes('E')) s = n.toFixed(20);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s;
}

function encodeString(v: string): string {
  if (hasControlChar(v)) throw new CanonicalizationError('control character in string');
  return JSON.stringify(v.normalize('NFC'));
}

function canon(value: unknown, keyName: string, opts: CanonicalizeOptions): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') {
    const s = value as string;
    return opts.pathFields?.has(keyName) ? JSON.stringify(normalizeRepoPath(s)) : encodeString(s);
  }
  if (t === 'number') return canonicalNumber(value as number);
  if (t === 'bigint') return (value as bigint).toString();
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'undefined') throw new CanonicalizationError('undefined is not encodable; omit the key or use null');
  if (Array.isArray(value)) {
    const items = value.map((x) => canon(x, keyName, opts));
    if (opts.setFields?.has(keyName)) {
      const uniqueSorted = Array.from(new Set(items)).sort();
      return '[' + uniqueSorted.join(',') + ']';
    }
    return '[' + items.join(',') + ']';
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined); // omitted/undefined dropped; null kept
    for (const k of keys) if (hasControlChar(k)) throw new CanonicalizationError('control character in object key');
    const normalized = keys.map((k) => ({ raw: k, nfc: k.normalize('NFC') }));
    normalized.sort((a, b) => (a.nfc < b.nfc ? -1 : a.nfc > b.nfc ? 1 : 0));
    const seen = new Set<string>();
    const parts = normalized.map(({ raw, nfc }) => {
      if (seen.has(nfc)) throw new CanonicalizationError(`duplicate object key after NFC normalization: ${nfc}`);
      seen.add(nfc);
      return JSON.stringify(nfc) + ':' + canon(obj[raw], nfc, opts);
    });
    return '{' + parts.join(',') + '}';
  }
  throw new CanonicalizationError(`unsupported value type: ${t}`);
}

/** Deterministic canonical JSON string for `value` under v1 rules. Pure. */
export function canonicalizeV1(value: unknown, opts: CanonicalizeOptions = {}): string {
  return canon(value, '', opts);
}

/** SHA-256 hex digest over the version-prefixed canonical form (versioned hash domain). */
export function hashCanonicalV1(value: unknown, opts: CanonicalizeOptions = {}): string {
  const canonical = canonicalizeV1(value, opts);
  return hashCanonicalString(canonical, CANONICALIZATION_VERSION);
}

/** Hash a pre-computed canonical string under an explicit canonicalization version (domain-separated). */
export function hashCanonicalString(canonical: string, canonicalizationVersion: number): string {
  return createHash('sha256')
    .update(`canonical/v${canonicalizationVersion}\n`, 'utf8')
    .update(canonical, 'utf8')
    .digest('hex');
}
