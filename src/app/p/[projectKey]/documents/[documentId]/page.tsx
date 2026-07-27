import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getObjectStore } from '@/domain/documents/object-store';
import {
  type DetailKnowledgeRef,
  type DetailLifecycleEvent,
  type DetailRunRef,
  type DetailVersion,
  type DocumentDetail,
  loadDetailWithInspection,
} from '@/domain/documents/detail';
import { Card, PageHeader } from '@/components/ui';

export const dynamic = 'force-dynamic';

function fmt(d: Date | null | undefined): string {
  return d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
}
function shortId(s: string | null): string {
  return s ? `${s.slice(0, 8)}…` : '—';
}

const KNOWLEDGE_STATE_LABEL: Record<DetailKnowledgeRef['relationshipState'], string> = {
  relied_upon: 'Relied upon',
  attached_not_judged: 'Attached source; support not judged',
  supplemental: 'Supplemental',
};

function ClassBadge({ c }: { c: string }) {
  const restricted = c === 'restricted';
  return (
    <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${restricted ? 'bg-[#3a2a1f] text-[var(--warning,#e0a458)]' : 'border border-[var(--border)] text-[var(--muted)]'}`}>
      {restricted ? 'Restricted' : 'Internal'}
    </span>
  );
}

/** A read-only technical drawer — kept behind progressive disclosure so the primary page stays legible. */
function Technical({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="mt-2 rounded border border-[var(--border)] px-3 py-2">
      <summary className="cursor-pointer text-xs text-[var(--muted)]">{label}</summary>
      <div className="mt-2 space-y-1 text-xs text-[var(--muted)]">{children}</div>
    </details>
  );
}

function SelectedPanel({
  detail,
  selectedVersion,
  inspectionState,
  previewText,
  qualification,
  downloadHref,
}: {
  detail: DocumentDetail;
  selectedVersion: DetailVersion | null;
  inspectionState: string | null;
  previewText: string | null;
  qualification: string | null;
  downloadHref: string | null;
}) {
  const sel = detail.selected;
  const historical = sel.versionId != null && !sel.isCurrent;
  if (sel.resolution !== 'selected' || !selectedVersion) {
    // A selection that did not resolve to a version of THIS Document — bounded, never a fall-back to current.
    const msg =
      sel.resolution === 'missing' ? 'That exact version is not available in this workspace.'
      : sel.resolution === 'version_mismatch' ? 'That reference does not identify this exact version.'
      : sel.resolution === 'unsupported' ? 'That version reference cannot be inspected.'
      : 'No version is selected.';
    return <Card title="Selected version"><p className="text-sm text-[var(--muted)]">{msg} The current version is unaffected.</p></Card>;
  }
  return (
    <Card title="Selected version">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-sm">
        <span className={`rounded px-2 py-0.5 text-xs font-medium ${historical ? 'bg-[#2a2f3a] text-[var(--muted)]' : 'bg-[#1f3a2a] text-[var(--success)]'}`}>
          {historical ? 'Historical version' : 'Current version'}
        </span>
        <span className="text-[var(--muted)]">v{selectedVersion.ordinal}</span>
        <span>{selectedVersion.fidelityLabel}</span>
        <span className="text-[var(--muted)]">index: {selectedVersion.indexStatus}</span>
        {selectedVersion.indexDegraded ? <span className="text-[var(--warning,#e0a458)]">⚠ index degraded</span> : null}
        {selectedVersion.tombstoned ? <span className="text-[var(--danger)]">purged</span> : null}
      </div>
      {historical ? (
        <p className="mb-2 text-xs text-[var(--muted)]">You are inspecting a historical version. The Document’s current version and lifecycle state remain shown above.</p>
      ) : null}

      {inspectionState === 'released' && previewText != null ? (
        <>
          {qualification ? <p className="mb-2 rounded bg-[#3a2a1f] px-3 py-2 text-xs text-[var(--warning,#e0a458)]">{qualification}</p> : null}
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded bg-[var(--background)] p-3 text-xs">{previewText}</pre>
          {downloadHref ? (
            <a href={downloadHref} className="mt-2 inline-block rounded-md border border-[var(--border)] px-3 py-1 text-xs font-medium hover:border-[var(--accent)]">Download exact source</a>
          ) : (
            <p className="mt-2 text-xs text-[var(--muted)]">Reconstructed indexed text — the original bytes were not retained, so there is no exact download.</p>
          )}
        </>
      ) : inspectionState === 'unavailable' ? (
        <p className="rounded bg-[var(--background)] px-3 py-2 text-sm text-[var(--muted)]">Source content is unavailable for this version — its identity is preserved, but no exact or reconstructed evidence remains. No preview or download is offered.</p>
      ) : inspectionState === 'integrity_failure' ? (
        <p className="rounded bg-[#3a2026] px-3 py-2 text-sm text-[var(--danger)]">This version’s retained content failed integrity verification. No content is released.</p>
      ) : (
        <p className="text-sm text-[var(--muted)]">No content is available to preview for this version.</p>
      )}

      <Technical label="Technical identity & provenance">
        <div>Version hash: <span className="font-mono">{selectedVersion.versionHash ?? '—'}</span></div>
        <div>Source-changed: {fmt(selectedVersion.sourceChangeAt)} · ingested: {fmt(selectedVersion.ingestedAt)}</div>
        <div>Row created (technical): {fmt(selectedVersion.createdAt)} — not a source-change time</div>
        <div>Classification at ingest: {selectedVersion.disclosureSnapshot}</div>
        {selectedVersion.integrity.degraded || selectedVersion.integrity.byteExactMissingObject ? (
          <div className="text-[var(--warning,#e0a458)]">Integrity: {selectedVersion.integrity.degraded ? 'index degraded ' : ''}{selectedVersion.integrity.byteExactMissingObject ? 'retained object missing' : ''}</div>
        ) : null}
      </Technical>
    </Card>
  );
}

function KnowledgeSection({ refs }: { refs: DetailKnowledgeRef[] }) {
  if (refs.length === 0) return <p className="text-sm text-[var(--muted)]">No Knowledge item cites this source.</p>;
  return (
    <ul className="space-y-2">
      {refs.map((k) => (
        <li key={k.knowledgeSourceId} className="text-sm">
          <span className="font-medium">{k.knowledgeItemTitle}</span>
          <span className="ml-2 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--muted)]">{KNOWLEDGE_STATE_LABEL[k.relationshipState]}</span>
          <span className="ml-2 text-xs text-[var(--muted)]">role: {k.role}{k.documentVersionId ? ' · bound to an exact version' : ' · no bound version'}{k.currentlyInspectable ? '' : ' · not currently inspectable'}</span>
        </li>
      ))}
    </ul>
  );
}

function AiOperationsSection({ ops }: { ops: DetailRunRef[] }) {
  if (ops.length === 0) return <p className="text-sm text-[var(--muted)]">This source has not been supplied to any AI operation.</p>;
  return (
    <ul className="space-y-2">
      {ops.map((o) => {
        const chunks = o.suppliedVersions.reduce((n, v) => n + v.suppliedChunkCount, 0);
        return (
          <li key={o.runId} className="text-sm">
            Supplied to an AI operation ({o.runStatus}) · dispatched {fmt(o.dispatchAt)}
            <span className="ml-2 text-xs text-[var(--muted)]">provider: {o.provider ?? 'Not recorded'} · model: {o.model ?? 'Not recorded'} · {chunks} chunk{chunks === 1 ? '' : 's'} supplied</span>
            <Technical label="Dispatch detail">
              {o.suppliedVersions.map((v) => (
                <div key={v.documentVersionId}>version {shortId(v.documentVersionId)} · hash {v.versionHash ? v.versionHash.slice(0, 12) : '—'} · disclosure at dispatch: {v.dispatchDisclosureSnapshot}</div>
              ))}
            </Technical>
          </li>
        );
      })}
    </ul>
  );
}

function HistorySection({ events }: { events: DetailLifecycleEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-[var(--muted)]">No lifecycle events recorded.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {events.map((e, i) => (
        <li key={`${e.kind}-${i}`} className="flex flex-wrap items-baseline gap-2">
          <span className="font-medium">{e.kind.replaceAll('_', ' ')}</span>
          <span className="text-xs text-[var(--muted)]">{fmt(e.at)}{e.documentVersionId ? ` · version ${shortId(e.documentVersionId)}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

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
  const { detail, inspection } = await withTenant(ctx, (tx) =>
    loadDetailWithInspection(tx, ctx, store, documentId, version, { accessType: 'preview', purpose: 'documents detail preview' }),
  );

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
  const previewText = inspection?.inspection?.chunks ? inspection.inspection.chunks.map((c) => c.content).join('\n\n') : null;
  const qualification = inspection?.inspection?.qualification ?? null;
  const downloadHref =
    inspection?.state === 'released' && inspection.inspection?.downloadable && detail.selected.versionId
      ? `/p/${projectKey}/documents/${documentId}/download?version=${detail.selected.versionId}`
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
            <p className="mt-2 text-xs text-[var(--warning,#e0a458)]">This is a restricted source; your inspection of its content is recorded.</p>
          ) : null}
          {detail.attention.length > 0 ? (
            <ul className="mt-2 space-y-0.5">{detail.attention.map((a) => <li key={a.code} className="text-xs text-[var(--warning,#e0a458)]">⚠ {a.label}</li>)}</ul>
          ) : null}
          <Technical label="Technical identifiers">
            <div>Document id: <span className="font-mono">{detail.identity.documentId}</span></div>
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
        />

        <Card title="3. Version history">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
                  <th className="py-1 pr-3">Version</th><th className="py-1 pr-3">Marker</th><th className="py-1 pr-3">Fidelity</th><th className="py-1 pr-3">Index</th><th className="py-1 pr-3">Source-changed</th><th className="py-1"></th>
                </tr>
              </thead>
              <tbody>
                {[...detail.versions].reverse().map((v) => {
                  const markers = [v.isCurrent ? 'current' : null, v.isLatestSuccessful && !v.isCurrent ? 'latest ok' : null, v.newerThanCurrent ? 'newer than current' : null].filter(Boolean).join(', ');
                  const href = v.isCurrent ? `/p/${projectKey}/documents/${documentId}` : `/p/${projectKey}/documents/${documentId}?version=${v.id}`;
                  const isSel = detail.selected.versionId === v.id;
                  return (
                    <tr key={v.id} className="border-b border-[var(--border)]">
                      <td className="py-1 pr-3">v{v.ordinal}</td>
                      <td className="py-1 pr-3 text-xs text-[var(--muted)]">{markers || '—'}</td>
                      <td className="py-1 pr-3 text-xs">{v.fidelityLabel}</td>
                      <td className="py-1 pr-3 text-xs">{v.indexStatus}{v.indexDegraded ? ' ⚠' : ''}</td>
                      <td className="py-1 pr-3 text-xs text-[var(--muted)]">{fmt(v.sourceChangeAt)}</td>
                      <td className="py-1 text-xs">{isSel ? <span className="text-[var(--muted)]">inspecting</span> : <Link href={href} className="hover:underline">Inspect</Link>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="6. Knowledge relationships"><KnowledgeSection refs={detail.knowledge} /></Card>
        <Card title={`7. AI operations (${detail.aiOperationCount})`}><AiOperationsSection ops={detail.aiOperations} /></Card>
        <Card title="9. Lifecycle history"><HistorySection events={detail.history} /></Card>
      </div>
    </div>
  );
}
