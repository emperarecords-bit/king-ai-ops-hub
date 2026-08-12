import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const machine = JSON.parse(readFileSync(join(repositoryRoot, 'config/firecracker/rehearsal-machine.template.json'), 'utf8')) as {
  drives: Array<{ drive_id: string; is_read_only: boolean; path_on_host: string }>;
  'network-interfaces': unknown[];
};
const entrypoint = JSON.parse(readFileSync(join(repositoryRoot, 'config/firecracker/guest-entrypoint.manifest.json'), 'utf8')) as {
  architecture: string;
  artifacts: Record<string, Record<string, string>>;
  guest: {
    entrypoint: string;
    entrypointRunsAsPid1: boolean;
    executionUid: number;
    executionGid: number;
    network: string;
    environmentAllowlist: unknown[];
    workspace: { device: string; guestPath: string; filesystem: string; mountOptions: string[]; expectedIdentity: string };
    pid1Responsibilities: string[];
  };
  limits: { automaticWriteRetries: number; maxPayloadBytes: number };
};
const checker = readFileSync(join(repositoryRoot, 'scripts/firecracker/check-host-readiness.sh'), 'utf8');
const ownerGate = readFileSync(join(repositoryRoot, 'docs/architecture/file-write-owner-gate-package.md'), 'utf8');
const runbook = readFileSync(join(repositoryRoot, 'docs/runbooks/firecracker-disposable-rehearsal.md'), 'utf8');

describe('Firecracker rehearsal package', () => {
  it('has no network and exposes only a synthetic writable workspace drive', () => {
    expect(machine['network-interfaces']).toEqual([]);
    expect(machine.drives).toHaveLength(2);
    expect(machine.drives.find((drive) => drive.drive_id === 'rootfs')?.is_read_only).toBe(true);
    expect(machine.drives.find((drive) => drive.drive_id === 'workspace')).toEqual(expect.objectContaining({
      is_read_only: false,
      path_on_host: '__SYNTHETIC_WORKSPACE_IMAGE_PATH__',
    }));
  });

  it('pins a fixed entrypoint, no inherited environment, and zero write retries', () => {
    expect(entrypoint.guest.entrypoint).toBe('/sbin/king-file-write-v1');
    expect(entrypoint.guest.network).toBe('none');
    expect(entrypoint.guest.environmentAllowlist).toEqual([]);
    expect(entrypoint.limits).toEqual(expect.objectContaining({ automaticWriteRetries: 0, maxPayloadBytes: 262_144 }));
  });

  it('pins every execution artifact without embedding a credential or host path', () => {
    expect(entrypoint.architecture).toBe('__PINNED_ARCHITECTURE__');
    expect(Object.keys(entrypoint.artifacts)).toEqual(['firecracker', 'jailer', 'kernel', 'rootfs', 'entrypoint']);
    for (const artifact of Object.values(entrypoint.artifacts)) expect(artifact.sha256).toMatch(/^__PINNED_[A-Z_]+SHA256__$/);
  });

  it('defines PID-1 bootstrap, non-root execution, and the workspace mount contract', () => {
    expect(entrypoint.guest).toEqual(expect.objectContaining({ entrypointRunsAsPid1: true, executionUid: 10_000, executionGid: 10_000 }));
    expect(entrypoint.guest.workspace).toEqual({ device: '/dev/vdb', guestPath: '/workspace', filesystem: 'ext4', mountOptions: ['rw', 'nodev', 'nosuid', 'noexec'], expectedIdentity: '__PINNED_SYNTHETIC_WORKSPACE_IDENTITY__' });
    expect(entrypoint.guest.pid1Responsibilities).toEqual(expect.arrayContaining(['mount-workspace', 'drop-all-capabilities-and-privileges', 'forward-signals', 'reap-children']));
  });

  it('keeps readiness discovery-only and requires owner-approved hashes', () => {
    expect(checker).not.toMatch(/firecracker\s+--version|jailer\s+--version/);
    expect(checker).not.toMatch(/\beval\b|\bexec\b/);
    expect(checker).toContain('sha256sum');
    expect(checker).toContain('EXPECTED_SHA256');
    expect(checker).toContain('READY FOR OWNER ARTIFACT-PIN REVIEW');
  });

  it.runIf(process.platform === 'linux')('hashes executable-looking fixtures without invoking them', () => {
    const root = mkdtempSync(join(tmpdir(), 'king-firecracker-readiness-'));
    const artifacts = join(root, 'artifacts');
    const home = join(root, 'home');
    mkdirSync(artifacts);
    mkdirSync(home);
    const marker = join(root, 'executed');
    const paths = Object.fromEntries(['firecracker', 'jailer', 'kernel', 'rootfs', 'entrypoint'].map((name) => {
      const path = join(artifacts, name);
      const bytes = `#!/bin/sh\ntouch '${marker}'\n`;
      writeFileSync(path, bytes);
      chmodSync(path, 0o755);
      return [name, { path, hash: createHash('sha256').update(bytes).digest('hex') }];
    })) as Record<string, { path: string; hash: string }>;
    const firecracker = paths.firecracker;
    const jailer = paths.jailer;
    const kernel = paths.kernel;
    const rootfs = paths.rootfs;
    const entrypointArtifact = paths.entrypoint;
    if (!firecracker || !jailer || !kernel || !rootfs || !entrypointArtifact) throw new Error('artifact fixture missing');

    const result = spawnSync('bash', ['scripts/firecracker/check-host-readiness.sh'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin', HOME: home, NODE_ENV: 'test', KING_REHEARSAL_DISPOSABLE: 'true',
        KING_FIRECRACKER_PATH: firecracker.path, KING_FIRECRACKER_EXPECTED_SHA256: firecracker.hash,
        KING_JAILER_PATH: jailer.path, KING_JAILER_EXPECTED_SHA256: jailer.hash,
        KING_KERNEL_PATH: kernel.path, KING_KERNEL_EXPECTED_SHA256: kernel.hash,
        KING_ROOTFS_PATH: rootfs.path, KING_ROOTFS_EXPECTED_SHA256: rootfs.hash,
        KING_ENTRYPOINT_PATH: entrypointArtifact.path, KING_ENTRYPOINT_EXPECTED_SHA256: entrypointArtifact.hash,
        KING_SYNTHETIC_WORKSPACE_PATH: join(root, 'workspace.ext4'),
      },
    });
    expect(result.error).toBeUndefined();
    expect(result.stdout).toContain('PASS firecracker SHA-256 matches the owner-approved pin');
    expect(result.stdout).toContain('PASS jailer SHA-256 matches the owner-approved pin');
    expect(existsSync(marker)).toBe(false);
  });

  it('uses the accepted ten-second wall limit consistently', () => {
    expect(entrypoint.limits).toEqual(expect.objectContaining({ wallClockMs: 10_000 }));
    expect(ownerGate).toContain('10-second wall timeout');
    expect(ownerGate).not.toContain('15-second wall timeout');
    expect(runbook).not.toMatch(/15[- ]second wall|15000/);
  });

  it('contains placeholders rather than credentials or host paths', () => {
    const rendered = JSON.stringify({ machine, entrypoint });
    expect(rendered).not.toMatch(/(BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|C:\\\\Users|\/home\/|king-ai-ops-hub)/);
    expect(rendered).toContain('__PINNED_KERNEL_SHA256__');
  });
});
