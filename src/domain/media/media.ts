import 'server-only';
import { type ObjectStore } from '@/domain/documents/object-store';
import { ValidationError } from '@/lib/errors';
import { type TenantContext } from '@/types/domain';

/**
 * Screening Room (owner directive 2026-08-17): every workspace gets a media shelf — videos,
 * images, and audio stored in the workspace's object bucket under an isolated per-project
 * prefix, playable in the browser. This is deliberately SEPARATE from Documents (text that
 * feeds AI runs): media is for HUMAN eyes and ears, it never enters run context.
 *
 * Keys are `media/<projectId>/<sanitized-name>`; the projectId in the prefix comes from the
 * authenticated tenant context only, so listing/serving can never cross a workspace wall.
 */

export const MEDIA_TYPES: Readonly<Record<string, { contentType: string; kind: 'video' | 'image' | 'audio' }>> = {
  mp4: { contentType: 'video/mp4', kind: 'video' },
  m4v: { contentType: 'video/mp4', kind: 'video' },
  webm: { contentType: 'video/webm', kind: 'video' },
  mov: { contentType: 'video/quicktime', kind: 'video' },
  png: { contentType: 'image/png', kind: 'image' },
  jpg: { contentType: 'image/jpeg', kind: 'image' },
  jpeg: { contentType: 'image/jpeg', kind: 'image' },
  gif: { contentType: 'image/gif', kind: 'image' },
  webp: { contentType: 'image/webp', kind: 'image' },
  mp3: { contentType: 'audio/mpeg', kind: 'audio' },
  wav: { contentType: 'audio/wav', kind: 'audio' },
  m4a: { contentType: 'audio/mp4', kind: 'audio' },
};

export function maxMediaBytes(): number {
  const v = Number(process.env.MAX_MEDIA_UPLOAD_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 200_000_000; // 200 MB default — room for finished cuts
}

export function mediaPrefix(ctx: TenantContext): string {
  return `media/${ctx.projectId}/`;
}

/** Safe display name → safe key segment. Refuses rather than repairs anything path-like. */
export function sanitizeMediaName(rawName: string): { name: string; contentType: string; kind: 'video' | 'image' | 'audio' } {
  const base = rawName.split(/[\\/]/).pop() ?? '';
  const name = base.trim();
  if (name.length === 0 || name.length > 180) throw new ValidationError(['Invalid file name.']);
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/.test(name) || name.includes('..')) {
    throw new ValidationError(['File name may only use letters, numbers, spaces, dots, dashes, parentheses.']);
  }
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  const type = MEDIA_TYPES[ext];
  if (!type) {
    throw new ValidationError([`Unsupported media type ".${ext}". Supported: ${Object.keys(MEDIA_TYPES).join(', ')}.`]);
  }
  return { name, contentType: type.contentType, kind: type.kind };
}

export interface MediaItem {
  readonly name: string;
  readonly kind: 'video' | 'image' | 'audio';
  readonly contentType: string;
  readonly sizeBytes: number | null;
}

const MAX_LISTED = 200;

/** The workspace's media shelf, newest-name-agnostic (alphabetical; names carry versions). */
export async function listWorkspaceMedia(store: ObjectStore, ctx: TenantContext): Promise<readonly MediaItem[]> {
  if (!store.list) return [];
  const prefix = mediaPrefix(ctx);
  const keys = (await store.list(prefix)).slice(0, MAX_LISTED).sort();
  const items: MediaItem[] = [];
  for (const key of keys) {
    const name = key.slice(prefix.length);
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const type = MEDIA_TYPES[ext];
    if (!type || name.includes('/')) continue; // ignore anything that is not a direct, supported media file
    const head = await store.head(key);
    items.push({ name, kind: type.kind, contentType: type.contentType, sizeBytes: head?.size ?? null });
  }
  return items;
}

/** Store one media file under this workspace's prefix. Caller enforces admin authority. */
export async function putWorkspaceMedia(
  store: ObjectStore,
  ctx: TenantContext,
  rawName: string,
  bytes: Buffer,
): Promise<{ name: string; key: string }> {
  const { name, contentType } = sanitizeMediaName(rawName);
  if (bytes.length === 0) throw new ValidationError(['Empty file.']);
  if (bytes.length > maxMediaBytes()) {
    throw new ValidationError([`File too large (max ${Math.floor(maxMediaBytes() / 1_000_000)} MB).`]);
  }
  const key = `${mediaPrefix(ctx)}${name}`;
  await store.put(key, bytes, contentType);
  return { name, key };
}
