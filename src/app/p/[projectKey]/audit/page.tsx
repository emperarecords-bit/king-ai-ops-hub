import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listAuditEvents } from '@/domain/audit/audit';
import { Card, EmptyState, PageHeader } from '@/components/ui';

export default async function AuditLogPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const events = await withTenant(ctx, (tx) => listAuditEvents(tx, ctx.projectId));

  return (
    <div>
      <PageHeader
        title="Audit log"
        subtitle="Append-only and hash-chained. Rows cannot be edited or deleted — corrections are new events."
      />
      <Card>
        {events.length === 0 ? (
          <EmptyState>No audit events for this project yet.</EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs uppercase text-[var(--muted)]">
                <th className="py-2 pr-4">When (UTC)</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Entity</th>
                <th className="py-2 pr-4">Detail</th>
                <th className="py-2">Hash</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-[var(--border)] align-top">
                  <td className="whitespace-nowrap py-2 pr-4 text-[var(--muted)]">
                    {e.createdAt.toISOString().slice(0, 19).replace('T', ' ')}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">{e.action}</td>
                  <td className="py-2 pr-4 text-xs text-[var(--muted)]">
                    {e.entityType}
                    {e.entityId ? ` ${e.entityId.slice(0, 8)}…` : ''}
                  </td>
                  <td className="max-w-md py-2 pr-4">
                    <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--muted)]">
                      {JSON.stringify(e.detail)}
                    </pre>
                  </td>
                  <td className="py-2 font-mono text-[10px] text-[var(--muted)]">
                    {e.rowHash.slice(0, 12)}…
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
