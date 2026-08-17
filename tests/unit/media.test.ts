import { describe, expect, it } from 'vitest';
import { listWorkspaceMedia, mediaPrefix, putWorkspaceMedia, sanitizeMediaName } from '@/domain/media/media';
import { type ObjectStore, type StoredObjectHead } from '@/domain/documents/object-store';
import { type TenantContext } from '@/types/domain';

/** Screening Room — key isolation, name hygiene, and the list/put contract on an in-memory store. */

const ctx = (projectId: string): TenantContext => ({
  userId: 'u',
  orgId: 'o',
  projectId,
  orgRole: 'owner',
  projectRole: 'admin',
});

function memoryStore(): ObjectStore & { objects: Map<string, { body: Buffer; contentType: string }> } {
  const objects = new Map<string, { body: Buffer; contentType: string }>();
  return {
    driver: 'local',
    objects,
    async put(key, body, contentType) {
      objects.set(key, { body, contentType });
    },
    async get(key) {
      const o = objects.get(key);
      if (!o) throw new Error('missing');
      return o.body;
    },
    async head(key): Promise<StoredObjectHead | null> {
      const o = objects.get(key);
      return o ? { size: o.body.length, contentType: o.contentType } : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix));
    },
  };
}

describe('screening room media', () => {
  it('sanitizes names strictly — path tricks and unknown types are refused, never repaired', () => {
    expect(sanitizeMediaName('Pilot_v001.mp4')).toMatchObject({ kind: 'video', contentType: 'video/mp4' });
    // Path components are stripped to the basename — traversal is neutralized, not honored.
    expect(sanitizeMediaName('C:\\evil\\..\\shot.png').name).toBe('shot.png');
    expect(sanitizeMediaName('../escape.mp4').name).toBe('escape.mp4');
    expect(sanitizeMediaName('nested/path.mp4').name).toBe('path.mp4');
    expect(() => sanitizeMediaName('run.exe')).toThrow();
    expect(() => sanitizeMediaName('.hidden.mp4')).toThrow(); // must start alphanumeric
    expect(() => sanitizeMediaName('')).toThrow();
  });

  it('put + list stay inside the workspace prefix; foreign and non-media keys never leak', async () => {
    const store = memoryStore();
    const a = ctx('proj-a');
    const b = ctx('proj-b');

    await putWorkspaceMedia(store, a, 'pilot.mp4', Buffer.from('vvvv'));
    await putWorkspaceMedia(store, a, 'poster.png', Buffer.from('iiii'));
    await putWorkspaceMedia(store, b, 'other.mp4', Buffer.from('bbbb'));
    // Non-media junk under the prefix is ignored by the listing, not served.
    await store.put(`${mediaPrefix(a)}notes.txt`, Buffer.from('t'), 'text/plain');

    const listA = await listWorkspaceMedia(store, a);
    expect(listA.map((i) => i.name).sort()).toEqual(['pilot.mp4', 'poster.png']);
    expect(listA.find((i) => i.name === 'pilot.mp4')).toMatchObject({ kind: 'video', sizeBytes: 4 });

    const listB = await listWorkspaceMedia(store, b);
    expect(listB.map((i) => i.name)).toEqual(['other.mp4']);
  });

  it('rejects empty and oversized files', async () => {
    const store = memoryStore();
    await expect(putWorkspaceMedia(store, ctx('p'), 'empty.mp4', Buffer.alloc(0))).rejects.toThrow();
    process.env.MAX_MEDIA_UPLOAD_BYTES = '10';
    try {
      await expect(putWorkspaceMedia(store, ctx('p'), 'big.mp4', Buffer.alloc(11))).rejects.toThrow(/too large/);
    } finally {
      delete process.env.MAX_MEDIA_UPLOAD_BYTES;
    }
  });
});
