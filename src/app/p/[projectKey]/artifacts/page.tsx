import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listArtifacts } from '@/domain/artifacts/artifacts';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export default async function ArtifactsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const artifacts = await withTenant(ctx, (tx) => listArtifacts(tx, ctx));

  return (
    <div>
      <PageHeader
        title="Artifacts"
        subtitle="Files and documents produced by runs in this workspace. Binary storage with signed URLs arrives in Phase 4; text artifacts are stored inline today."
      />
      <Card>
        {artifacts.length === 0 ? (
          <EmptyState>No artifacts yet.</EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Kind</th>
                <th className="py-2 pr-4">Size</th>
                <th className="py-2 pr-4">Task</th>
                <th className="py-2">Created</th>
              </tr>
            </thead>
            <tbody>
              {artifacts.map((a) => (
                <tr key={a.id} className="border-b border-[var(--border)]">
                  <td className="py-2 pr-4 font-medium">{a.name}</td>
                  <td className="py-2 pr-4 font-mono text-xs">{a.kind}</td>
                  <td className="py-2 pr-4 text-[var(--muted)]">{a.sizeBytes} B</td>
                  <td className="py-2 pr-4">
                    {a.taskId ? (
                      <Link
                        href={`/p/${projectKey}/tasks/${a.taskId}`}
                        className="text-[var(--accent)]"
                      >
                        view
                      </Link>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="py-2 text-[var(--muted)]">
                    {a.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
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
