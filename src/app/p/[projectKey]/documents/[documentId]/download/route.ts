import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getObjectStore } from '@/domain/documents/object-store';
import { loadDocumentDetail } from '@/domain/documents/detail';
import { loadInspectableVersion } from '@/domain/documents/viewer-access';

export const dynamic = 'force-dynamic';

/**
 * Exact-bytes download for a Document version (read-only, P2).
 *
 * Restricted content is NEVER released through a replayable GET. A GET may release only NON-restricted
 * byte-exact content (the intended product policy for shareable authorized links); for a restricted source
 * a GET refuses BEFORE any release or audit. Restricted bytes are released only by a deliberate, origin-
 * validated POST (the download form the UI shows after an explicit reveal). Either method reauthorizes the
 * workspace, resolves the EXACT selected version (belongs-to-document + workspace; never a fall-back to
 * current), releases only through the gated `loadInspectableVersion` (which records the restricted-inspection
 * audit only on a successful release), and returns the same bounded, existence-neutral 404 for a denied,
 * missing, foreign, cross-workspace, unavailable, or non-downloadable request.
 */

/** A GET must not release restricted content; a POST (deliberate, origin-checked) may. */
export function mayRelease(method: 'GET' | 'POST', restricted: boolean): boolean {
  return method === 'POST' || !restricted;
}

/** Same-origin guard for the state-releasing POST (route handlers get no built-in CSRF protection). */
function sameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  if (!origin) return false; // a deliberate in-app form POST always carries an Origin
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  return !!host && o.host === host;
}

async function handle(req: Request, params: Promise<{ projectKey: string; documentId: string }>, method: 'GET' | 'POST'): Promise<Response> {
  const { projectKey, documentId } = await params;
  const version = new URL(req.url).searchParams.get('version') ?? undefined;
  const ctx = await requireTenant(projectKey);
  const store = await getObjectStore();
  const notAvailable = () => new Response('This source is not available to your account.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, no-store' } });

  const { detail, inspection } = await withTenant(ctx, async (tx) => {
    const detail = await loadDocumentDetail(tx, ctx, documentId, version);
    if (!detail.found || detail.selected.resolution !== 'selected' || !detail.selected.versionId) return { detail, inspection: null };
    // Refuse a restricted release over GET BEFORE any release or audit — bytes and audit happen only on POST.
    if (!mayRelease(method, detail.restricted)) return { detail, inspection: null };
    const inspection = await loadInspectableVersion(tx, ctx, store, { kind: 'versionId', versionId: detail.selected.versionId }, { accessType: 'download', purpose: 'documents detail download' });
    return { detail, inspection };
  });

  if (!detail.found) return notAvailable();
  if (!inspection || inspection.state !== 'released' || !inspection.inspection?.downloadable || !inspection.inspection.bytes) return notAvailable();

  const bytes = inspection.inspection.bytes;
  const base = detail.identity.relativePath.split('/').pop() || 'source';
  const safe = base.replace(/[^\w.\-]+/g, '_'); // ASCII-safe Content-Disposition filename
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      'content-type': inspection.inspection.mimeType ?? 'application/octet-stream',
      'content-disposition': `attachment; filename="${safe}"`,
      'content-length': String(bytes.length),
      'cache-control': 'private, no-store',
    },
  });
}

export async function GET(req: Request, { params }: { params: Promise<{ projectKey: string; documentId: string }> }): Promise<Response> {
  return handle(req, params, 'GET');
}

export async function POST(req: Request, { params }: { params: Promise<{ projectKey: string; documentId: string }> }): Promise<Response> {
  // A cross-site POST cannot forge a deliberate restricted release.
  if (!sameOrigin(req)) return new Response('Forbidden', { status: 403, headers: { 'cache-control': 'private, no-store' } });
  return handle(req, params, 'POST');
}
