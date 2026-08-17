import { type NextRequest, NextResponse } from 'next/server';
import { requireTenant } from '@/domain/auth/guard';
import { getObjectStore, ObjectNotFoundError } from '@/domain/documents/object-store';
import { mediaPrefix, sanitizeMediaName } from '@/domain/media/media';

/**
 * Screening Room playback: serve ONE workspace media object to an authenticated member of that
 * workspace. The key is rebuilt server-side from the tenant context + a sanitized name — the
 * client never supplies a storage path. Range requests are honored so video seeking works.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectKey: string; name: string }> },
): Promise<Response> {
  const { projectKey, name: rawName } = await params;
  let key: string;
  let contentType: string;
  try {
    const ctx = await requireTenant(projectKey);
    const safe = sanitizeMediaName(decodeURIComponent(rawName));
    key = `${mediaPrefix(ctx)}${safe.name}`;
    contentType = safe.contentType;
  } catch {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const store = await getObjectStore();
  let bytes: Buffer;
  try {
    bytes = await store.get(key);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    throw err;
  }

  const total = bytes.length;
  const baseHeaders: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': 'inline',
  };

  const range = req.headers.get('range');
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
  if (m && (m[1] !== '' || m[2] !== '')) {
    const start = m[1] === '' ? Math.max(0, total - Number(m[2])) : Number(m[1]);
    const end = m[1] !== '' && m[2] !== '' ? Math.min(Number(m[2]), total - 1) : total - 1;
    if (start >= total || start > end) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
    }
    const slice = bytes.subarray(start, end + 1);
    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: { ...baseHeaders, 'Content-Length': String(slice.length), 'Content-Range': `bytes ${start}-${end}/${total}` },
    });
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: { ...baseHeaders, 'Content-Length': String(total) },
  });
}
