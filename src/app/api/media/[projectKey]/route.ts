import { type NextRequest, NextResponse } from 'next/server';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { writeAudit } from '@/domain/audit/audit';
import { getObjectStore } from '@/domain/documents/object-store';
import { maxMediaBytes, putWorkspaceMedia } from '@/domain/media/media';
import { AppError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';

/**
 * Screening Room upload: a route handler (not a server action) so large video files are not
 * subject to the server-action body ceiling. Admin-only; every upload is audited.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ projectKey: string }> },
): Promise<Response> {
  const { projectKey } = await params;
  try {
    const ctx = await requireTenant(projectKey);
    if (ctx.projectRole !== 'admin') {
      return NextResponse.json({ error: 'Only workspace admins can upload media.' }, { status: 403 });
    }
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: 'Choose a file to upload.' }, { status: 400 });
    }
    if (file.size > maxMediaBytes()) {
      return NextResponse.json({ error: `File too large (max ${Math.floor(maxMediaBytes() / 1_000_000)} MB).` }, { status: 413 });
    }
    const store = await getObjectStore();
    const bytes = Buffer.from(await file.arrayBuffer());
    const saved = await putWorkspaceMedia(store, ctx, file.name, bytes);
    await withTenant(ctx, (tx) =>
      writeAudit(tx, ctx, {
        action: 'media.uploaded',
        entityType: 'media',
        entityId: null,
        detail: { name: saved.name, sizeBytes: bytes.length },
      }),
    );
    return NextResponse.json({ ok: true, name: saved.name });
  } catch (err) {
    if (!(err instanceof AppError)) log.error('media upload failed', { err });
    return NextResponse.json({ error: toPublicMessage(err) }, { status: 400 });
  }
}
