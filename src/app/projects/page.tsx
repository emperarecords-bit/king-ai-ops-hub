import Link from 'next/link';
import { listMyProjectsWithOrgRoles } from '@/domain/auth/guard';
import { morningBriefing } from '@/domain/briefing/briefing';
import { overallLabel } from '@/domain/health/health';
import { signOut } from '@/app/login/actions';
import { Card, EmptyState } from '@/components/ui';
import { exclusionSummary, visibilityFromParam } from '@/domain/classification/classification';
import { ClassificationChip, NonLiveControls } from '@/app/p/[projectKey]/non-live-controls';

const SEVERITY_RANK: Record<string, number> = {
  critical: 0,
  attention: 1,
  opportunity: 2,
  positive: 3,
};

const SEVERITY_BORDER: Record<string, string> = {
  critical: 'border-l-[var(--danger)]',
  attention: 'border-l-[var(--accent)]',
  opportunity: 'border-l-[var(--info)]',
  positive: 'border-l-[var(--success)]',
};

/**
 * The Morning Briefing (Sprint 6, extended Sprint 9). The first page after
 * sign-in opens with answers: what matters (composite management insights),
 * what was prepared overnight, and what needs a decision — across every
 * workspace, consequence first.
 */
export default async function MorningBriefingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const visibility = visibilityFromParam(sp.includeNonLive);
  const { user, projects, orgRoles } = await listMyProjectsWithOrgRoles();
  const briefing = await morningBriefing(user.id, projects, orgRoles, visibility);
  const { totals, workspaces } = briefing;
  // Aggregate the non-live prepared items hidden across all workspace cards (headline totals stay live-only).
  const excludedPrepared = exclusionSummary({
    excludedDemo: workspaces.reduce((s, w) => s + w.preparedExcluded.demo, 0),
    excludedSeed: workspaces.reduce((s, w) => s + w.preparedExcluded.seed, 0),
  });
  // Separated demo/seed briefing figures (only shown when opted in; live headline totals stay live-only).
  const sum = (f: (w: (typeof workspaces)[number]['nonLive']) => number) => workspaces.reduce((s, w) => s + f(w.nonLive), 0);
  const nl = {
    completedDemo: sum((n) => n.runsCompletedDemo), completedSeed: sum((n) => n.runsCompletedSeed),
    failedDemo: sum((n) => n.runsFailedDemo), failedSeed: sum((n) => n.runsFailedSeed),
    workingDemo: sum((n) => n.workingDemo), workingSeed: sum((n) => n.workingSeed),
    openTasksDemo: sum((n) => n.openTasksDemo), openTasksSeed: sum((n) => n.openTasksSeed),
    atRiskDemo: sum((n) => n.objectivesAtRiskDemo), atRiskSeed: sum((n) => n.objectivesAtRiskSeed),
  };

  const hour = new Date().getUTCHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const needsAttention = totals.runsFailed + totals.objectivesAtRisk + totals.budgetAlerts;

  // Insights across all workspaces, most consequential first, capped so the
  // briefing stays a briefing (P5: clarity over completeness).
  const allInsights = workspaces
    .flatMap((w) => w.insights.map((insight) => ({ insight, workspaceName: w.projectName })))
    .sort(
      (a, b) =>
        (SEVERITY_RANK[a.insight.severity] ?? 9) - (SEVERITY_RANK[b.insight.severity] ?? 9),
    )
    .slice(0, 6);

  return (
    <main className="mx-auto max-w-4xl p-8">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{greeting}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {totals.pendingApprovals > 0
              ? `${totals.pendingApprovals} decision${totals.pendingApprovals === 1 ? '' : 's'} waiting on you.`
              : totals.workingNow > 0
                ? 'Nothing needs you right now — your team is working.'
                : 'All caught up.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/projects/new"
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)]"
          >
            + New workspace
          </Link>
          <form action={signOut}>
            <button
              type="submit"
              className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)]"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>

      {workspaces.length === 0 ? (
        <EmptyState>
          Welcome! Create your first workspace — it arrives already staffed with an AI team, a
          budget, and its own isolated memory.
        </EmptyState>
      ) : (
        <>
          <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card title="Decisions waiting">
              <p
                className={`text-3xl font-bold ${totals.pendingApprovals > 0 ? 'text-[var(--accent)]' : ''}`}
              >
                {totals.pendingApprovals}
              </p>
            </Card>
            <Card title="Completed (24h)">
              <p className="text-3xl font-bold">{totals.runsCompleted}</p>
              {totals.reviewInterventions > 0 ? (
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {totals.reviewInterventions} changed by review — worth reading
                </p>
              ) : null}
            </Card>
            <Card title="Needs attention">
              <p
                className={`text-3xl font-bold ${needsAttention > 0 ? 'text-[var(--danger)]' : ''}`}
              >
                {needsAttention}
              </p>
              <p className="mt-1 text-xs text-[var(--muted)]">
                failed · at-risk · budget
              </p>
            </Card>
            <Card title="Working now">
              <p className="text-3xl font-bold">{totals.workingNow}</p>
            </Card>
          </div>

          {allInsights.length > 0 ? (
            <section className="mb-8">
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
                What matters
              </h2>
              <ul className="space-y-2">
                {allInsights.map(({ insight, workspaceName }) => (
                  <li
                    key={insight.key}
                    className={`rounded-lg border-l-4 border border-[var(--border)] bg-[var(--surface)] p-4 ${SEVERITY_BORDER[insight.severity]}`}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <p className="text-sm">
                          <span className="text-[var(--muted)]">{workspaceName} · </span>
                          {insight.headline}
                        </p>
                        <p className="mt-1 text-sm text-[var(--muted)]">{insight.action}</p>
                      </div>
                      <Link
                        href={insight.href}
                        className="shrink-0 rounded-md border border-[var(--border)] px-3 py-1.5 text-xs hover:border-[var(--accent)]"
                      >
                        Open
                      </Link>
                    </div>
                    <details className="mt-2">
                      <summary className="cursor-pointer text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                        Why this says that
                      </summary>
                      <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-[var(--muted)] sm:grid-cols-3">
                        {Object.entries(insight.evidence).map(([label, value]) => (
                          <div key={label}>
                            <dt className="inline">{label.replace(/([A-Z])/g, ' $1').toLowerCase()}: </dt>
                            <dd className="inline font-medium text-[var(--foreground)]">{value}</dd>
                          </div>
                        ))}
                      </dl>
                    </details>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <NonLiveControls pathname="/projects" searchParams={sp} includeNonLive={visibility.includeNonLive} excluded={excludedPrepared} />
          {visibility.includeNonLive ? (
            <div className="mb-6 grid gap-2 text-xs text-[var(--muted)] sm:grid-cols-2" data-testid="briefing-non-live">
              <p><span className="font-semibold uppercase text-[#c9a769]">Demo</span> (separate, not in live totals): {nl.completedDemo} completed · {nl.failedDemo} failed · {nl.workingDemo} working · {nl.openTasksDemo} open · {nl.atRiskDemo} at-risk.</p>
              <p><span className="font-semibold uppercase text-[#7fb2d1]">Seed</span> (separate, not in live totals): {nl.completedSeed} completed · {nl.failedSeed} failed · {nl.workingSeed} working · {nl.openTasksSeed} open · {nl.atRiskSeed} at-risk.</p>
            </div>
          ) : null}

          {workspaces.some((w) => w.prepared.length > 0) ? (
            <Card title="Prepared while you were away" className="mb-8 border-[var(--accent)]">
              <ul className="space-y-1">
                {workspaces
                  .flatMap((w) => w.prepared)
                  .map((p) => (
                    <li key={p.taskId}>
                      <Link
                        href={`/p/${p.projectKey}/tasks/${p.taskId}`}
                        className="flex items-center justify-between gap-3 rounded px-2 py-1.5 text-sm hover:bg-[var(--surface-raised)]"
                      >
                        <span className="flex items-center gap-2"><ClassificationChip classification={p.classification} />{p.title}</span>
                        <span className="text-xs text-[var(--muted)]">
                          {p.status === 'awaiting_approval'
                            ? 'needs your decision'
                            : p.status === 'failed'
                              ? 'failed'
                              : 'ready to read'}
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
            </Card>
          ) : null}

          <ul className="space-y-3">
            {workspaces.map((w) => {
              const quiet =
                w.pendingApprovals === 0 &&
                w.runsFailed === 0 &&
                w.objectivesAtRisk === 0 &&
                w.runsCompleted === 0 &&
                w.workingNow === 0;
              return (
                <li key={w.projectKey}>
                  <div className="flex items-center justify-between gap-4 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors hover:border-[var(--accent)]">
                    <Link href={`/p/${w.projectKey}`} className="min-w-0 flex-1">
                      <p className="font-semibold">{w.projectName}</p>
                      {/* Same structured health as the Dashboard (HUB-007) — condition + outcome, not activity alone. */}
                      <p className="mt-1 text-xs">
                        <span
                          className={
                            w.overall === 'healthy'
                              ? 'text-[var(--success)]'
                              : w.overall === 'operational_with_warnings' || w.overall === 'unable_to_assess'
                                ? 'text-[#e5c07b]'
                                : 'text-[var(--danger)]'
                          }
                        >
                          {overallLabel(w.overall)}
                        </span>
                        {w.outcome ? <span className="ml-2 text-[var(--muted)]">· {w.outcome}</span> : null}
                      </p>
                      <p className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
                        {quiet ? <span>quiet</span> : null}
                        {w.workingNow > 0 ? (
                          <span className="text-[var(--accent-strong)]">
                            {w.workingNow} working now
                          </span>
                        ) : null}
                        {w.runsCompleted > 0 ? <span>{w.runsCompleted} done overnight</span> : null}
                        {w.reviewInterventions > 0 ? (
                          <span>{w.reviewInterventions} review catch{w.reviewInterventions === 1 ? '' : 'es'}</span>
                        ) : null}
                        {w.runsFailed > 0 ? (
                          <span className="text-[var(--danger)]">{w.runsFailed} failed</span>
                        ) : null}
                        {w.objectivesAtRisk > 0 ? (
                          <span className="text-[var(--danger)]">
                            {w.objectivesAtRisk} objective{w.objectivesAtRisk === 1 ? '' : 's'} at risk
                          </span>
                        ) : null}
                        {w.spentPct >= 80 ? (
                          <span className="text-[var(--danger)]">budget {w.spentPct}%</span>
                        ) : null}
                        {w.activeObjectives > 0 && w.objectivesAtRisk === 0 ? (
                          <span>
                            {w.activeObjectives} objective{w.activeObjectives === 1 ? '' : 's'} in motion
                          </span>
                        ) : null}
                      </p>
                    </Link>
                    {w.pendingApprovals > 0 ? (
                      <Link
                        href={`/p/${w.projectKey}/approvals`}
                        className="shrink-0 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)]"
                      >
                        Decide {w.pendingApprovals}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-6 text-xs text-[var(--muted)]">
            Signed in as {user.email}. Workspaces are fully isolated — the briefing counts across
            them, but content never crosses.
          </p>
        </>
      )}
    </main>
  );
}
