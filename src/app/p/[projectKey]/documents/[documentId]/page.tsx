import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getObjectStore } from '@/domain/documents/object-store';
import { loadDocumentDetail } from '@/domain/documents/detail';
import { loadInspectableVersion } from '@/domain/documents/viewer-access';
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

// Sensitive per-viewer content: always render fresh + per request, never statically or cross-user cached.
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

export default async function DocumentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string; documentId: string }>;
  searchParams: Promise<{ version?: string; reveal?: string }>;
}) {
  const { projectKey, documentId } = await params;
  const { version, reveal } = await searchParams;
  const ctx = await requireTenant(projectKey);
  const store = await getObjectStore();

  // Load METADATA always (no content release, no audit). Release the selected version's content ONLY when
  // it is safe to auto-show (non-restricted) OR the viewer explicitly asked to reveal restricted content —
  // so merely rendering or prefetching this page never records a restricted inspection.
  const { detail, inspection } = await withTenant(ctx, async (tx) => {
    const detail = await loadDocumentDetail(tx, ctx, documentId, version);
    if (!detail.found || detail.selected.resolution !== 'selected' || !detail.selected.versionId) {
      return { detail, inspection: null };
    }
    const mayRelease = !detail.restricted || reveal === '1';
    const inspection = mayRelease
      ? await loadInspectableVersion(tx, ctx, store, { kind: 'versionId', versionId: detail.selected.versionId }, { accessType: 'preview', purpose: 'documents detail preview' })
      : null;
    return { detail, inspection };
  });

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
  const downloadHref =
    inspection?.state === 'released' && inspection.inspection?.downloadable && detail.selected.versionId
      ? `/p/${projectKey}/documents/${documentId}/download?version=${detail.selected.versionId}`
      : null;
  const revealHref =
    detail.restricted && reveal !== '1' && detail.selected.resolution === 'selected' && detail.selected.versionId
      ? (detail.selected.isCurrent ? `/p/${projectKey}/documents/${documentId}?reveal=1` : `/p/${projectKey}/documents/${documentId}?version=${detail.selected.versionId}&reveal=1`)
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
          downloadHref={downloadHref}
          revealHref={revealHref}
        />

        <Card title="3. Version history"><VersionHistoryTable detail={detail} projectKey={projectKey} documentId={documentId} /></Card>
        <Card title="6. Knowledge relationships"><KnowledgeSection refs={detail.knowledge} /></Card>
        <Card title={`7. AI operations (${detail.aiOperationCount})`}><AiOperationsSection ops={detail.aiOperations} /></Card>
        <Card title="9. Lifecycle history"><HistorySection events={detail.history} /></Card>
      </div>
    </div>
  );
}
