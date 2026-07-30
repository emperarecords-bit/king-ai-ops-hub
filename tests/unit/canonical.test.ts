import { describe, expect, it } from 'vitest';
import {
  CANONICALIZATION_VERSION,
  CanonicalizationError,
  canonicalizeV1,
  hashCanonicalString,
  hashCanonicalV1,
  normalizeRepoPath,
} from '@/lib/canonical';

const CTRL = (n: number) => String.fromCharCode(n);

describe('canonicalization v1', () => {
  it('is deterministic (same input → same hash across calls)', () => {
    const v = { z: 1, a: [3, 2, 1], nested: { b: true, a: null } };
    expect(hashCanonicalV1(v)).toBe(hashCanonicalV1(v));
    expect(canonicalizeV1(v)).toBe(canonicalizeV1(v));
  });

  it('object-key order does not change the hash', () => {
    expect(hashCanonicalV1({ a: 1, b: 2 })).toBe(hashCanonicalV1({ b: 2, a: 1 }));
  });

  it('set fields: ordering and duplicates do not change the hash', () => {
    const opts = { setFields: new Set(['tags']) };
    expect(hashCanonicalV1({ tags: ['x', 'a', 'a', 'b'] }, opts)).toBe(
      hashCanonicalV1({ tags: ['b', 'a', 'x'] }, opts),
    );
  });

  it('sequence fields: ordering DOES change the hash', () => {
    expect(hashCanonicalV1({ seq: ['a', 'b'] })).not.toBe(hashCanonicalV1({ seq: ['b', 'a'] }));
  });

  it('Unicode-equivalent strings normalize consistently (NFC)', () => {
    const nfc = String.fromCharCode(0x00e9); // é precomposed
    const nfd = String.fromCharCode(0x0065, 0x0301); // e + combining acute
    expect(nfc).not.toBe(nfd); // distinct code points before normalization
    expect(hashCanonicalV1({ x: nfc })).toBe(hashCanonicalV1({ x: nfd }));
  });

  it('omitted and explicit-null values remain distinct', () => {
    expect(canonicalizeV1({ a: null })).not.toBe(canonicalizeV1({}));
    expect(canonicalizeV1({ a: null })).toBe('{"a":null}');
    expect(canonicalizeV1({ a: undefined })).toBe('{}'); // undefined = omitted
  });

  it('rejects path traversal and invalid path forms', () => {
    expect(() => normalizeRepoPath('../etc/passwd')).toThrow(CanonicalizationError);
    expect(() => normalizeRepoPath('a/./b')).toThrow(CanonicalizationError);
    expect(() => normalizeRepoPath('a//b')).toThrow(CanonicalizationError);
    expect(() => normalizeRepoPath('a\\b')).toThrow(CanonicalizationError);
    expect(normalizeRepoPath('/src/lib/x.ts/')).toBe('src/lib/x.ts'); // trims edge slashes
    expect(normalizeRepoPath('src/Lib/X.ts')).toBe('src/Lib/X.ts'); // case-sensitive
  });

  it('rejects control characters in strings and keys (incl. TAB and DEL)', () => {
    expect(() => canonicalizeV1({ x: CTRL(9) })).toThrow(CanonicalizationError); // TAB
    expect(() => canonicalizeV1({ x: CTRL(0) })).toThrow(CanonicalizationError); // NUL
    expect(() => canonicalizeV1({ x: CTRL(127) })).toThrow(CanonicalizationError); // DEL
    expect(() => canonicalizeV1({ [CTRL(1)]: 'v' })).toThrow(CanonicalizationError); // control key
  });

  it('canonical decimal numbers; bigint supported; non-finite rejected', () => {
    expect(canonicalizeV1({ n: 1000000 })).toBe('{"n":1000000}');
    expect(canonicalizeV1({ n: 750000n })).toBe('{"n":750000}');
    expect(canonicalizeV1({ n: 1.5 })).toBe('{"n":1.5}');
    expect(() => canonicalizeV1({ n: Number.POSITIVE_INFINITY })).toThrow(CanonicalizationError);
    expect(() => canonicalizeV1({ n: NaN })).toThrow(CanonicalizationError);
  });

  it('canonicalization version changes produce a SEPARATE hash domain', () => {
    const canonical = canonicalizeV1({ a: 1 });
    expect(hashCanonicalString(canonical, 1)).not.toBe(hashCanonicalString(canonical, 2));
    // hashCanonicalV1 uses the current version
    expect(hashCanonicalV1({ a: 1 })).toBe(hashCanonicalString(canonical, CANONICALIZATION_VERSION));
  });
});
