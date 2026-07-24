import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { expireStaleApprovals, listApprovals } from '@/domain/approvals/approvals';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { DecisionForm } from './decision-form';

export default async function ApprovalsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);

  const approvals = await withTenant(ctx, async (tx) => {
    await expireStaleApprovals(tx, ctx); // A5: the queue never lies
    return listApprovals(tx, ctx);
  });
  const pending = approvals.filter((a) => a.status === 'pending');
  const decided = approvals.filter((a) => a.status !== 'pending');

  return (
    <div>
      <PageHeader
        title="Approval queue"
        subtitle="Every consequential action a model proposes stops here. Nothing executes without your explicit decision, and every decision is audited."
      />

      <Card title={`Pending (${pending.length})`} className="mb-6">
        {pending.length === 0 ? (
          <EmptyState>No actions waiting for approval.</EmptyState>
        ) : (
          <ul className="space-y-5">
            {pending.map((a) => (
              <li key={a.id} className="rounded-md border border-[var(--border)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <span className="rounded bg-[#3a2c20] px-2 py-0.5 font-mono text-xs text-[var(--accent)]">
                      {a.actionType}
                    </span>
                    <span className="ml-2 text-sm">{a.summary}</span>
                  </div>
                  <span className="text-xs text-[var(--muted)]">
                    expires {a.expiresAt.toISOString().slice(0, 16).replace('T', ' ')}
                  </span>
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-[var(--muted)]">
                    Full payload (review before approving)
                  </summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-words rounded bg-[var(--background)] p-3 font-mono text-xs">
                    {JSON.stringify(a.payload, null, 2)}
                  </pre>
                  <p className="mt-1 font-mono text-[10px] text-[var(--muted)]">
                    sha256 {a.payloadSha256}
                  </p>
                </details>
                <p className="mt-2 text-xs text-[var(--muted)]">
                  Requested by {a.requestedBy ?? 'unknown'} ·{' '}
                  <Link href={`/p/${projectKey}/tasks/${a.taskId}`} className="text-[var(--accent)]">
                    view task
                  </Link>
                </p>
                <DecisionForm projectKey={projectKey} approvalId={a.id} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Decided (${decided.length})`}>
        {decided.length === 0 ? (
          <EmptyState>No history yet.</EmptyState>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {decided.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <span className="font-mono text-xs text-[var(--muted)]">{a.actionType}</span>{' '}
                  <span className="truncate">{a.summary}</span>
                  {a.decisionNote ? (
                    <p className="text-xs text-[var(--muted)]">note: {a.decisionNote}</p>
                  ) : null}
                </div>
                <StatusBadge status={a.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
