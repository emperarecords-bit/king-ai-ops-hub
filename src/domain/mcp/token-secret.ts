import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Pure helpers for the MCP bearer token (Phase 5). No I/O, no database — so the token format and its hashing
 * are unit-testable in isolation. See docs/architecture/mcp-server-decision.md.
 *
 * Wire form: `kmcp_<base64url(32 random bytes)>`. Only the SHA-256 hash is ever stored; the plaintext is shown
 * once at mint and never persisted, logged, or returned again.
 */

export const TOKEN_PREFIX = 'kmcp_';
const SECRET_BYTES = 32;
/** Non-secret identifier retained for listings: the first N chars of the random part. */
const DISPLAY_PREFIX_LEN = 8;

export interface MintedSecret {
  /** The full plaintext token — returned to the caller ONCE, never stored. */
  readonly secret: string;
  /** SHA-256 hex of `secret`; this is what the row stores and what resolution matches. */
  readonly tokenHash: string;
  /** Non-secret leading chars (after the prefix) shown in listings. */
  readonly prefix: string;
  /** Last four chars of the random part, shown in listings. */
  readonly lastFour: string;
}

/** SHA-256 hex of an already-formed token string. Deterministic; used at mint and on every resolution. */
export function hashTokenSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** Generate a fresh random token and its stored derivatives. */
export function generateTokenSecret(): MintedSecret {
  const random = randomBytes(SECRET_BYTES).toString('base64url');
  const secret = `${TOKEN_PREFIX}${random}`;
  return {
    secret,
    tokenHash: hashTokenSecret(secret),
    prefix: random.slice(0, DISPLAY_PREFIX_LEN),
    lastFour: random.slice(-4),
  };
}

/** True iff `value` has the exact `kmcp_` shape with a non-empty base64url body. Cheap pre-filter before hashing. */
export function isWellFormedToken(value: string): boolean {
  if (!value.startsWith(TOKEN_PREFIX)) return false;
  const body = value.slice(TOKEN_PREFIX.length);
  return body.length >= 16 && /^[A-Za-z0-9_-]+$/.test(body);
}

/**
 * Extract the bearer token from an `Authorization` header value, or null. Accepts exactly `Bearer <token>`
 * (case-insensitive scheme). Returns null for anything malformed rather than throwing.
 */
export function parseBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  if (!m) return null;
  const token = m[1]!.trim();
  return isWellFormedToken(token) ? token : null;
}

/** Constant-time hex-hash comparison, for callers that compare two stored hashes without leaking timing. */
export function hashesEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
