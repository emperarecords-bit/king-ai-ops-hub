/**
 * VER-002 PR-2 — runner bearer credential primitives (framework-free, unit-testable).
 *
 * A credential is `keyId.secret`: `keyId` is the public row id, `secret` is a 32-byte random value
 * shown only once at issuance. Only a scrypt hash + a per-credential random salt are stored. There is
 * no human identity here — a runner is a machine principal.
 */
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

/** Default credential lifetime: 90 days (credentials expire rather than living indefinitely). */
export const RUNNER_KEY_TTL_DAYS = 90;

const SECRET_BYTES = 32;
const SALT_BYTES = 16;
const SCRYPT_KEYLEN = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedRunnerCredential {
  readonly keyId: string;
  readonly secret: string;
}

/**
 * Parse an `Authorization` header into a runner credential, or return null. Only a single, cleanly
 * formed `Bearer <keyId>.<secret>` is accepted; anything ambiguous (missing scheme, no dot, extra
 * dots, non-UUID keyId, empty secret) returns null so the caller rejects it — it must NOT fall back
 * to session auth on an invalid bearer.
 */
export function parseRunnerCredential(authorizationHeader: string | null | undefined): ParsedRunnerCredential | null {
  if (!authorizationHeader) return null;
  // The HTTP auth SCHEME is case-insensitive, so "bearer"/"BEARER" are the same scheme as "Bearer".
  // We match it case-insensitively — combined with case-insensitive detection, a differently-cased
  // bearer still commits to the machine path (and, if malformed, is rejected — never a session fallback).
  const m = /^Bearer[ \t]+(.+)$/i.exec(authorizationHeader.trim());
  if (!m) return null;
  const token = m[1]!;
  // Exactly one dot: keyId.secret. Split on the FIRST dot only, then reject if the secret itself
  // still contains structure that makes the credential ambiguous.
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return null;
  const keyId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!UUID_RE.test(keyId)) return null;
  if (secret.length === 0 || secret.includes('.') || /\s/.test(secret)) return null;
  return { keyId, secret };
}

/**
 * True when a header is a bearer-scheme ATTEMPT — the signal that commits the request to the MACHINE
 * path. Case-INSENSITIVE on the scheme, and it fires even when the token is EMPTY or whitespace-only
 * ("Bearer", "Bearer ", "BEARER\t"): those are still bearer attempts and must be rejected (401 /
 * 400-ambiguous), never allowed to fall back to a human session. The `(?=$|[ \t])` lookahead keeps a
 * different scheme like "Bearerish"/"Basic" from matching. Parsing (below) still rejects the empty/
 * malformed token, so detection ≠ acceptance.
 */
export function hasBearerCredential(authorizationHeader: string | null | undefined): boolean {
  return typeof authorizationHeader === 'string' && /^Bearer(?=$|[ \t])/i.test(authorizationHeader.trim());
}

/** Generate a new (keyId, secret) pair. The secret is returned exactly once. */
export function generateRunnerCredential(): { keyId: string; secret: string } {
  return { keyId: randomUUID(), secret: randomBytes(SECRET_BYTES).toString('base64url') };
}

/** scrypt-hash a secret with a fresh per-credential salt (or a provided salt, for verification). */
export function hashRunnerSecret(secret: string, saltHex?: string): { hash: string; salt: string } {
  const salt = saltHex ?? randomBytes(SALT_BYTES).toString('hex');
  const hash = scryptSync(secret, Buffer.from(salt, 'hex'), SCRYPT_KEYLEN).toString('hex');
  return { hash, salt };
}

/** Constant-time verification of a presented secret against a stored salt+hash. */
export function verifyRunnerSecret(secret: string, saltHex: string, expectedHashHex: string): boolean {
  if (!secret || !saltHex || !expectedHashHex) return false;
  let expected: Buffer;
  let got: Buffer;
  try {
    expected = Buffer.from(expectedHashHex, 'hex');
    got = scryptSync(secret, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
  } catch {
    return false;
  }
  if (expected.length !== got.length || expected.length === 0) return false;
  return timingSafeEqual(expected, got);
}

/** The default expiry timestamp for a newly issued credential. */
export function defaultRunnerKeyExpiry(now: Date): Date {
  return new Date(now.getTime() + RUNNER_KEY_TTL_DAYS * 24 * 60 * 60 * 1000);
}

/** Whether a stored credential is currently usable, given its revoked/expiry state. */
export function isRunnerKeyActive(key: { revokedAt: Date | null; expiresAt: Date }, now: Date): boolean {
  if (key.revokedAt !== null) return false;
  if (key.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}
