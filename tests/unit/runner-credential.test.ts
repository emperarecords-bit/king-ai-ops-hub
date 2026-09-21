import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  defaultRunnerKeyExpiry,
  generateRunnerCredential,
  hashRunnerSecret,
  hasBearerCredential,
  isRunnerKeyActive,
  parseRunnerCredential,
  RUNNER_KEY_TTL_DAYS,
  verifyRunnerSecret,
} from '@/domain/auth/runner-credential';

describe('runner credential — parsing', () => {
  const id = randomUUID();
  it('accepts a single clean Bearer keyId.secret', () => {
    const p = parseRunnerCredential(`Bearer ${id}.abcDEF123_-`);
    expect(p).toEqual({ keyId: id, secret: 'abcDEF123_-' });
  });
  it('rejects ambiguous / malformed credentials (never partially accepted)', () => {
    for (const h of [
      null,
      undefined,
      '',
      'Bearer',
      'Bearer ',
      `Bearer ${id}`, // no secret
      `Bearer ${id}.`, // empty secret
      `Bearer .secret`, // no keyId
      `Bearer ${id}.a.b`, // extra dot → ambiguous
      `Bearer not-a-uuid.secret`,
      `Basic ${id}.secret`, // wrong scheme
      `Bearer ${id}.se cret`, // whitespace in secret
    ]) {
      expect(parseRunnerCredential(h as string | null), String(h)).toBeNull();
    }
  });
  it('accepts a differently-cased scheme (HTTP schemes are case-insensitive)', () => {
    expect(parseRunnerCredential(`bearer ${id}.sec`)).toEqual({ keyId: id, secret: 'sec' });
    expect(parseRunnerCredential(`BEARER ${id}.sec`)).toEqual({ keyId: id, secret: 'sec' });
  });
  it('hasBearerCredential detects any bearer-scheme attempt (incl. empty/whitespace token) — never a fallback', () => {
    expect(hasBearerCredential(`Bearer ${id}.x`)).toBe(true);
    expect(hasBearerCredential(`bearer ${id}.x`)).toBe(true); // differently cased still committed to machine path
    expect(hasBearerCredential('BEARER x')).toBe(true);
    // An empty or whitespace-only token is still a bearer ATTEMPT — it must not fall back to a session.
    expect(hasBearerCredential('Bearer')).toBe(true);
    expect(hasBearerCredential('Bearer ')).toBe(true);
    expect(hasBearerCredential('BEARER\t')).toBe(true);
    // A different scheme (or none) is not a bearer attempt.
    expect(hasBearerCredential('Basic abc')).toBe(false);
    expect(hasBearerCredential('Bearerish token')).toBe(false);
    expect(hasBearerCredential(null)).toBe(false);
    expect(hasBearerCredential('')).toBe(false);
  });
});

describe('runner credential — scrypt hashing', () => {
  it('round-trips: a fresh hash verifies; a wrong secret does not', () => {
    const { secret } = generateRunnerCredential();
    const { hash, salt } = hashRunnerSecret(secret);
    expect(verifyRunnerSecret(secret, salt, hash)).toBe(true);
    expect(verifyRunnerSecret(secret + 'x', salt, hash)).toBe(false);
    expect(verifyRunnerSecret(secret, salt.replace(/./, (c) => (c === 'a' ? 'b' : 'a')), hash)).toBe(false);
  });
  it('uses a SEPARATE salt per credential (same secret → different salt+hash)', () => {
    const secret = 'the-same-secret-value';
    const a = hashRunnerSecret(secret);
    const b = hashRunnerSecret(secret);
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    // Each still verifies against its own salt.
    expect(verifyRunnerSecret(secret, a.salt, a.hash)).toBe(true);
    expect(verifyRunnerSecret(secret, b.salt, b.hash)).toBe(true);
  });
  it('generated secrets are 32 bytes (base64url) and unique', () => {
    const s1 = generateRunnerCredential();
    const s2 = generateRunnerCredential();
    expect(Buffer.from(s1.secret, 'base64url').length).toBe(32);
    expect(s1.secret).not.toBe(s2.secret);
    expect(s1.keyId).not.toBe(s2.keyId);
  });
});

describe('runner credential — expiry / active state', () => {
  it('default expiry is 90 days out', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const exp = defaultRunnerKeyExpiry(now);
    expect(exp.getTime() - now.getTime()).toBe(RUNNER_KEY_TTL_DAYS * 24 * 60 * 60 * 1000);
  });
  it('active only when neither revoked nor expired', () => {
    const now = new Date('2026-09-20T00:00:00.000Z');
    const future = new Date(now.getTime() + 1000);
    const past = new Date(now.getTime() - 1000);
    expect(isRunnerKeyActive({ revokedAt: null, expiresAt: future }, now)).toBe(true);
    expect(isRunnerKeyActive({ revokedAt: now, expiresAt: future }, now)).toBe(false); // revoked
    expect(isRunnerKeyActive({ revokedAt: null, expiresAt: past }, now)).toBe(false); // expired
    expect(isRunnerKeyActive({ revokedAt: null, expiresAt: now }, now)).toBe(false); // exactly expired
  });
});
