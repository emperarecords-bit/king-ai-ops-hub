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

describe('canonicalization v1 — code-point ordering & edge cases (P1a correction)', () => {
  it('orders object keys by Unicode CODE POINT (supplementary plane after BMP)', () => {
    const kHigh = '￿'; // U+FFFF (BMP, 65535)
    const kSupp = String.fromCodePoint(0x1f600); // U+1F600 (supplementary, 128512; surrogate pair)
    const s = canonicalizeV1({ [kSupp]: 1, [kHigh]: 2 });
    // By code point, U+FFFF < U+1F600. (UTF-16 code-unit order would wrongly put the surrogate first.)
    expect(s.indexOf(kHigh)).toBeGreaterThanOrEqual(0);
    expect(s.indexOf(kSupp)).toBeGreaterThanOrEqual(0);
    expect(s.indexOf(kHigh)).toBeLessThan(s.indexOf(kSupp));
    // deterministic regardless of insertion order
    expect(hashCanonicalV1({ [kSupp]: 1, [kHigh]: 2 })).toBe(hashCanonicalV1({ [kHigh]: 2, [kSupp]: 1 }));
  });

  it('BMP key ordering is deterministic and code-point correct', () => {
    const s = canonicalizeV1({ b: 1, A: 2, a: 3, '0': 4 });
    // ASCII code points: '0'(48) < 'A'(65) < 'a'(97) < 'b'(98)
    expect(s).toBe('{"0":4,"A":2,"a":3,"b":1}');
  });

  it('canonically-equivalent KEY forms collapse; a post-NFC duplicate key is rejected', () => {
    const kNFC = String.fromCharCode(0x00e9);
    const kNFD = String.fromCharCode(0x0065, 0x0301);
    expect(hashCanonicalV1({ [kNFC]: 1 })).toBe(hashCanonicalV1({ [kNFD]: 1 }));
    expect(() => canonicalizeV1({ [kNFC]: 1, [kNFD]: 2 })).toThrow(CanonicalizationError);
  });

  it('normalizes negative zero to 0', () => {
    expect(canonicalizeV1({ n: -0 })).toBe('{"n":0}');
    expect(hashCanonicalV1({ n: -0 })).toBe(hashCanonicalV1({ n: 0 }));
  });

  it('rejects non-exactly-representable (unsafe) integers', () => {
    expect(() => canonicalizeV1({ n: Number.MAX_SAFE_INTEGER + 1 })).toThrow(CanonicalizationError);
    expect(() => canonicalizeV1({ n: 2 ** 53 })).toThrow(CanonicalizationError);
    expect(canonicalizeV1({ n: Number.MAX_SAFE_INTEGER })).toBe(`{"n":${Number.MAX_SAFE_INTEGER}}`);
  });

  it('empty set field is stable', () => {
    const opts = { setFields: new Set(['tags']) };
    expect(canonicalizeV1({ tags: [] }, opts)).toBe('{"tags":[]}');
    expect(hashCanonicalV1({ tags: [] }, opts)).toBe(hashCanonicalV1({ tags: [] }, opts));
  });

  it('duplicate paths that normalize equal collapse in a path+set field', () => {
    const opts = { setFields: new Set(['paths']), pathFields: new Set(['paths']) };
    expect(hashCanonicalV1({ paths: ['src/a.ts', '/src/a.ts/', 'src/a.ts'] }, opts)).toBe(
      hashCanonicalV1({ paths: ['src/a.ts'] }, opts),
    );
  });

  it('rejects a path field that normalizes outside the repo root', () => {
    expect(() => canonicalizeV1({ p: '../secret' }, { pathFields: new Set(['p']) })).toThrow(CanonicalizationError);
    expect(() => canonicalizeV1({ p: 'a/../../b' }, { pathFields: new Set(['p']) })).toThrow(CanonicalizationError);
  });

  it('hash is stable after JSON serialize + reload of a JSON-safe input', () => {
    const input = { z: 3, a: { b: [1, 2, 3], c: null }, tags: ['x', 'y'] };
    const reloaded = JSON.parse(JSON.stringify(input));
    expect(hashCanonicalV1(reloaded)).toBe(hashCanonicalV1(input));
  });
});
