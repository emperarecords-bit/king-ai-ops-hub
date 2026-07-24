import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getFolderPath, listDocuments } from '@/domain/documents/documents';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { LinkFolderForm, RefreshIndexButton } from './document-forms';

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
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
        title="Project folder"
        subtitle="Link a local folder of business documents. Employees automatically retrieve the most relevant ones for each task — you never paste the same context twice. Markdown and text today; PDF and Word next. Retrieval stays inside this workspace."
      />

      <div className="mb-6 grid gap-4 md:grid-cols-2">
        <Card title="Linked folder">
          {isAdmin ? (
            <LinkFolderForm projectKey={projectKey} currentPath={folderPath} />
          ) : (
            <p className="text-sm text-[var(--muted)]">
              {folderPath ?? 'No folder linked.'} (admins can change this)
            </p>
          )}
        </Card>
        <Card title="Index">
          <p className="mb-3 text-sm text-[var(--muted)]">
            {folderPath
              ? 'Re-read the folder whenever files change. Unchanged files are skipped; removed files stop being retrievable.'
              : 'Link a folder first, then index it.'}
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
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
                <th className="py-2 pr-4">File</th>
                <th className="py-2 pr-4">Type</th>
                <th className="py-2 pr-4">Chunks</th>
                <th className="py-2 pr-4">Size</th>
                <th className="py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {[...active, ...other].map((d) => (
                <tr key={d.id} className="border-b border-[var(--border)]">
                  <td className="py-2 pr-4 font-mono text-xs">{d.relativePath}</td>
                  <td className="py-2 pr-4">{d.kind}</td>
                  <td className="py-2 pr-4">{d.chunkCount}</td>
                  <td className="py-2 pr-4">{kb(d.sizeBytes)}</td>
                  <td className="py-2">
                    <StatusBadge status={d.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
