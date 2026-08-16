import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listObjectives, type ObjectiveProgress } from '@/domain/objectives/objectives';
import { assessObjective } from '@/domain/objectives/assess';
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { type DataClassification } from '@/types/domain';
import { exclusionSummary, visibilityFromParam } from '@/domain/classification/classification';
import { ClassificationChip, NonLiveControls } from '../non-live-controls';

/**
 * The portfolio of commitments (HUB-PRODUCT.md → Objectives). Priority-led and stable — grouped
 * by operator intent (active, then closed), not by the Hub's shifting judgment. Each commitment
 * carries just enough judgment to grasp without opening: a criteria-and-evidence read, never a
 * task-derived percentage. This is a review of every commitment, distinct from the Dashboard's
 * "where do I act" briefing.
 */
export default async function ObjectivesPage({
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
  const all = await withTenant(ctx, (tx) => listObjectives(tx, ctx));

  // HUB-009 — the objective LIST defaults to live-only; the headline verdict is always over LIVE objectives.
  const liveObjectives = all.filter((o) => o.classification === 'live');
  const objectives = visibility.includeNonLive ? all : liveObjectives;
  const excluded = exclusionSummary({
    excludedDemo: all.filter((o) => o.classification === 'demo').length,
    excludedSeed: all.filter((o) => o.classification === 'seed').length,
  });

  const assessed = objectives.map((o) => ({
    o,
    a: assessObjective({
      status: o.status,
      criteria: o.successCriteria,
      taskTotal: o.progress.tasksTotal,
      workItemTotal: o.workItemTotal,
    }),
  }));
  // Headline counts are LIVE-only regardless of the display toggle.
  const liveAssessed = assessed.filter(({ o }) => o.classification === 'live');
  const active = assessed.filter(({ o }) => o.status === 'active' || o.status === 'draft');
  const closed = assessed.filter(({ o }) => o.status === 'completed' || o.status === 'cancelled');
  const liveActive = liveAssessed.filter(({ o }) => o.status === 'active' || o.status === 'draft');
  const liveClosed = liveAssessed.filter(({ o }) => o.status === 'completed' || o.status === 'cancelled');

  const advancing = liveActive.filter(({ a }) => a.state === 'advancing' || a.state === 'ready-to-close').length;
  const noEvidence = liveActive.filter(({ a }) => a.state === 'effort-only' || a.state === 'insufficient').length;
  const shape: string[] = [];
  if (advancing > 0) shape.push(`${advancing} advancing on evidence`);
  if (noEvidence > 0) shape.push(`${noEvidence} without outcome evidence yet`);
  const verdict =
    liveActive.length === 0
      ? 'No active commitments yet.'
      : `${liveActive.length} active ${liveActive.length === 1 ? 'commitment' : 'commitments'}${
          shape.length ? ` — ${shape.join(', ')}` : ''
        }.${liveClosed.length > 0 ? ` ${liveClosed.length} closed.` : ''}`;

  return (
    <div>
      <PageHeader
        title="Objectives"
        subtitle="The workspace's commitments — and whether each intended outcome is actually advancing. Progress is measured against success criteria, not activity."
        action={
          <Link
            href={`/p/${projectKey}/objectives/new`}
            className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)]"
          >
            + New objective
          </Link>
        }
      />

      <NonLiveControls pathname={`/p/${projectKey}/objectives`} searchParams={sp} includeNonLive={visibility.includeNonLive} excluded={excluded} />

      {objectives.length === 0 ? (
        <EmptyState>
          No objectives yet. Define what you&apos;re trying to achieve and how you&apos;ll know it
          succeeded.
        </EmptyState>
      ) : (
        <>
          <p className="mb-6 text-[15px] leading-relaxed text-[var(--foreground)]">{verdict}</p>

          {active.length > 0 ? (
            <section className="mb-8">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                Active
              </h2>
              <div className="divide-y divide-[var(--border)]">
                {active.map(({ o, a }) => (
                  <Row key={o.id} projectKey={projectKey} o={o} a={a} progress={o.progress} />
                ))}
              </div>
            </section>
          ) : null}

          {closed.length > 0 ? (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                Closed
              </h2>
              <div className="divide-y divide-[var(--border)]">
                {closed.map(({ o, a }) => (
                  <Link
                    key={o.id}
                    href={`/p/${projectKey}/objectives/${o.id}`}
                    className="flex items-center justify-between gap-3 py-2.5 hover:opacity-90"
                  >
                    <span className="flex items-center gap-2 text-sm text-[var(--secondary,var(--muted))]">
                      <StatusBadge status={o.status} />
                      <ClassificationChip classification={o.classification} />
                      <span className="text-[var(--foreground)]">{o.title}</span>
                    </span>
                    <span className="text-xs text-[var(--muted)]">{a.outcomeSummary}</span>
                  </Link>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

/** "2h ago" / "3d ago" for the last-movement stamp. */
function ago(d: Date): string {
  const mins = Math.max(0, Math.round((Date.now() - d.getTime()) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function Row({
  projectKey,
  o,
  a,
  progress,
}: {
  projectKey: string;
  o: { id: string; title: string; status: string; accountableEmployee: string | null; classification: DataClassification };
  a: { headline: string; outcomeSummary: string; confidence: string | null };
  progress: ObjectiveProgress;
}) {
  const p = progress;
  const started = p.tasksTotal > 0 || p.milestonesTotal > 0 || p.criteriaSatisfied > 0;
  // Concrete movement facts, only the ones that exist — no empty "0 of 0" noise.
  const facts: string[] = [];
  if (p.tasksTotal > 0) facts.push(`${p.tasksCompleted} of ${p.tasksTotal} task${p.tasksTotal === 1 ? '' : 's'} done`);
  if (p.tasksRunning > 0) facts.push(`${p.tasksRunning} in progress`);
  if (p.tasksAwaitingApproval > 0) facts.push(`${p.tasksAwaitingApproval} waiting for your okay`);
  if (p.milestonesTotal > 0) facts.push(`${p.milestonesCompleted}/${p.milestonesTotal} milestones`);
  if (p.criteriaTotal > 0) facts.push(`${p.criteriaSatisfied}/${p.criteriaTotal} success criteria met`);
  if (p.lastActivityAt) facts.push(`last activity ${ago(p.lastActivityAt)}`);

  return (
    <Link href={`/p/${projectKey}/objectives/${o.id}`} className="block py-3.5 hover:opacity-95">
      <div className="flex items-baseline gap-3">
        <span className="text-base font-medium text-[var(--foreground)]">{o.title}</span>
        <StatusBadge status={o.status} />
        <ClassificationChip classification={o.classification} />
        {o.accountableEmployee ? (
          <span className="ml-auto text-xs text-[var(--muted)]">{o.accountableEmployee}</span>
        ) : null}
      </div>
      {/* Progress at a glance: the bar tracks completed tasks (or criteria when no tasks exist). */}
      <div className="mt-2 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--surface-raised)]" role="progressbar" aria-valuenow={p.percent} aria-valuemin={0} aria-valuemax={100}>
          <div
            className={`h-full rounded-full ${p.percent > 0 ? 'bg-[var(--accent)]' : ''} ${p.tasksAwaitingApproval > 0 ? 'opacity-90' : ''}`}
            style={{ width: `${Math.max(p.percent, p.percent > 0 ? 3 : 0)}%` }}
          />
        </div>
        <span className="w-10 shrink-0 text-right text-xs font-semibold text-[var(--foreground)]">{p.percent}%</span>
      </div>
      <p className="mt-1 text-xs text-[var(--muted)]">
        {started ? facts.join(' · ') : 'No work started yet — chat with the General Manager to kick it off.'}
      </p>
      <p className="mt-1 text-xs text-[var(--muted)]">
        {a.outcomeSummary}
        {a.confidence ? ` · ${a.confidence}` : ''}
      </p>
    </Link>
  );
}
