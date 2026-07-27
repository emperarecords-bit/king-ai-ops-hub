import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getObjectStore } from '@/domain/documents/object-store';
import { loadDetailWithInspection } from '@/domain/documents/detail';

/**
 * Exact-bytes download for a Document version — read-only (P2). Authorization is enforced ENTIRELY through
 * the gated inspection path (`loadDetailWithInspection` → `loadInspectableVersion`): it re-checks membership
 * and the current disclosure, resolves the EXACT selected version (never a fall-back to another version's
 * content), audits an actual restricted release, and yields bytes only for a downloadable (`byte_exact`)
 * version. A denied, missing, foreign, cross-workspace, unavailable, or non-downloadable request returns the
 * same bounded, existence-neutral 404 — no metadata is leaked and the current version is never substituted.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ projectKey: string; documentId: string }> },
): Promise<Response> {
  const { projectKey, documentId } = await params;
  const version = new URL(req.url).searchParams.get('version') ?? undefined;
  const ctx = await requireTenant(projectKey);

  const store = await getObjectStore();
  const notAvailable = () => new Response('This source is not available to your account.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });

  const { detail, inspection } = await withTenant(ctx, (tx) =>
    loadDetailWithInspection(tx, ctx, store, documentId, version, { accessType: 'download', purpose: 'documents detail download' }),
  );
  if (!detail.found) return notAvailable();
  if (!inspection || inspection.state !== 'released' || !inspection.inspection?.downloadable || !inspection.inspection.bytes) {
    return notAvailable();
  }

  const bytes = inspection.inspection.bytes;
  const base = detail.identity.relativePath.split('/').pop() || 'source';
  // Quote-safe filename (ASCII fallback); the content is the exact retained, hash-verified source bytes.
  const safe = base.replace(/[^\w.\-]+/g, '_');
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
