import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getFolderPath } from '@/domain/documents/documents';
import {
  type CanonicalGroup,
  type PortfolioLens,
  type PortfolioRecord,
  loadDocumentPortfolio,
} from '@/domain/documents/portfolio';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import {
  DocumentRowActions,
  LinkFolderForm,
  RefreshIndexButton,
  UploadForm,
} from './document-forms';

function whenIndexed(at: Date | null): string {
  return at ? new Date(at).toISOString().slice(0, 10) : '—';
}

const GROUP_ORDER: { key: CanonicalGroup; title: string; blurb: string }[] = [
  { key: 'available', title: 'Available', blurb: 'Active sources with a valid current version, eligible for retrieval now.' },
  { key: 'processing', title: 'Processing', blurb: 'Uploaded or indexing; not yet retrievable.' },
  { key: 'unavailable', title: 'Unavailable', blurb: 'No usable current version — disconnected, failed, or unsupported. Identity and evidence are preserved.' },
  { key: 'historical', title: 'Historical', blurb: 'Archived. Removed from current retrieval; versions and evidence retained.' },
];

const LENS_LABEL: Record<PortfolioLens, string> = {
  needs_attention: 'Needs attention',
  restricted: 'Restricted',
  referenced_by_knowledge: 'Referenced by Knowledge',
  supplied_to_ai: 'Supplied to AI operations',
  multiple_versions: 'Multiple versions',
  recently_changed: 'Recently changed',
  integrity_concern: 'Integrity concern',
};

function DocRow({ projectKey, r, isAdmin }: { projectKey: string; r: PortfolioRecord; isAdmin: boolean }) {
  return (
    <tr className="border-b border-[var(--border)] align-top">
      <td className="py-2 pr-4">
        <span className="font-mono text-xs">{r.relativePath}</span>
        {r.classification === 'restricted' ? (
          <span className="ml-2 rounded bg-[#3a2a1f] px-1.5 py-0.5 text-[10px] font-medium uppercase text-[var(--warning,#e0a458)]">Restricted</span>
        ) : null}
        {r.attention.length > 0 ? (
          <ul className="mt-1 space-y-0.5">
            {r.attention.map((a) => (
              <li key={a.code} className="text-[11px] text-[var(--warning,#e0a458)]">⚠ {a.label}</li>
            ))}
          </ul>
        ) : null}
      </td>
      <td className="py-2 pr-4 text-xs">{r.source === 'cloud_upload' ? 'Cloud' : 'Local'}</td>
      <td className="py-2 pr-4 text-xs">{r.stateLabel}</td>
      <td className="py-2 pr-4 text-xs text-[var(--muted)]">{r.fidelityLabel ?? '—'}</td>
      <td className="py-2 pr-4 text-xs text-[var(--muted)]">
        {r.versionCount > 1 ? <span className="mr-2">{r.versionCount} versions</span> : null}
        {r.knowledgeRefCount > 0 ? <span className="mr-2">{r.knowledgeRefCount} Knowledge</span> : null}
        {r.aiOperationCount > 0 ? <span>Supplied to {r.aiOperationCount} AI operation{r.aiOperationCount === 1 ? '' : 's'}</span> : null}
      </td>
      <td className="py-2 pr-4 text-xs text-[var(--muted)]">{whenIndexed(r.indexedAt)}</td>
      {isAdmin ? (
        <td className="py-2">
          <DocumentRowActions projectKey={projectKey} documentId={r.id} source={r.source} actions={r.actions} />
        </td>
      ) : null}
    </tr>
  );
}

function GroupSection({ projectKey, title, blurb, records, isAdmin }: { projectKey: string; title: string; blurb: string; records: PortfolioRecord[]; isAdmin: boolean }) {
  if (records.length === 0) return null;
  return (
    <Card title={`${title} (${records.length})`}>
      <p className="mb-3 text-xs text-[var(--muted)]">{blurb}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[44rem] text-left text-sm">
          <thead>
            <tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
              <th className="py-2 pr-4">Source</th>
              <th className="py-2 pr-4">Adapter</th>
              <th className="py-2 pr-4">State</th>
              <th className="py-2 pr-4">Fidelity</th>
              <th className="py-2 pr-4">References</th>
              <th className="py-2 pr-4">Last indexed</th>
              {isAdmin ? <th className="py-2">Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {records.map((r) => (
              <DocRow key={r.id} projectKey={projectKey} r={r} isAdmin={isAdmin} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default async function DocumentsPage({ params }: { params: Promise<{ projectKey: string }> }) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);

  const { folderPath, view } = await withTenant(ctx, async (tx) => ({
    folderPath: await getFolderPath(tx, ctx),
    view: await loadDocumentPortfolio(tx, ctx),
  }));
  const isAdmin = ctx.projectRole === 'admin';
  const activeLenses = (Object.keys(view.lensCounts) as PortfolioLens[]).filter((l) => view.lensCounts[l] > 0);

  return (
    <div>
      <PageHeader
        title="Documents"
        subtitle="Source material available to this workspace — including what is current, restricted, unavailable, or retained for history. Active, authorized sources may be selected for relevant AI work. This preserves source material; it does not establish that every claim within a source is true."
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card title="Upload document (cloud)">
          {isAdmin ? <UploadForm projectKey={projectKey} /> : <p className="text-sm text-[var(--muted)]">Admins can upload documents.</p>}
        </Card>
        <Card title="Link folder (local)">
          {isAdmin ? (
            <LinkFolderForm projectKey={projectKey} currentPath={folderPath} />
          ) : (
            <p className="text-sm text-[var(--muted)]">{folderPath ?? 'No folder linked.'} (admins can change this)</p>
          )}
        </Card>
        <Card title="Refresh linked folder">
          <p className="mb-3 text-sm text-[var(--muted)]">
            {folderPath
              ? 'Re-read the linked folder from a host that can access this path. Unchanged files are skipped; removed files stop being retrievable; uploaded cloud files index automatically. The cloud-hosted app cannot reach a local machine’s folder on its own.'
              : 'Link a folder first, then refresh it from a host that can access the path. (Uploaded cloud files index automatically.)'}
          </p>
          {isAdmin && folderPath ? <RefreshIndexButton projectKey={projectKey} /> : null}
        </Card>
      </div>

      {activeLenses.length > 0 ? (
        <div className="mb-6 flex flex-wrap gap-2">
          {activeLenses.map((l) => (
            <span key={l} className="rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)]">
              {LENS_LABEL[l]} · {view.lensCounts[l]}
            </span>
          ))}
        </div>
      ) : null}

      {view.total === 0 ? (
        <Card title="Documents">
          <EmptyState>{folderPath ? 'Nothing indexed yet — upload a file or refresh the linked folder.' : 'No documents yet. Upload a file or link a folder to get started.'}</EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          {GROUP_ORDER.map((g) => (
            <GroupSection key={g.key} projectKey={projectKey} title={g.title} blurb={g.blurb} records={view.groups[g.key]} isAdmin={isAdmin} />
          ))}
        </div>
      )}
    </div>
  );
}
