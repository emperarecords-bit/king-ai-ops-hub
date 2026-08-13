import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const sourcePath = join(repositoryRoot, 'guest/king-file-write-v1/king-file-write-v1.c');
const source = readFileSync(sourcePath, 'utf8');
const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');

function compiler(): string | null {
  if (process.platform !== 'linux') return null;
  for (const candidate of ['cc', 'gcc', 'clang']) {
    if (spawnSync(candidate, ['--version'], { stdio: 'ignore' }).status === 0) return candidate;
  }
  return null;
}

describe('king-file-write-v1 guest helper', () => {
  it('contains no command execution or networking capability', () => {
    expect(source).not.toMatch(/\b(system|popen|execl|execv|execve|forkpty|connect)\s*\(/);
    expect(source).not.toContain('AF_INET');
    expect(source).toContain('AF_ALG');
    expect(source).toContain('RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_XDEV');
    expect(source).toContain('RENAME_NOREPLACE');
    expect(source).toContain('clearenv()');
  });

  it.runIf(compiler() !== null)('proves create/replace and blocks traversal/symlink/adversarial requests in a disposable directory', () => {
    const cc = compiler();
    if (!cc) throw new Error('compiler disappeared');
    const root = mkdtempSync(join(tmpdir(), 'king-file-write-guest-'));
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    mkdirSync(workspace);
    mkdirSync(outside);
    mkdirSync(join(workspace, 'plans'));
    symlinkSync(outside, join(workspace, 'escape'));
    const binary = join(root, 'king-file-write-v1-test');
    const compile = spawnSync(cc, ['-std=c17', '-O2', '-Wall', '-Wextra', '-Werror', '-DKING_FILE_WRITE_TESTING', sourcePath, '-o', binary], { encoding: 'utf8' });
    expect(compile.stderr).toBe('');
    expect(compile.status).toBe(0);
    chmodSync(binary, 0o755);

    const invoke = (args: string[], payload: string) => spawnSync(binary, args, {
      input: payload,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'test', KING_TEST_WORKSPACE: workspace },
    });
    const created = 'synthetic create\n';
    expect(invoke(['create', 'plans/created.md', 'absent', sha256(created)], created)).toEqual(expect.objectContaining({ status: 0 }));
    expect(readFileSync(join(workspace, 'plans/created.md'), 'utf8')).toBe(created);

    const replacement = 'synthetic replace\n';
    expect(invoke(['replace', 'plans/created.md', sha256(created), sha256(replacement)], replacement)).toEqual(expect.objectContaining({ status: 0 }));
    expect(readFileSync(join(workspace, 'plans/created.md'), 'utf8')).toBe(replacement);

    expect(invoke(['create', '../outside.md', 'absent', sha256('x')], 'x').status).toBe(2);
    expect(invoke(['create', 'escape/escaped.md', 'absent', sha256('x')], 'x').status).toBe(2);
    expect(invoke(['create', '.hidden.md', 'absent', sha256('x')], 'x').status).toBe(2);
    expect(invoke(['create', 'node_modules/blocked.md', 'absent', sha256('x')], 'x').status).toBe(2);
    expect(invoke(['create', 'plans/executable.sh', 'absent', sha256('x')], 'x').status).toBe(2);
    expect(invoke(['create', 'plans/invalid-hash.md', 'absent', 'g'.repeat(64)], 'x').status).toBe(2);
    expect(invoke(['replace', 'plans/created.md', sha256('wrong'), sha256('x')], 'x').status).toBe(2);
    expect(invoke(['create', 'plans/hash-mismatch.md', 'absent', sha256('other')], 'x').status).toBe(3);
    expect(invoke(['create', 'plans/control.md', 'absent', sha256('bad\u0000byte')], 'bad\u0000byte').status).toBe(3);
    expect(invoke(['create', 'plans/oversize.md', 'absent', sha256('x'.repeat(262145))], 'x'.repeat(262145)).status).toBe(3);
    expect(existsSync(join(outside, 'escaped.md'))).toBe(false);
    expect(lstatSync(join(workspace, 'escape')).isSymbolicLink()).toBe(true);
  });
});
