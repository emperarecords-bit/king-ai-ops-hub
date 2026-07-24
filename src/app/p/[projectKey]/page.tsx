import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listTasks } from '@/domain/tasks/tasks';
import { listApprovals } from '@/domain/approvals/approvals';
import { projectSpendLimit, spentThisPeriodMicros } from '@/domain/usage/usage';
import { formatMoney } from '@/lib/money';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);

  const { tasks, pendingApprovals, spentMicros, limitMicros } = await withTenant(
    ctx,
    async (tx) => ({
      tasks: await listTasks(tx, ctx, 10),
      pendingApprovals: await listApprovals(tx, ctx, 'pending'),
      spentMicros: await spentThisPeriodMicros(tx, ctx.projectId),
      limitMicros: await projectSpendLimit(tx, ctx.projectId),
    }),
  );

  const base = `/p/${projectKey}`;
  const budgetPct =
    limitMicros > 0n ? Number((spentMicros * 100n) / limitMicros) : 100;

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Workspace overview"
        action={
          <Link
            href={`${base}/tasks/new`}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)]"
          >
            + New task
          </Link>
        }
      />

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Card title="Monthly spend">
          <p className="text-2xl font-bold">
            {formatMoney({ usdMicros: spentMicros })}
            <span className="ml-2 text-sm font-normal text-[var(--muted)]">
              of {formatMoney({ usdMicros: limitMicros })}
            </span>
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded bg-[var(--background)]">
            <div
              className={`h-full ${budgetPct >= 90 ? 'bg-[var(--danger)]' : 'bg-[var(--accent)]'}`}
              style={{ width: `${Math.min(budgetPct, 100)}%` }}
            />
          </div>
        </Card>
        <Card title="Pending approvals">
          <p className="text-2xl font-bold">{pendingApprovals.length}</p>
          {pendingApprovals.length > 0 ? (
            <Link href={`${base}/approvals`} className="text-sm text-[var(--accent)]">
              Review queue →
            </Link>
          ) : (
            <p className="text-sm text-[var(--muted)]">Nothing waiting on you.</p>
          )}
        </Card>
        <Card title="Recent tasks">
          <p className="text-2xl font-bold">{tasks.length}</p>
          <p className="text-sm text-[var(--muted)]">shown below</p>
        </Card>
      </div>

      <Card title="Task history">
        {tasks.length === 0 ? (
          <EmptyState>
            No tasks yet. Submit the first one and the full conversation, cost, and audit trail
            will appear here.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-[var(--border)]">
            {tasks.map((t) => (
              <li key={t.id}>
                <Link
                  href={`${base}/tasks/${t.id}`}
                  className="flex items-center justify-between gap-4 py-3 hover:bg-[var(--surface-raised)]"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{t.title}</p>
                    <p className="text-xs text-[var(--muted)]">
                      {t.providerSelection} · review {t.reviewEnabled ? 'on' : 'off'} ·{' '}
                      {t.createdAt.toISOString().slice(0, 16).replace('T', ' ')}
                    </p>
                  </div>
                  <StatusBadge status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
