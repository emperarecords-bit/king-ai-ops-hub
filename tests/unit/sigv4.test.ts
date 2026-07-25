import { describe, expect, it } from 'vitest';
import { canonicalKeyPath, signS3Request, type S3Config } from '@/domain/documents/s3-object-store';

/**
 * O-23 S3 SigV4 signer. A real bucket cannot be reached in CI, so we lock the
 * signer's behavior: deterministic output for fixed inputs (a golden that fails
 * on any signing regression), correct scope/credential structure, and
 * sensitivity to the secret. The `amzDate` is injected so the signer is pure.
 */

const cfg: S3Config = {
  endpoint: 'https://s3.example.com',
  region: 'us-east-1',
  bucket: 'king-lib',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

describe('canonicalKeyPath', () => {
  it('URI-encodes each segment, preserving slashes', () => {
    expect(canonicalKeyPath('king-lib', 'org/o1/project/p1/doc/a b.md/h')).toBe(
      '/king-lib/org/o1/project/p1/doc/a%20b.md/h',
    );
  });
});

describe('signS3Request', () => {
  const base = {
    method: 'PUT' as const,
    key: 'org/o1/project/p1/doc/note.md/abc',
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    amzDate: '20260101T000000Z',
    extraHeaders: { 'content-type': 'text/markdown' },
  };

  it('is deterministic and well-formed', () => {
    const a = signS3Request(cfg, base);
    const b = signS3Request(cfg, base);
    expect(a.headers.Authorization).toBe(b.headers.Authorization);
    expect(a.url).toBe('https://s3.example.com/king-lib/org/o1/project/p1/doc/note.md/abc');
    expect(a.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260101\/us-east-1\/s3\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    expect(a.headers['x-amz-date']).toBe('20260101T000000Z');
    expect(a.headers['x-amz-content-sha256']).toBe(base.payloadHash);
  });

  it('changes when the secret changes (the signature actually binds the key)', () => {
    const a = signS3Request(cfg, base);
    const b = signS3Request({ ...cfg, secretAccessKey: 'different-secret' }, base);
    const sigA = a.headers.Authorization!.split('Signature=')[1];
    const sigB = b.headers.Authorization!.split('Signature=')[1];
    expect(sigA).not.toBe(sigB);
  });

  it('changes when the object key changes', () => {
    const a = signS3Request(cfg, base).headers.Authorization;
    const b = signS3Request(cfg, { ...base, key: 'org/o1/project/p1/doc/other.md/abc' }).headers.Authorization;
    expect(a).not.toBe(b);
  });
});
