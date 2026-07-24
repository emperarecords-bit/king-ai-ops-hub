import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listTasks } from '@/domain/tasks/tasks';
import { listAgents } from '@/domain/agents/agents';
import { employeeStats } from '@/domain/agents/stats';
import { listObjectives } from '@/domain/objectives/objectives';
import { listApprovals } from '@/domain/approvals/approvals';
import { projectSpendLimit, spentThisPeriodMicros } from '@/domain/usage/usage';
import { formatMoney } from '@/lib/money';
import { Card, EmptyState, PageHeader, ProgressBar, StatusBadge } from '@/components/ui';

/**
 * The executive dashboard (Sprint 4 P3). Answers, at a glance: what is
 * everyone working on, what's blocked, what needs my decision, which
 * objectives are at risk, who's idle. Business language first (P5) —
 * providers/models live on diagnostic pages.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);

  const { tasks, pendingApprovals, spentMicros, limitMicros, objectives, agents, stats } =
    await withTenant(ctx, async (tx) => ({
      tasks: await listTasks(tx, ctx, 8),
      pendingApprovals: await listApprovals(tx, ctx, 'pending'),
      spentMicros: await spentThisPeriodMicros(tx, ctx.projectId),
      limitMicros: await projectSpendLimit(tx, ctx.projectId),
      objectives: await listObjectives(tx, ctx),
      agents: await listAgents(tx, ctx),
      stats: await employeeStats(tx, ctx),
    }));

  const base = `/p/${projectKey}`;
  const budgetPct = limitMicros > 0n ? Number((spentMicros * 100n) / limitMicros) : 100;

  const activeObjectives = objectives.filter((o) => o.status === 'active');
  // At risk: active but nothing currently moving it forward.
  const atRisk = activeObjectives.filter(
    (o) => o.progress.percent < 100 && o.progress.tasksTotal === o.progress.tasksCompleted,
  );
  const blockedTasks = tasks.filter((t) => t.status === 'failed');
  const workingNow = [...stats.values()].filter((s) => s.activeRuns > 0);
  const enabledAgents = agents.filter((a) => a.enabled);
  const idleEmployees = enabledAgents.filter((a) => (stats.get(a.id)?.workDone ?? 0) === 0);

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle="Company health at a glance"
        action={
          <Link
            href={`${base}/tasks/new`}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)]"
          >
            + Assign work
          </Link>
        }
      />

      {objectives.length === 0 || tasks.length === 0 ? (
        <Card title="Getting started" className="mb-6 border-[var(--accent)]">
          <ol className="space-y-2 text-sm">
            {(
              [
                ['Meet your team', `${base}/agents`, agents.length > 0 && tasks.length > 0],
                ['Define your first objective', `${base}/objectives/new`, objectives.length > 0],
                ['Assign your first work', `${base}/tasks/new`, tasks.length > 0],
              ] as const
            ).map(([label, href, done], i) => (
              <li key={label}>
                <Link
                  href={href}
                  className="flex items-center gap-3 rounded-md px-2 py-1.5 hover:bg-[var(--surface-raised)]"
                >
                  <span
                    className={`flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold ${done ? 'bg-[var(--success)] text-[#0b0e14]' : 'border border-[var(--border)] text-[var(--muted)]'}`}
                  >
                    {done ? '✓' : i + 1}
                  </span>
                  <span className={done ? 'text-[var(--muted)] line-through' : ''}>{label}</span>
                </Link>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-[var(--muted)]">
            Your team proposes; you approve. Nothing consequential ever happens without your
            sign-off.
          </p>
        </Card>
      ) : null}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card title="Needs your decision">
          <p className="text-2xl font-bold">{pendingApprovals.length}</p>
          {pendingApprovals.length > 0 ? (
            <Link href={`${base}/approvals`} className="text-sm text-[var(--accent)]">
              Review queue →
            </Link>
          ) : (
            <p className="text-sm text-[var(--muted)]">Nothing waiting on you.</p>
          )}
        </Card>
        <Card title="Working now">
          <p className="text-2xl font-bold">{workingNow.length}</p>
          <p className="text-sm text-[var(--muted)]">
            {workingNow.length === 0
              ? 'No runs in flight.'
              : `employee${workingNow.length === 1 ? '' : 's'} mid-run`}
          </p>
        </Card>
        <Card title="Objectives at risk">
          <p className={`text-2xl font-bold ${atRisk.length > 0 ? 'text-[var(--danger)]' : ''}`}>
            {atRisk.length}
          </p>
          <p className="text-sm text-[var(--muted)]">
            {atRisk.length === 0 ? 'All active objectives have work in motion.' : 'no work in motion'}
          </p>
        </Card>
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
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card title="Objectives">
          {activeObjectives.length === 0 ? (
            <EmptyState>
              No active objectives.{' '}
              <Link href={`${base}/objectives/new`} className="text-[var(--accent)]">
                Define what this workspace is trying to achieve →
              </Link>
            </EmptyState>
          ) : (
            <ul className="space-y-3">
              {activeObjectives.slice(0, 5).map((o) => (
                <li key={o.id}>
                  <Link href={`${base}/objectives/${o.id}`} className="block hover:opacity-90">
                    <div className="mb-1 flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 font-medium">
                        {o.title}
                        {atRisk.some((r) => r.id === o.id) ? (
                          <span className="rounded bg-[#3a2026] px-1.5 py-0.5 text-xs text-[var(--danger)]">
                            at risk
                          </span>
                        ) : null}
                      </span>
                      <span className="text-[var(--muted)]">{o.progress.percent}%</span>
                    </div>
                    <ProgressBar percent={o.progress.percent} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href={`${base}/objectives`} className="mt-3 inline-block text-sm text-[var(--accent)]">
            All objectives →
          </Link>
        </Card>

        <Card title="The team">
          {enabledAgents.length === 0 ? (
            <EmptyState>No employees configured.</EmptyState>
          ) : (
            <ul className="space-y-2 text-sm">
              {enabledAgents.map((a) => {
                const s = stats.get(a.id);
                const working = (s?.activeRuns ?? 0) > 0;
                return (
                  <li key={a.id} className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${working ? 'bg-[var(--accent-strong)]' : (s?.workDone ?? 0) > 0 ? 'bg-[var(--success)]' : 'bg-[var(--border)]'}`}
                      />
                      {a.name}
                      <span className="text-xs text-[var(--muted)]">
                        {s?.departmentName ?? ''}
                      </span>
                    </span>
                    <span className="text-xs text-[var(--muted)]">
                      {working
                        ? 'working now'
                        : (s?.workDone ?? 0) > 0
                          ? `${s!.workDone} done · ${formatMoney({ usdMicros: s!.costMicros })}`
                          : 'idle this period'}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
          {idleEmployees.length > 0 && idleEmployees.length < enabledAgents.length ? (
            <p className="mt-3 text-xs text-[var(--muted)]">
              {idleEmployees.length} of {enabledAgents.length} employees idle this period.
            </p>
          ) : null}
          <Link href={`${base}/agents`} className="mt-3 inline-block text-sm text-[var(--accent)]">
            All employees →
          </Link>
        </Card>
      </div>

      {blockedTasks.length > 0 ? (
        <Card title="Blocked" className="mb-6 border-[var(--danger)]">
          <ul className="space-y-1 text-sm">
            {blockedTasks.map((t) => (
              <li key={t.id}>
                <Link
                  href={`${base}/tasks/${t.id}`}
                  className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-[var(--surface-raised)]"
                >
                  <span>{t.title}</span>
                  <span className="text-xs text-[var(--danger)]">failed — open to retry</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Recent work">
        {tasks.length === 0 ? (
          <EmptyState>
            No work yet. Assign the first task and the full conversation, cost, and audit trail
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
                      {t.reviewEnabled ? 'cross-checked' : 'solo'} ·{' '}
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
