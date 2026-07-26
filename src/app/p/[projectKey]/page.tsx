import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listTasks } from '@/domain/tasks/tasks';
import { listAgents } from '@/domain/agents/agents';
import { employeeStats } from '@/domain/agents/stats';
import { listObjectives } from '@/domain/objectives/objectives';
import { listWorkItems } from '@/domain/work/work-items';
import { listApprovals } from '@/domain/approvals/approvals';
import { getWorkspaceSettings } from '@/domain/projects/settings';
import { projectSpendLimit, spentThisPeriodMicros } from '@/domain/usage/usage';
import { buildBriefing } from '@/domain/dashboard/briefing';
import { formatMoney } from '@/lib/money';
import { Card } from '@/components/ui';
import { ReasoningPanel } from './reasoning-panel';

/**
 * The Dashboard — the front door. Not a wall of widgets: arriving at work. It answers
 * "how is my business doing, and where do I need to act?" in one accountable, business-first
 * voice, and points into the work rather than holding you (HUB-PRODUCT.md). The judgment lives
 * in domain/dashboard/briefing; this file is its voice.
 */
export default async function DashboardPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);

  const { settings, objectives, approvals, tasks, workItems, spentMicros, limitMicros, agents, stats } =
    await withTenant(ctx, async (tx) => ({
      settings: await getWorkspaceSettings(tx, ctx),
      objectives: await listObjectives(tx, ctx),
      approvals: await listApprovals(tx, ctx, 'pending'),
      tasks: await listTasks(tx, ctx, 12),
      workItems: await listWorkItems(tx, ctx),
      spentMicros: await spentThisPeriodMicros(tx, ctx.projectId),
      limitMicros: await projectSpendLimit(tx, ctx.projectId),
      agents: await listAgents(tx, ctx),
      stats: await employeeStats(tx, ctx),
    }));

  const base = `/p/${projectKey}`;
  const failed = tasks.filter((t) => t.status === 'failed');
  const recentDone = tasks.filter((t) => t.status === 'completed').slice(0, 3);

  const briefing = buildBriefing({
    business: settings.name,
    objectives,
    pendingApprovals: approvals.length,
    failed: failed.length,
  });

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';

  const enabledAgents = agents.filter((a) => a.enabled);
  const runningNow = [...stats.values()].filter((s) => s.activeRuns > 0).length;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-5 flex items-center gap-2 text-sm text-[var(--muted)]">
        <span className="text-[var(--foreground)]">{settings.name}</span>
        <span>· workspace</span>
        <Link href="/projects" className="text-[var(--muted)] hover:text-[var(--foreground)]">
          switch →
        </Link>
      </div>

      <p className="text-sm text-[var(--muted)]">{greeting}</p>
      <h1 className="mb-6 mt-1 text-2xl font-medium leading-snug text-[var(--foreground)]">
        {briefing.verdict}
      </h1>

      {briefing.mood === 'uncertain' ? (
        <p className="mb-6 text-[15px] leading-relaxed text-[var(--muted)]">
          There are no active objectives yet, so I can&rsquo;t judge whether the business is moving.{' '}
          <Link href={`${base}/objectives/new`} className="text-[var(--accent)]">
            Define one and I&rsquo;ll have something to stand on →
          </Link>
        </p>
      ) : null}

      {briefing.standout ? (
        <Card className="mb-4 border-l-2 border-l-[var(--accent-strong)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-medium text-[var(--foreground)]">{briefing.standout.title}</p>
              <p className="mt-1 text-sm text-[var(--muted)]">{briefing.standout.surface}</p>
            </div>
            <Link
              href={`${base}/objectives/${briefing.standout.objectiveId}`}
              className="whitespace-nowrap text-sm text-[var(--accent)]"
            >
              Open objective →
            </Link>
          </div>
          <ReasoningPanel reasoning={briefing.standout.reasoning} />
        </Card>
      ) : null}

      {failed.length > 0 ? (
        <div className="mb-4 space-y-1">
          {failed.map((t) => (
            <Link
              key={t.id}
              href={`${base}/tasks/${t.id}`}
              className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-[var(--surface-raised)]"
            >
              <span>{t.title}</span>
              <span className="text-xs text-[var(--danger)]">failed — open to retry</span>
            </Link>
          ))}
        </div>
      ) : null}

      {approvals.length > 0 ? (
        <p className="mb-4 text-sm text-[var(--muted)]">
          {approvals.length} approval{approvals.length === 1 ? '' : 's'} waiting —{' '}
          {briefing.standout || failed.length > 0 ? 'administrative, nothing blocked. ' : ''}
          <Link href={`${base}/approvals`} className="text-[var(--accent)]">
            Review{approvals.length === 1 ? '' : ' queue'} →
          </Link>
        </p>
      ) : null}

      {briefing.reassurance ? (
        <p className="mb-6 text-sm text-[var(--muted)]">{briefing.reassurance}</p>
      ) : null}

      {briefing.mood === 'normal' ? (
        <p className="mb-6 text-[15px] leading-relaxed text-[var(--muted)]">
          Nothing needs a decision, and nothing&rsquo;s blocked.
        </p>
      ) : null}

      {briefing.mood !== 'attention' ? (
        <div className="mb-6 grid gap-3 sm:grid-cols-3">
          <Stat label="Objectives" value={`${briefing.advancing} active`} />
          <Stat label="Work" value={`${workItems.length} tracked`} />
          <Stat
            label="On your desk"
            value={approvals.length > 0 ? `${approvals.length} to decide` : 'nothing to decide'}
          />
        </div>
      ) : null}

      {recentDone.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-[var(--muted)]">
          <span>Recently</span>
          <span>·</span>
          <span className="text-[var(--foreground)]">
            {recentDone.map((t) => t.title).join(' · ')}
          </span>
        </div>
      ) : null}

      {briefing.mood === 'normal' ? (
        <p className="mb-2 text-sm italic text-[var(--muted)]">You&rsquo;re clear.</p>
      ) : null}

      <div className="mt-8 flex flex-wrap gap-x-5 gap-y-1 border-t border-[var(--border)] pt-3 text-xs text-[var(--muted)]">
        <span>
          {enabledAgents.length} employee{enabledAgents.length === 1 ? '' : 's'} ·{' '}
          {runningNow === 0 ? 'none running now' : `${runningNow} running now`}
        </span>
        <span>
          {formatMoney({ usdMicros: spentMicros })} of {formatMoney({ usdMicros: limitMicros })} this month
        </span>
        <span>{failed.length === 0 ? 'no failed work' : `${failed.length} failed`}</span>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-[var(--surface-raised)] px-3 py-2">
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className="mt-0.5 text-sm text-[var(--foreground)]">{value}</p>
    </div>
  );
}
