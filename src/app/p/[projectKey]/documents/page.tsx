import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getFolderPath, listDocuments } from '@/domain/documents/documents';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import {
  DocumentRowActions,
  LinkFolderForm,
  RefreshIndexButton,
  UploadForm,
} from './document-forms';

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function whenIndexed(at: Date | null): string {
  if (!at) return '—';
  return new Date(at).toISOString().slice(0, 10);
}

export default async function DocumentsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);

  const { folderPath, docs } = await withTenant(ctx, async (tx) => ({
    folderPath: await getFolderPath(tx, ctx),
    docs: await listDocuments(tx, ctx),
  }));

  const active = docs.filter((d) => d.status === 'active');
  const other = docs.filter((d) => d.status !== 'active');
  const isAdmin = ctx.projectRole === 'admin';

  return (
    <div>
      <PageHeader
        title="Project Library"
        subtitle="Business documents your employees retrieve automatically for each task — you never paste the same context twice. Upload files directly (works from a phone, no local machine needed) or link a local folder. Markdown and text today; PDF and Word next. Retrieval stays inside this workspace."
      />

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Card title="Upload files (cloud)">
          {isAdmin ? (
            <UploadForm projectKey={projectKey} />
          ) : (
            <p className="text-sm text-[var(--muted)]">Admins can upload documents.</p>
          )}
        </Card>
        <Card title="Linked folder (local)">
          {isAdmin ? (
            <LinkFolderForm projectKey={projectKey} currentPath={folderPath} />
          ) : (
            <p className="text-sm text-[var(--muted)]">
              {folderPath ?? 'No folder linked.'} (admins can change this)
            </p>
          )}
        </Card>
        <Card title="Index local folder">
          <p className="mb-3 text-sm text-[var(--muted)]">
            {folderPath
              ? 'Re-read the folder whenever files change. Unchanged files are skipped; removed files stop being retrievable. Uploaded files are indexed automatically.'
              : 'Link a folder first, then index it. (Uploaded files index automatically.)'}
          </p>
          {isAdmin && folderPath ? <RefreshIndexButton projectKey={projectKey} /> : null}
        </Card>
      </div>

      <Card title={`Indexed documents (${active.length})`}>
        {docs.length === 0 ? (
          <EmptyState>
            {folderPath
              ? 'Nothing indexed yet — click Refresh index.'
              : 'No documents. Link a folder to get started.'}
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
                  <th className="py-2 pr-4">File</th>
                  <th className="py-2 pr-4">Source</th>
                  <th className="py-2 pr-4">Size</th>
                  <th className="py-2 pr-4">Last indexed</th>
                  <th className="py-2 pr-4">Status</th>
                  {isAdmin ? <th className="py-2">Actions</th> : null}
                </tr>
              </thead>
              <tbody>
                {[...active, ...other].map((d) => (
                  <tr key={d.id} className="border-b border-[var(--border)] align-top">
                    <td className="py-2 pr-4 font-mono text-xs">
                      {d.relativePath}
                      {d.errorMessage ? (
                        <span className="mt-1 block font-sans text-xs text-[var(--danger)]">{d.errorMessage}</span>
                      ) : null}
                    </td>
                    <td className="py-2 pr-4 text-xs">
                      {d.source === 'cloud_upload' ? 'Cloud' : 'Local'}
                    </td>
                    <td className="py-2 pr-4">{kb(d.sizeBytes)}</td>
                    <td className="py-2 pr-4 text-xs text-[var(--muted)]">{whenIndexed(d.indexedAt)}</td>
                    <td className="py-2 pr-4">
                      <StatusBadge status={d.status} />
                    </td>
                    {isAdmin ? (
                      <td className="py-2">
                        <DocumentRowActions
                          projectKey={projectKey}
                          documentId={d.id}
                          status={d.status}
                          source={d.source}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
