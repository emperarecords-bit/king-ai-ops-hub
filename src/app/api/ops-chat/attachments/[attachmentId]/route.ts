import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireUser } from '@/domain/auth/guard';
import { withUser } from '@/db/tenant';
import { getObjectStore, ObjectNotFoundError } from '@/domain/documents/object-store';
import { attachmentObjectPrefix, getAttachmentObject } from '@/domain/opschat/attachments';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET — the ORIGINAL file of one of the caller's own Ops Chat attachments. Owner-only: the row is read
 * under the user-scoped RLS policy, so another user's id is indistinguishable from a missing one (404),
 * and the stored key must sit under the caller's own `opschat/{userId}/` prefix (defense in depth).
 * Images (raster only) render inline; every other type is served as a download. `nosniff` (global) +
 * the stored, signature-verified MIME type mean the browser never re-interprets a file as HTML.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ attachmentId: string }> }): Promise<Response> {
  const { attachmentId } = await params;
  let userId: string;
  try {
    userId = (await requireUser()).id;
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 });
  }
  if (!UUID_RE.test(attachmentId)) return Response.json({ error: 'Not found.' }, { status: 404 });

  const row = await withUser({ userId }, (tx) => getAttachmentObject(tx, userId, attachmentId));
  if (!row || !row.objectKey.startsWith(attachmentObjectPrefix(userId))) return Response.json({ error: 'Not found.' }, { status: 404 });

  try {
    const bytes = await (await getObjectStore()).get(row.objectKey);
    const disposition = row.kind === 'image' ? 'inline' : 'attachment';
    const asciiName = row.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
    return new Response(new Uint8Array(bytes), {
      headers: {
        'Content-Type': row.mimeType,
        'Content-Length': String(bytes.byteLength),
        'Content-Disposition': `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err) {
    if (err instanceof ObjectNotFoundError) return Response.json({ error: 'The file is no longer available.' }, { status: 404 });
    log.error('ops-chat attachment download failed', { err });
    return Response.json({ error: 'Something went wrong.' }, { status: 500 });
  }
}
