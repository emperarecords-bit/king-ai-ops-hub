/**
 * G-Backup-B1 correction — canonical encoding validators shared by the v2 schema and verifier.
 *
 * Length + character-class checks are NOT sufficient for unpadded base64url: multiple final characters can decode
 * to identical bytes through unused padding bits. Every base64url value here must therefore survive a strict
 * decode → re-encode round-trip. Timestamps must be exactly `YYYY-MM-DDTHH:mm:ss.sssZ` and round-trip through
 * Date (rejecting offsets, missing/excess fractional precision, invalid calendar dates, and leap-second spellings).
 * The PostgreSQL system identifier is validated as an unsigned-64-bit canonical decimal via BigInt (never Number).
 */

const CANONICAL_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX32_RE = /^[0-9a-f]{32}$/;
const B64URL22_RE = /^[A-Za-z0-9_-]{22}$/;
const B64URL86_RE = /^[A-Za-z0-9_-]{86}$/;
const UINT_DECIMAL_RE = /^(?:0|[1-9][0-9]*)$/;
const UINT64_MAX = 18446744073709551615n;

/** Exactly `YYYY-MM-DDTHH:mm:ss.sssZ`, a valid date, and its own canonical spelling (round-trips through Date). */
export function isCanonicalUtcTimestamp(s: unknown): s is string {
  if (typeof s !== 'string' || !CANONICAL_UTC_RE.test(s)) return false;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return false;
  return new Date(t).toISOString() === s; // rejects invalid dates, leap seconds, and non-canonical spellings
}

/** 128-bit nonce: lowercase hex(32) OR unpadded base64url(22), each canonical (exact round-trip to 16 bytes). */
export function isCanonicalDeploymentNonce(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (HEX32_RE.test(s)) return Buffer.from(s, 'hex').length === 16; // lowercase-hex, exact 32 chars → 16 bytes
  if (B64URL22_RE.test(s)) {
    const b = Buffer.from(s, 'base64url');
    return b.length === 16 && b.toString('base64url') === s; // reject non-canonical final-char aliases / padding
  }
  return false;
}

/** Ed25519 signature: unpadded base64url(86) that decodes to exactly 64 bytes AND re-encodes to the same string. */
export function isCanonicalEd25519SignatureB64Url(s: unknown): s is string {
  if (typeof s !== 'string' || !B64URL86_RE.test(s)) return false;
  const b = Buffer.from(s, 'base64url');
  return b.length === 64 && b.toString('base64url') === s;
}

/** Canonical unsigned-64-bit decimal string (digits only, no sign/leading-zero, ≤ 2^64-1), validated via BigInt. */
export function isCanonicalUint64Decimal(s: unknown): s is string {
  if (typeof s !== 'string' || !UINT_DECIMAL_RE.test(s)) return false;
  try {
    return BigInt(s) <= UINT64_MAX;
  } catch {
    return false;
  }
}

/** As {@link isCanonicalUint64Decimal} but strictly positive (1 ≤ n ≤ 2^64-1) — for the PostgreSQL system id. */
export function isNonZeroCanonicalUint64Decimal(s: unknown): s is string {
  if (!isCanonicalUint64Decimal(s)) return false;
  try {
    return BigInt(s) >= 1n;
  } catch {
    return false;
  }
}

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]+$/;

/** Canonical repo-relative POSIX path: safe segments, no absolute/backslash/`.`/`..`/repeated-sep/control, NFC. */
export function isCanonicalRepoPath(p: unknown): p is string {
  if (typeof p !== 'string' || p.length === 0 || p.length > 256) return false;
  if (p.normalize('NFC') !== p) return false; // reject non-NFC
  if (p.includes('\\') || p.startsWith('/')) return false;
  for (const seg of p.split('/')) {
    if (seg.length === 0 || seg === '.' || seg === '..') return false;
    if (!SAFE_PATH_SEGMENT.test(seg)) return false;
  }
  return true;
}
