import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getObjectStore } from '@/domain/documents/object-store';
import { loadDocumentDetail } from '@/domain/documents/detail';
import { loadInspectableVersion } from '@/domain/documents/viewer-access';
import { loadLivePurgeOperation } from '@/domain/documents/purge';
import { Card, PageHeader } from '@/components/ui';
import {
  AiOperationsSection,
  ClassBadge,
  HistorySection,
  KnowledgeSection,
  SelectedPanel,
  Technical,
  VersionHistoryTable,
  shortId,
} from './detail-view';
import { RevealRestricted } from './reveal-restricted';
import { DetailLifecycleActions } from './detail-lifecycle-actions';
import { IntegrityAudit } from './integrity-audit';
import { PurgeControl } from './purge-control';

// Sensitive per-viewer content: always render fresh + per request, never statically or cross-user cached.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export default async function DocumentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string; documentId: string }>;
  searchParams: Promise<{ version?: string }>;
}) {
  const { projectKey, documentId } = await params;
  const { version } = await searchParams;
  const ctx = await requireTenant(projectKey);
  const store = await getObjectStore();

  // A GET render loads METADATA always, and auto-releases content ONLY for NON-restricted sources (which
  // records nothing). Restricted content is NEVER released on GET — not on render, refresh, prefetch, or a
  // shared/replayed URL. Its release is a deliberate POST server action (see RevealRestricted), so a page
  // view can never forge a restricted-inspection record.
  const { detail, inspection, livePurge } = await withTenant(ctx, async (tx) => {
    const detail = await loadDocumentDetail(tx, ctx, documentId, version);
    // Admins see any live purge operation (quarantine window / in-progress) for this document.
    const livePurge = ctx.projectRole === 'admin' ? await loadLivePurgeOperation(tx, ctx, documentId) : null;
    if (!detail.found || detail.restricted || detail.selected.resolution !== 'selected' || !detail.selected.versionId) {
      return { detail, inspection: null, livePurge };
    }
    const inspection = await loadInspectableVersion(tx, ctx, store, { kind: 'versionId', versionId: detail.selected.versionId }, { accessType: 'preview', purpose: 'documents detail preview' });
    return { detail, inspection, livePurge };
  });
  const purgeRetentionElapsed = !!livePurge?.retentionUntil && Date.parse(livePurge.retentionUntil) <= Date.now();

  const back = (
    <div className="mb-3">
      <Link href={`/p/${projectKey}/documents`} className="text-sm text-[var(--muted)] hover:underline">← Documents</Link>
    </div>
  );

  if (!detail.found) {
    // Existence-neutral: reveals neither the source's existence nor any metadata.
    return (
      <div>
        {back}
        <Card title="Source unavailable"><p className="text-sm text-[var(--muted)]">This source is not available to your account.</p></Card>
      </div>
    );
  }

  const selectedVersion = detail.selected.version;
  // Only released preview TEXT reaches the view — never raw byte buffers (bytes stay server-side and are
  // released solely by the gated download route).
  const previewText = inspection?.inspection?.chunks ? inspection.inspection.chunks.map((c) => c.content).join('\n\n') : null;
  const qualification = inspection?.inspection?.qualification ?? null;
  const downloadBase = detail.selected.versionId ? `/p/${projectKey}/documents/${documentId}/download?version=${detail.selected.versionId}` : null;
  // The inline (non-restricted) preview shows a download link only for an actually-downloadable release.
  const previewDownloadHref = inspection?.state === 'released' && inspection.inspection?.downloadable ? downloadBase : null;
  // Restricted + a resolved selection → the explicit POST release control (no GET release path exists).
  const revealSlot =
    detail.restricted && detail.selected.resolution === 'selected' && detail.selected.versionId && downloadBase
      ? <RevealRestricted projectKey={projectKey} documentId={documentId} versionId={detail.selected.versionId} downloadHref={downloadBase} />
      : null;

  return (
    <div>
      {back}
      <PageHeader title={detail.identity.relativePath} subtitle="One source — its current state, the exact version you are inspecting, who may access it, what relies on it." />

      <div className="space-y-4">
        <Card title="1. Source identity">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span>{detail.identity.source === 'cloud_upload' ? 'Cloud upload' : 'Local folder'}</span>
            <span className="text-[var(--muted)]">·</span>
            <span>{detail.identity.stateLabel}</span>
            <span>Classification: {detail.identity.classification}<ClassBadge c={detail.identity.classification} /></span>
            {!detail.identity.sourceConnected ? <span className="text-[var(--warning,#e0a458)]">source disconnected</span> : null}
          </div>
          {detail.restricted && detail.viewerCanInspectRestricted ? (
            <p className="mt-2 text-xs text-[var(--warning,#e0a458)]">This is a restricted source; revealing or downloading its content is recorded.</p>
          ) : null}
          {detail.attention.length > 0 ? (
            <ul className="mt-2 space-y-0.5">{detail.attention.map((a) => <li key={a.code} className="text-xs text-[var(--warning,#e0a458)]">⚠ {a.label}</li>)}</ul>
          ) : null}
          <Technical label="Technical identifiers">
            <div>Document id: <span className="font-mono break-all">{detail.identity.documentId}</span></div>
          </Technical>
        </Card>

        <Card title="2. Current version">
          {detail.current.versionId ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span>{detail.current.fidelityLabel}</span>
              <span className="text-[var(--muted)]">index: {detail.current.indexStatus}</span>
              {detail.current.newerVersion ? <span className="text-[var(--warning,#e0a458)]">a newer version is {detail.current.newerVersion}; retrieval continues on the current version</span> : null}
            </div>
          ) : (
            <p className="text-sm text-[var(--muted)]">This source has no usable current version.</p>
          )}
          <Technical label="Version context (current vs latest)">
            <div>Current: {shortId(detail.current.versionId)}</div>
            <div>Latest observed: {shortId(detail.current.latestObservedVersionId)}</div>
            <div>Latest successful: {shortId(detail.current.latestSuccessfulVersionId)}</div>
            <div>Present policy governs access: {detail.classification.effectivePresentDisclosure}; version snapshot: {detail.classification.versionDisclosureSnapshot}</div>
          </Technical>
        </Card>

        <SelectedPanel
          detail={detail}
          selectedVersion={selectedVersion}
          inspectionState={inspection?.state ?? null}
          previewText={previewText}
          qualification={qualification}
          downloadHref={previewDownloadHref}
          revealSlot={revealSlot}
        />

        <Card title="3. Version history"><VersionHistoryTable detail={detail} projectKey={projectKey} documentId={documentId} /></Card>
        <Card title="6. Knowledge relationships"><KnowledgeSection refs={detail.knowledge} /></Card>
        <Card title={`7. AI operations (${detail.aiOperationCount})`}><AiOperationsSection ops={detail.aiOperations} /></Card>
        <Card title="9. Lifecycle history"><HistorySection events={detail.history} /></Card>

        {ctx.projectRole === 'admin' ? (
          <Card title="Integrity">
            <p className="mb-3 text-xs text-[var(--muted)]">A deliberate, read-only structural audit — it observes and reports, and changes nothing. Repair, cleanup, and purge are separate capabilities, not offered here.</p>
            <div className="mb-3 rounded border border-[var(--border)] p-3">
              <div className="mb-1 text-xs font-medium uppercase text-[var(--muted)]">Recorded state</div>
              <ul className="space-y-0.5 text-xs">
                {detail.versions.map((v) => (
                  <li key={v.id}>
                    version {shortId(v.id)}{v.isCurrent ? ' (current)' : ''} · {v.fidelityLabel} · index {v.indexStatus}
                    {v.integrity.degraded ? <span className="text-[var(--warning,#e0a458)]"> · index degraded</span> : null}
                    {v.integrity.byteExactMissingObject ? <span className="text-[var(--warning,#e0a458)]"> · retained object missing</span> : null}
                  </li>
                ))}
              </ul>
            </div>
            <IntegrityAudit projectKey={projectKey} documentId={documentId} />
          </Card>
        ) : null}

        {detail.actions.restrict || detail.actions.declassify || detail.actions.archive || detail.actions.restore || detail.actions.retry || detail.actions.replace ? (
          <Card title="Safe actions">
            <p className="mb-3 text-xs text-[var(--muted)]">Lifecycle and classification actions. Each is re-checked and audited on the server. Purge, integrity repair, and evidence deletion are not available here.</p>
            <DetailLifecycleActions projectKey={projectKey} documentId={documentId} actions={detail.actions} />
          </Card>
        ) : null}

        {ctx.projectRole === 'admin' ? (
          <Card title="Purge">
            <p className="mb-3 text-xs text-[var(--muted)]">A deliberate, irreversible removal of this document and its retained representations — separate from the safe actions above. Admin-authorized, one document at a time, with a retention window and a hard block while any evidence relies on it.</p>
            <PurgeControl projectKey={projectKey} documentId={documentId} live={livePurge} retentionElapsed={purgeRetentionElapsed} />
          </Card>
        ) : null}
      </div>
    </div>
  );
}
