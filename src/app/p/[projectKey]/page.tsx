import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { projects } from '@/db/schema';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listTasks } from '@/domain/tasks/tasks';
import { listAgents } from '@/domain/agents/agents';
import { employeeStats } from '@/domain/agents/stats';
import { listApprovals } from '@/domain/approvals/approvals';
import { getWorkspaceSettings } from '@/domain/projects/settings';
import { assessWorkspaceHealth, briefingSummary, overallLabel, outcomeLine, type DimensionStatus, type HealthDimension } from '@/domain/health/health';
import { assessTask } from '@/domain/execution/assess';
import { formatMoney } from '@/lib/money';
import { Card } from '@/components/ui';
import { exclusionSummary, visibilityFromParam } from '@/domain/classification/classification';
import { ClassificationChip, NonLiveControls } from './non-live-controls';

/**
 * The Dashboard — the front door. It answers "how is my business doing, and where do I need to act?"
 * from ONE structured health model (domain/health), truthfully: activity is never dressed up as outcome,
 * and "healthy" is only said when the workspace is actually healthy across every dimension.
 */
export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectKey } = await params;
  const sp = await searchParams;
  const visibility = visibilityFromParam(sp.includeNonLive);
  const ctx = await requireTenant(projectKey);

  const { settings, health, approvals, tasks, agents, stats, gm } = await withTenant(ctx, async (tx) => {
    const loaded = {
      settings: await getWorkspaceSettings(tx, ctx),
      health: await assessWorkspaceHealth(tx, ctx), // health headline is live-only by construction
      approvals: await listApprovals(tx, ctx, 'pending'),
      tasks: await listTasks(tx, ctx, 12),
      agents: await listAgents(tx, ctx),
      stats: await employeeStats(tx, ctx),
    };
    // The General Manager greets at the door (owner directive): the workspace's single point of contact.
    const owner = await tx
      .select({ ownerAgentId: projects.ownerAgentId })
      .from(projects)
      .where(eq(projects.id, ctx.projectId))
      .limit(1);
    const gmAgent = owner[0]?.ownerAgentId ? (loaded.agents.find((a) => a.id === owner[0]!.ownerAgentId) ?? null) : null;
    return { ...loaded, gm: gmAgent && gmAgent.enabled ? { id: gmAgent.id, name: gmAgent.name } : null };
  });

  const base = `/p/${projectKey}`;
  const summary = briefingSummary(health, settings.name);
  // HUB-009 — the dashboard's recent/failed lists default to live-only; demo/seed rows appear labelled only
  // when the operator opts in, and never change the live health headline.
  const visibleTasks = visibility.includeNonLive ? tasks : tasks.filter((t) => t.classification === 'live');
  const excludedRecent = exclusionSummary({
    excludedDemo: tasks.filter((t) => t.classification === 'demo').length,
    excludedSeed: tasks.filter((t) => t.classification === 'seed').length,
  });
  const failed = visibleTasks
    .filter((t) => t.status === 'failed')
    .map((t) => ({ ...t, a: assessTask({ status: t.status, ownerAgentId: t.ownerAgentId }) }));
  const recentDone = visibleTasks.filter((t) => t.status === 'completed').slice(0, 3);

  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning.' : hour < 18 ? 'Good afternoon.' : 'Good evening.';
  const enabledAgents = agents.filter((a) => a.enabled);
  const runningNow = [...stats.values()].filter((s) => s.activeRuns > 0).length;

  const o = health.activeObjective;

  return (
    <div className="mx-auto max-w-3xl">
      <p className="text-sm text-[var(--muted)]">{greeting}</p>
      <h1 className="mb-1 mt-1 text-2xl font-medium leading-snug text-[var(--foreground)]">{summary.headline}</h1>

      {/* The GM greets at the door — one tap from opening the workspace to talking to the person who runs it. */}
      {gm ? (
        <div className="mb-4 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--accent)] bg-[var(--surface)] px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-[var(--foreground)]">{gm.name}</p>
            <p className="text-xs text-[var(--muted)]">Your General Manager — runs this workspace, reports to you.</p>
          </div>
          <Link
            href={`${base}/agents/${gm.id}/talk`}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)]"
          >
            🎤 Talk
          </Link>
          <Link
            href={`${base}/agents/${gm.id}/chat`}
            className="rounded-md border border-[var(--border)] px-4 py-2 text-sm font-semibold hover:border-[var(--accent)]"
          >
            ⌨️ Chat
          </Link>
        </div>
      ) : null}

      <NonLiveControls pathname={base} searchParams={sp} includeNonLive={visibility.includeNonLive} excluded={excludedRecent} />
      <p className="mb-4 text-xs text-[var(--muted)]" data-testid="dashboard-run-facts">
        Completed runs (live): {health.execution.runsCompleted}
        {health.execution.runsCompletedDemo > 0 ? ` · demo (separate): ${health.execution.runsCompletedDemo}` : ''}
        {health.execution.runsCompletedSeed > 0 ? ` · seed (separate): ${health.execution.runsCompletedSeed}` : ''}
        {' '}· not a health verdict.
      </p>

      {/* Overall condition + per-dimension read — health is defined across dimensions, not by the absence of flags.
          Every chip is a DOOR: it links to the page where that dimension is actually managed. */}
      <div className="mb-6 flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded px-2 py-0.5 font-semibold ${overallClass(health.overall)}`}>
          {overallLabel(health.overall)}
        </span>
        {(['execution', 'workflow_integrity', 'governance', 'outcome', 'activity'] as HealthDimension[]).map((d) => (
          <Link
            key={d}
            href={`${base}${DIM_ROUTE[d]}`}
            title={`Open ${DIM_LABEL[d].toLowerCase()}`}
            className={`rounded px-2 py-0.5 underline-offset-2 hover:underline hover:opacity-80 ${dimClass(health.dimensions[d])}`}
          >
            {DIM_LABEL[d]}: {health.dimensions[d]} →
          </Link>
        ))}
      </div>

      {/* Active objective — activity and outcome shown SEPARATELY and explicitly labeled (never a bare %). */}
      {o ? (
        <Card title="Active objective" className="mb-4">
          <p className="font-medium text-[var(--foreground)]">{o.title}</p>
          <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-2">
            <Metric k="Contributing tasks (activity)" v={`${o.contributingTasksCompleted} of ${o.contributingTasksTotal} completed`} />
            <Metric k="Outcome criteria" v={`${o.outcomeCriteriaMet} of ${o.outcomeCriteriaTotal} met`} />
            {o.criteria.filter((c) => c.target > 0 && c.unit).map((c, i) => (
              <Metric key={i} k="Target progress" v={`${c.met ? c.target : 0} of ${c.target} ${c.unit}`} />
            ))}
            <Metric k="Milestones" v={`${o.milestonesActive} active, ${o.milestonesCompleted} completed`} />
            <Metric k="Objective status" v={o.status} />
            <Metric k="Outcome evidence" v={o.evidenceNote} />
          </dl>
          <p className="mt-2 text-xs text-[var(--muted)]">
            Activity complete is not outcome achievement — {o.contributingTasksCompleted} of {o.contributingTasksTotal} planning tasks done, outcome not yet demonstrated.
          </p>
          <Link href={`${base}/objectives/${o.objectiveId}`} className="mt-2 inline-block text-sm text-[var(--accent)]">
            Open objective →
          </Link>
        </Card>
      ) : (
        <p className="mb-4 text-[15px] leading-relaxed text-[var(--muted)]">
          No active objective yet — momentum can&rsquo;t be assessed.{' '}
          <Link href={`${base}/objectives/new`} className="text-[var(--accent)]">Define one →</Link>
        </p>
      )}

      {/* Warnings + blockers, straight from the structured findings (deterministic, not AI prose). */}
      {health.findings.length > 0 ? (
        <Card title="Warnings & findings" className="mb-4">
          <ul className="space-y-2 text-sm">
            {health.findings.map((f, i) => (
              <li key={i} className="flex flex-wrap items-start gap-2">
                <span className={`mt-0.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${sevClass(f.severity)}`}>
                  {f.severity}
                </span>
                <span>
                  <span className="font-medium text-[var(--foreground)]">{f.title}</span>
                  <span className="text-[var(--muted)]"> — {f.recommendedAction}</span>
                  <span className="mt-0.5 block text-xs text-[var(--muted)]">{f.evidence}</span>
                  {/* Every finding is actionable: link straight to its subject, else to its dimension's page. */}
                  <Link href={findingHref(base, f)} className="mt-0.5 inline-block text-xs text-[var(--accent)]">
                    Go to it →
                  </Link>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {failed.length > 0 ? (
        <div className="mb-4 space-y-1">
          {failed.map((t) => (
            <Link key={t.id} href={`${base}/tasks/${t.id}`} className="flex items-center justify-between rounded px-2 py-1.5 text-sm hover:bg-[var(--surface-raised)]">
              <span className="flex items-center gap-2"><ClassificationChip classification={t.classification} />{t.title}</span>
              <span className="text-xs text-[var(--accent)]">needs you: {t.a.requiredAction}</span>
            </Link>
          ))}
        </div>
      ) : null}

      {approvals.length > 0 ? (
        <p className="mb-4 text-sm text-[var(--muted)]">
          {approvals.length} approval{approvals.length === 1 ? '' : 's'} waiting —{' '}
          <Link href={`${base}/approvals`} className="text-[var(--accent)]">Review{approvals.length === 1 ? '' : ' queue'} →</Link>
        </p>
      ) : null}

      {recentDone.length > 0 ? (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm text-[var(--muted)]">
          <span>Recently</span>
          <span>·</span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--foreground)]">
            {recentDone.map((t) => (
              <span key={t.id} className="flex items-center gap-1"><ClassificationChip classification={t.classification} />{t.title}</span>
            ))}
          </span>
        </div>
      ) : null}

      {/* Execution facts — stated as facts, NOT as proof of overall health. */}
      <div className="mt-8 flex flex-wrap gap-x-5 gap-y-1 border-t border-[var(--border)] pt-3 text-xs text-[var(--muted)]">
        <span>
          {enabledAgents.length} employee{enabledAgents.length === 1 ? '' : 's'} ·{' '}
          {runningNow === 0 ? 'none running now' : `${runningNow} running now`}
        </span>
        <span>{formatMoney({ usdMicros: health.execution.spentMicros })} of {formatMoney({ usdMicros: health.execution.limitMicros })} this month</span>
        <span>{health.execution.failedTasks === 0 ? 'no failed work' : `${health.execution.failedTasks} failed`}</span>
        <span className="italic">execution facts — not a health verdict</span>
      </div>

      {/* Keep outcomeLine reachable for the a11y/summary line (same facts, one string). */}
      {o ? <p className="sr-only">{outcomeLine(o)}</p> : null}
    </div>
  );
}

const DIM_LABEL: Record<HealthDimension, string> = {
  execution: 'Execution', workflow_integrity: 'Workflow', governance: 'Governance', outcome: 'Outcome', activity: 'Activity',
};
/** Where each health dimension is actually managed — the chip's click-through destination. */
const DIM_ROUTE: Record<HealthDimension, string> = {
  execution: '/work', workflow_integrity: '/work', governance: '/approvals', outcome: '/objectives', activity: '/work',
};
/** A finding links to its subject entity when one is recorded, else to its dimension's page. */
function findingHref(base: string, f: { dimension: HealthDimension; entityType: string | null; entityId: string | null }): string {
  if (f.entityId) {
    if (f.entityType === 'task') return `${base}/tasks/${f.entityId}`;
    if (f.entityType === 'approval') return `${base}/approvals/${f.entityId}`;
    if (f.entityType === 'objective') return `${base}/objectives/${f.entityId}`;
  }
  return `${base}${DIM_ROUTE[f.dimension]}`;
}
function overallClass(s: string): string {
  if (s === 'healthy') return 'bg-[#1f3a2a] text-[var(--success)]';
  if (s === 'data_integrity_issue' || s === 'blocked' || s === 'needs_attention') return 'bg-[#3a2026] text-[var(--danger)]';
  return 'bg-[#3a3420] text-[#e5c07b]'; // operational_with_warnings / unable_to_assess
}
function dimClass(s: DimensionStatus): string {
  if (s === 'error') return 'bg-[#3a2026] text-[var(--danger)]';
  if (s === 'warning') return 'bg-[#3a3420] text-[#e5c07b]';
  if (s === 'info') return 'bg-[var(--surface-raised)] text-[var(--muted)]';
  return 'bg-[var(--surface-raised)] text-[var(--muted)]';
}
function sevClass(s: string): string {
  if (s === 'error') return 'bg-[#3a2026] text-[var(--danger)]';
  if (s === 'warning') return 'bg-[#3a3420] text-[#e5c07b]';
  return 'bg-[var(--surface-raised)] text-[var(--muted)]';
}
function Metric({ k, v }: { k: string; v: string }) {
  return (
    <div>
      <dt className="text-xs text-[var(--muted)]">{k}</dt>
      <dd className="font-medium">{v}</dd>
    </div>
  );
}
