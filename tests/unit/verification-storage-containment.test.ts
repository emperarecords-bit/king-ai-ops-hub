import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { LocalObjectStore } from '@/domain/documents/local-object-store';
import { objectStoreArtifactStore } from '@/domain/verification/runtime-adapters';

/**
 * Finding 1 (round 3): tenant storage containment against a REAL LocalObjectStore
 * with two synthetic projects. A prefix check alone lets
 * `org/A/project/P/../OTHER/secret` resolve into OTHER; the canonical-key guard +
 * real-path check must refuse it and never read another project's bytes.
 *
 * The fixture is built SYNCHRONOUSLY at module load so `it.skipIf` (evaluated at
 * collection time) sees whether junctions/symlinks are supported here.
 */
const base = mkdtempSync(join(tmpdir(), 'ver-store-'));
const writeAt = (key: string, data: string): void => {
  const p = join(base, key);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
};
writeAt('org/A/project/P/result', 'P-DATA');
writeAt('org/A/project/OTHER/secret', 'OTHER-SECRET');

// Directory junction inside P → project OTHER (junctions need no privilege on
// Windows; on POSIX the type falls back to a dir symlink). A key under it is
// canonical + in-partition, yet its real path resolves into OTHER.
let symlinkOk = false;
try {
  symlinkSync(join(base, 'org/A/project/OTHER'), join(base, 'org/A/project/P/jdir'), 'junction');
  symlinkOk = true;
} catch {
  symlinkOk = false;
}

const store = new LocalObjectStore(base);
const adapter = objectStoreArtifactStore({ orgId: 'A', projectId: 'P' }, store);

afterAll(() => {
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('VER-002 tenant storage containment (real local store, two projects)', () => {
  it('reads a legitimate in-partition object', async () => {
    expect((await adapter.get('org/A/project/P/result'))?.toString()).toBe('P-DATA');
  });

  it('refuses a traversal key that resolves into another project (get + head)', async () => {
    const key = 'org/A/project/P/../OTHER/secret';
    expect(await adapter.get(key)).toBeNull();
    expect(await adapter.head(key)).toBeNull();
    // OTHER's bytes exist directly, but are never returned via the traversal key.
    expect((await store.get('org/A/project/OTHER/secret')).toString()).toBe('OTHER-SECRET');
    expect((await adapter.get(key))?.toString()).not.toBe('OTHER-SECRET');
  });

  it('refuses a canonical key outside the tenant partition', async () => {
    expect(await adapter.get('org/A/project/OTHER/secret')).toBeNull();
  });

  it('refuses backslash / absolute / dot-segment keys', async () => {
    for (const k of ['org/A/project/P/..', 'org/A/project/P/./x', '/org/A/project/P/x', 'org/A/project/P/a\\b']) {
      expect(await adapter.get(k)).toBeNull();
    }
  });

  it.skipIf(!symlinkOk)('refuses a junction/symlink inside the partition that escapes to another project', async () => {
    const key = 'org/A/project/P/jdir/secret'; // canonical + in-partition, real path → OTHER
    expect(await store.keyStaysWithinTenant(key, 'org/A/project/P')).toBe(false);
    expect(await adapter.get(key)).toBeNull();
  });

  it('ordinary put refuses a verification artifact key (no overwrite of verification objects)', async () => {
    const verKey = 'org/A/project/P/request/r1/attempt/a1/obj1'; // a verification artifact key shape
    await expect(store.put(verKey, Buffer.from('x'), 'application/octet-stream')).rejects.toThrow(/verification artifact object/);
    // A non-verification key under the same tenant is still writable via put.
    await expect(store.put('org/A/project/P/doc/d1/v1', Buffer.from('ok'), 'text/plain')).resolves.toBeUndefined();
  });
});
