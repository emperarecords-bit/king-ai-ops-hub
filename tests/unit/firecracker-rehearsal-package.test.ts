import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const machine = JSON.parse(readFileSync(join(repositoryRoot, 'config/firecracker/rehearsal-machine.template.json'), 'utf8')) as {
  drives: Array<{ drive_id: string; is_read_only: boolean; path_on_host: string }>;
  'network-interfaces': unknown[];
};
const entrypoint = JSON.parse(readFileSync(join(repositoryRoot, 'config/firecracker/guest-entrypoint.manifest.json'), 'utf8')) as {
  entrypoint: string;
  network: string;
  environmentAllowlist: unknown[];
  limits: { automaticWriteRetries: number; maxPayloadBytes: number };
};

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
    expect(entrypoint.entrypoint).toBe('/sbin/king-file-write-v1');
    expect(entrypoint.network).toBe('none');
    expect(entrypoint.environmentAllowlist).toEqual([]);
    expect(entrypoint.limits).toEqual(expect.objectContaining({ automaticWriteRetries: 0, maxPayloadBytes: 262_144 }));
  });

  it('contains placeholders rather than credentials or host paths', () => {
    const rendered = JSON.stringify({ machine, entrypoint });
    expect(rendered).not.toMatch(/(BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|C:\\\\Users|\/home\/|king-ai-ops-hub)/);
    expect(rendered).toContain('__PINNED_KERNEL_SHA256__');
  });
});
