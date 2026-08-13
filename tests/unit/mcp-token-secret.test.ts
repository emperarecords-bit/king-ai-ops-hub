import { describe, expect, it } from 'vitest';
import {
  TOKEN_PREFIX,
  generateTokenSecret,
  hashTokenSecret,
  hashesEqual,
  isWellFormedToken,
  parseBearer,
} from '@/domain/mcp/token-secret';

describe('mcp token-secret (pure)', () => {
  it('generates a kmcp_ token whose stored hash matches a re-hash of the plaintext', () => {
    const a = generateTokenSecret();
    expect(a.secret.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(a.tokenHash).toBe(hashTokenSecret(a.secret));
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.prefix.length).toBeGreaterThan(0);
    expect(a.lastFour.length).toBe(4);
  });

  it('is unpredictable: two mints differ in secret and hash', () => {
    const a = generateTokenSecret();
    const b = generateTokenSecret();
    expect(a.secret).not.toBe(b.secret);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });

  it('hashing is deterministic and stable', () => {
    expect(hashTokenSecret('kmcp_abcdef0123456789')).toBe(hashTokenSecret('kmcp_abcdef0123456789'));
  });

  it('isWellFormedToken accepts a real token and rejects junk', () => {
    expect(isWellFormedToken(generateTokenSecret().secret)).toBe(true);
    expect(isWellFormedToken('kmcp_short')).toBe(false); // body too short
    expect(isWellFormedToken('nope_abcdefghijklmnop')).toBe(false); // wrong prefix
    expect(isWellFormedToken('kmcp_has spaces!!!!!!')).toBe(false); // illegal chars
  });

  it('parseBearer extracts only a well-formed bearer token', () => {
    const { secret } = generateTokenSecret();
    expect(parseBearer(`Bearer ${secret}`)).toBe(secret);
    expect(parseBearer(`bearer ${secret}`)).toBe(secret); // case-insensitive scheme
    expect(parseBearer(secret)).toBeNull(); // missing scheme
    expect(parseBearer('Bearer not-a-token')).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer('')).toBeNull();
  });

  it('hashesEqual is a length-safe constant-time compare', () => {
    expect(hashesEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    expect(hashesEqual('a'.repeat(64), 'b'.repeat(64))).toBe(false);
    expect(hashesEqual('abc', 'abcd')).toBe(false);
  });
});
