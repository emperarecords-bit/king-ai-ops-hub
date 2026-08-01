import { describe, expect, it } from 'vitest';
import {
  isCanonicalDeploymentNonce,
  isCanonicalEd25519SignatureB64Url,
  isCanonicalRepoPath,
  isCanonicalUint64Decimal,
  isCanonicalUtcTimestamp,
  isNonZeroCanonicalUint64Decimal,
} from '../../scripts/backup/receipt-v2-encoding';

describe('G-Backup-B1 canonical UTC timestamp', () => {
  it('accepts exactly YYYY-MM-DDTHH:mm:ss.sssZ', () => {
    expect(isCanonicalUtcTimestamp('2026-08-01T11:50:00.000Z')).toBe(true);
  });
  it('rejects offset / missing-ms / excess precision / invalid date / leap second / space', () => {
    expect(isCanonicalUtcTimestamp('2026-08-01T11:50:00+00:00')).toBe(false);
    expect(isCanonicalUtcTimestamp('2026-08-01T11:50:00Z')).toBe(false);
    expect(isCanonicalUtcTimestamp('2026-08-01T11:50:00.000000Z')).toBe(false);
    expect(isCanonicalUtcTimestamp('2026-13-01T11:50:00.000Z')).toBe(false);
    expect(isCanonicalUtcTimestamp('2026-08-01T11:50:60.000Z')).toBe(false); // leap-second spelling normalizes away
    expect(isCanonicalUtcTimestamp('2026-08-01 11:50:00.000Z')).toBe(false);
  });
});

describe('G-Backup-B1 canonical deployment nonce', () => {
  it('accepts a canonical 22-char base64url and a 32-char lowercase hex', () => {
    expect(isCanonicalDeploymentNonce('AAAAAAAAAAAAAAAAAAAAAA')).toBe(true); // 16 zero bytes, canonical
    expect(isCanonicalDeploymentNonce('deadbeefdeadbeefdeadbeefdeadbeef')).toBe(true);
  });
  it('rejects a non-canonical final-character base64url alias (same bytes, different spelling)', () => {
    // 16 zero bytes canonicalizes to "AAAA...A"; "AAAA...B" sets ignored padding bits → non-canonical.
    expect(isCanonicalDeploymentNonce('AAAAAAAAAAAAAAAAAAAAAB')).toBe(false);
  });
  it('rejects padding, uppercase hex, wrong length', () => {
    expect(isCanonicalDeploymentNonce('AAAAAAAAAAAAAAAAAAAA==')).toBe(false);
    expect(isCanonicalDeploymentNonce('DEADBEEFDEADBEEFDEADBEEFDEADBEEF')).toBe(false);
    expect(isCanonicalDeploymentNonce('deadbeef')).toBe(false);
  });
});

describe('G-Backup-B1 canonical Ed25519 signature', () => {
  it('accepts a canonical 86-char base64url decoding to 64 bytes; rejects a last-character alias', () => {
    const canonical = Buffer.alloc(64, 0).toString('base64url'); // 86 chars, canonical
    expect(canonical.length).toBe(86);
    expect(isCanonicalEd25519SignatureB64Url(canonical)).toBe(true);
    const alias = canonical.slice(0, -1) + (canonical.slice(-1) === 'A' ? 'B' : 'A'); // ignored padding bits
    expect(Buffer.from(alias, 'base64url').length).toBe(64); // decodes to same length
    expect(isCanonicalEd25519SignatureB64Url(alias)).toBe(false); // but non-canonical spelling → rejected
    expect(isCanonicalEd25519SignatureB64Url('A'.repeat(85))).toBe(false);
  });
});

describe('G-Backup-B1 canonical uint64 decimal (PostgreSQL system identifier)', () => {
  it('accepts a large value and exactly 2^64-1', () => {
    expect(isCanonicalUint64Decimal('7300338420798239475')).toBe(true);
    expect(isCanonicalUint64Decimal('18446744073709551615')).toBe(true);
    expect(isCanonicalUint64Decimal('0')).toBe(true);
  });
  it('rejects overflow, leading zero, negative, fraction, scientific notation', () => {
    expect(isCanonicalUint64Decimal('18446744073709551616')).toBe(false); // 2^64
    expect(isCanonicalUint64Decimal('0123')).toBe(false);
    expect(isCanonicalUint64Decimal('-1')).toBe(false);
    expect(isCanonicalUint64Decimal('1.0')).toBe(false);
    expect(isCanonicalUint64Decimal('1e3')).toBe(false);
  });
});

describe('G-Backup-B1 nonzero canonical uint64 (PostgreSQL system id must be > 0)', () => {
  it('accepts 1 and 2^64-1; rejects 0 and non-canonical forms', () => {
    expect(isNonZeroCanonicalUint64Decimal('1')).toBe(true);
    expect(isNonZeroCanonicalUint64Decimal('7300338420798239475')).toBe(true);
    expect(isNonZeroCanonicalUint64Decimal('18446744073709551615')).toBe(true);
    expect(isNonZeroCanonicalUint64Decimal('0')).toBe(false); // zero is not a valid system id
    expect(isNonZeroCanonicalUint64Decimal('18446744073709551616')).toBe(false);
    expect(isNonZeroCanonicalUint64Decimal('01')).toBe(false);
  });
});

describe('G-Backup-B1 canonical repo path (NFC POSIX, safe segments)', () => {
  it('accepts a canonical repo-relative path', () => {
    expect(isCanonicalRepoPath('drizzle/0054_example.sql')).toBe(true);
    expect(isCanonicalRepoPath('a.sql')).toBe(true);
  });
  it('rejects absolute / backslash / traversal / empty-segment / control / non-NFC / overlong', () => {
    expect(isCanonicalRepoPath('/drizzle/x.sql')).toBe(false);
    expect(isCanonicalRepoPath('drizzle\\x.sql')).toBe(false);
    expect(isCanonicalRepoPath('drizzle/../secret')).toBe(false);
    expect(isCanonicalRepoPath('drizzle//x.sql')).toBe(false);
    expect(isCanonicalRepoPath('drizzle/./x.sql')).toBe(false);
    expect(isCanonicalRepoPath('drizzle/x .sql')).toBe(false); // space is not a safe segment char
    expect(isCanonicalRepoPath('café/x.sql')).toBe(false); // non-ASCII segment fails the safe-segment class
    expect(isCanonicalRepoPath('é.sql')).toBe(false); // decomposed (non-NFC) input
    expect(isCanonicalRepoPath('')).toBe(false);
    expect(isCanonicalRepoPath('a/'.repeat(200) + 'x')).toBe(false); // > 256 chars
  });
});
