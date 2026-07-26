import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listObjectives } from '@/domain/objectives/objectives';
import { assessObjective } from '@/domain/objectives/assess';
import { EmptyState, PageHeader, StatusBadge } from '@/components/ui';

/**
 * The portfolio of commitments (HUB-PRODUCT.md → Objectives). Priority-led and stable — grouped
 * by operator intent (active, then closed), not by the Hub's shifting judgment. Each commitment
 * carries just enough judgment to grasp without opening: a criteria-and-evidence read, never a
 * task-derived percentage. This is a review of every commitment, distinct from the Dashboard's
 * "where do I act" briefing.
 */
export default async function ObjectivesPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const objectives = await withTenant(ctx, (tx) => listObjectives(tx, ctx));

  const assessed = objectives.map((o) => ({
    o,
    a: assessObjective({
      status: o.status,
      criteria: o.successCriteria,
      taskTotal: o.progress.tasksTotal,
      workItemTotal: o.workItemTotal,
    }),
  }));
  const active = assessed.filter(({ o }) => o.status === 'active' || o.status === 'draft');
  const closed = assessed.filter(({ o }) => o.status === 'completed' || o.status === 'cancelled');

  const advancing = active.filter(({ a }) => a.state === 'advancing' || a.state === 'ready-to-close').length;
  const noEvidence = active.filter(({ a }) => a.state === 'effort-only' || a.state === 'insufficient').length;
  const shape: string[] = [];
  if (advancing > 0) shape.push(`${advancing} advancing on evidence`);
  if (noEvidence > 0) shape.push(`${noEvidence} without outcome evidence yet`);
  const verdict =
    active.length === 0
      ? 'No active commitments yet.'
      : `${active.length} active ${active.length === 1 ? 'commitment' : 'commitments'}${
          shape.length ? ` — ${shape.join(', ')}` : ''
        }.${closed.length > 0 ? ` ${closed.length} closed.` : ''}`;

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
                  <Row key={o.id} projectKey={projectKey} o={o} a={a} />
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

function Row({
  projectKey,
  o,
  a,
}: {
  projectKey: string;
  o: { id: string; title: string; status: string; accountableEmployee: string | null };
  a: { headline: string; outcomeSummary: string; confidence: string | null };
}) {
  return (
    <Link href={`/p/${projectKey}/objectives/${o.id}`} className="block py-3.5 hover:opacity-95">
      <div className="flex items-baseline gap-3">
        <span className="text-base font-medium text-[var(--foreground)]">{o.title}</span>
        <StatusBadge status={o.status} />
        {o.accountableEmployee ? (
          <span className="ml-auto text-xs text-[var(--muted)]">{o.accountableEmployee}</span>
        ) : null}
      </div>
      <p className="mt-1 text-sm text-[var(--muted)]">{a.headline}</p>
      <p className="mt-1 text-xs text-[var(--muted)]">
        {a.outcomeSummary}
        {a.confidence ? ` · ${a.confidence}` : ''}
      </p>
    </Link>
  );
}
