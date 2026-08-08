import { describe, expect, it } from 'vitest';
import { FILE_WRITE_MAX_PATH_BYTES, validateFileWriteRelativePath } from '@/domain/execution/file-write-path-policy';

describe('pure file-write path policy', () => {
  it('accepts a narrow canonical relative text target without touching the filesystem', () => {
    expect(validateFileWriteRelativePath('plans/Launch-Notes.md')).toEqual({ allowed: true, normalizedPath: 'plans/Launch-Notes.md', collisionKey: 'plans/launch-notes.md', extension: '.md' });
  });

  it.each([
    '../escape.md', 'plans/../escape.md', 'a/../../secret.md', '/etc/passwd.txt', 'C:/escape.txt', 'C:\\Windows\\system.ini',
    '\\\\server\\share\\x.txt', '//server/share/file.txt', 'plans\\..\\secret.md', 'https:payload.txt',
    '.git/config.txt', '.git', 'foo/.git/bar.md', 'node_modules/pkg/readme.md', 'NODE_MODULES/pkg/readme.md',
    '.env.txt', 'plans/secret-token.txt', 'plans/key.pem', 'plans/run.sh', 'plans/no-extension', 'plans/file.bin',
    'plans//x.txt', 'plans/./x.txt', 'plans/name with space.md', 'CON.txt', 'plans/NUL.md', '', '.', '..',
    'plans/trailing.md.', 'plans/trailing .md', 'plans/a\u202eb.md',
  ])('denies adversarial or out-of-policy target %s', (path) => {
    expect(validateFileWriteRelativePath(path).allowed).toBe(false);
  });

  it('denies over-depth and over-length targets', () => {
    expect(validateFileWriteRelativePath(`${Array.from({ length: 13 }, () => 'a').join('/')}.md`).allowed).toBe(false);
    expect(validateFileWriteRelativePath(`${'a'.repeat(238)}.md`).allowed).toBe(false);
  });

  it('returns the same collision key for portable case variants', () => {
    const a = validateFileWriteRelativePath('Plans/Readme.md');
    const b = validateFileWriteRelativePath('plans/README.md');
    expect(a.allowed && b.allowed && a.collisionKey).toBe(b.allowed ? b.collisionKey : null);
  });

  it('preserves safe pre-normalized Unicode without changing path identity', () => {
    expect(validateFileWriteRelativePath('plans/café-東京.md')).toMatchObject({ allowed: true, normalizedPath: 'plans/café-東京.md' });
    expect(validateFileWriteRelativePath('plans/cafe\u0301.md').allowed).toBe(false);
  });

  it('enforces the maximum using UTF-8 bytes', () => {
    const exact = `${'a'.repeat(79)}/${'b'.repeat(79)}/${'c'.repeat(77)}.md`;
    expect(Buffer.byteLength(exact)).toBe(FILE_WRITE_MAX_PATH_BYTES);
    expect(validateFileWriteRelativePath(exact).allowed).toBe(true);
    expect(validateFileWriteRelativePath(exact.replace(/c{77}/, 'c'.repeat(78))).allowed).toBe(false);
  });
});
