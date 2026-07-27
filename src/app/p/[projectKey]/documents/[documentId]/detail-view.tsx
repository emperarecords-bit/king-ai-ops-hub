import Link from 'next/link';
import {
  type DetailKnowledgeRef,
  type DetailLifecycleEvent,
  type DetailRunRef,
  type DetailVersion,
  type DocumentDetail,
} from '@/domain/documents/detail';
import { Card } from '@/components/ui';

/**
 * Documents Detail — presentational (server-only, no client boundary, no mutations). Pure functions of the
 * shared Detail view model, extracted so the read-only rendering behavior is directly testable. No raw
 * bytes ever reach here: content is rendered only from released preview TEXT; downloads go through the gated
 * server route. Restricted content is never released on render — the page passes a reveal link instead, so
 * merely rendering or prefetching the page records no restricted inspection.
 */

export function fmt(d: Date | null | undefined): string {
  return d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '—';
}
export function shortId(s: string | null): string {
  return s ? `${s.slice(0, 8)}…` : '—';
}

export const KNOWLEDGE_STATE_LABEL: Record<DetailKnowledgeRef['relationshipState'], string> = {
  relied_upon: 'Relied upon',
  attached_not_judged: 'Attached source; support not judged',
  supplemental: 'Supplemental',
};

export function ClassBadge({ c }: { c: string }) {
  const restricted = c === 'restricted';
  return (
    <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${restricted ? 'bg-[#3a2a1f] text-[var(--warning,#e0a458)]' : 'border border-[var(--border)] text-[var(--muted)]'}`}>
      {restricted ? 'Restricted' : 'Internal'}
    </span>
  );
}

/** A read-only technical drawer — kept behind progressive disclosure so the primary page stays legible. */
export function Technical({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <details className="mt-2 rounded border border-[var(--border)] px-3 py-2">
      <summary className="cursor-pointer text-xs text-[var(--muted)]">{label}</summary>
      <div className="mt-2 space-y-1 text-xs text-[var(--muted)]">{children}</div>
    </details>
  );
}

export function SelectedPanel({
  detail,
  selectedVersion,
  inspectionState,
  previewText,
  qualification,
  downloadHref,
  revealSlot,
}: {
  detail: DocumentDetail;
  selectedVersion: DetailVersion | null;
  inspectionState: string | null;
  previewText: string | null;
  qualification: string | null;
  downloadHref: string | null;
  /** When set, the selected version is restricted and NOT yet released — render the explicit release
   *  control (a POST server action) instead of content. Rendering/refresh/prefetch never releases. */
  revealSlot: React.ReactNode | null;
}) {
  const sel = detail.selected;
  const historical = sel.versionId != null && !sel.isCurrent;
  if (sel.resolution !== 'selected' || !selectedVersion) {
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

      {revealSlot ? (
        revealSlot
      ) : inspectionState === 'released' && previewText != null ? (
        <>
          {qualification ? <p className="mb-2 rounded bg-[#3a2a1f] px-3 py-2 text-xs text-[var(--warning,#e0a458)]">{qualification}</p> : null}
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--background)] p-3 text-xs">{previewText}</pre>
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
        <div>Version hash: <span className="font-mono break-all">{selectedVersion.versionHash ?? '—'}</span></div>
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

export function KnowledgeSection({ refs }: { refs: DetailKnowledgeRef[] }) {
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

export function AiOperationsSection({ ops }: { ops: DetailRunRef[] }) {
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

export function HistorySection({ events }: { events: DetailLifecycleEvent[] }) {
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

export function VersionHistoryTable({ detail, projectKey, documentId }: { detail: DocumentDetail; projectKey: string; documentId: string }) {
  return (
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
                <td className="py-1 text-xs">{isSel ? <span className="text-[var(--muted)]">inspecting</span> : <Link href={href} prefetch={false} className="hover:underline">Inspect</Link>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
