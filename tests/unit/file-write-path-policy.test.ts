import { describe, expect, it } from 'vitest';
import { validateFileWriteRelativePath } from '@/domain/execution/file-write-path-policy';

describe('pure file-write path policy', () => {
  it('accepts a narrow canonical relative text target without touching the filesystem', () => {
    expect(validateFileWriteRelativePath('plans/Launch-Notes.md')).toEqual({ allowed: true, normalizedPath: 'plans/Launch-Notes.md', collisionKey: 'plans/launch-notes.md', extension: '.md' });
  });

  it.each([
    '../escape.md', 'plans/../escape.md', '/etc/passwd.txt', 'C:/escape.txt', '\\\\server\\share\\x.txt',
    'plans\\x.txt', 'https:payload.txt', '.git/config.txt', 'node_modules/pkg/readme.md', '.env.txt',
    'plans/secret-token.txt', 'plans/key.pem', 'plans/run.sh', 'plans/no-extension', 'plans/file.bin',
    'plans//x.txt', 'plans/./x.txt', 'plans/naïve.md', 'plans/name with space.md', 'CON.txt', 'plans/NUL.md',
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
});
