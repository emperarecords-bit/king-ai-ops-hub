import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listObjectives } from '@/domain/objectives/objectives';
import { Card, EmptyState, PageHeader, ProgressBar, StatusBadge } from '@/components/ui';

export default async function ObjectivesPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const objectives = await withTenant(ctx, (tx) => listObjectives(tx, ctx));

  const active = objectives.filter((o) => o.status === 'active' || o.status === 'draft');
  const closed = objectives.filter((o) => o.status === 'completed' || o.status === 'cancelled');

  return (
    <div>
      <PageHeader
        title="Objectives"
        subtitle="What this workspace is trying to achieve. Objectives complete only when every success criterion is met or explicitly waived."
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
          No objectives yet. Define what you&apos;re trying to achieve, then assign work toward it.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {[...active, ...closed].map((o) => (
            <Link key={o.id} href={`/p/${projectKey}/objectives/${o.id}`} className="block">
              <Card className="transition-colors hover:border-[var(--accent)]">
                <div className="mb-2 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <span className="text-base font-semibold">{o.title}</span>
                    <StatusBadge status={o.status} />
                  </div>
                  <span className="text-sm font-medium text-[var(--muted)]">
                    {o.progress.percent}%
                  </span>
                </div>
                <ProgressBar percent={o.progress.percent} />
                <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-xs text-[var(--muted)]">
                  <span>
                    {o.progress.tasksCompleted}/{o.progress.tasksTotal} tasks
                  </span>
                  <span>
                    {o.progress.criteriaSatisfied}/{o.progress.criteriaTotal} criteria
                  </span>
                  {o.progress.milestonesTotal > 0 ? (
                    <span>
                      {o.progress.milestonesCompleted}/{o.progress.milestonesTotal} milestones
                    </span>
                  ) : null}
                  {o.sponsoringDepartment ? <span>Dept: {o.sponsoringDepartment}</span> : null}
                  {o.accountableEmployee ? <span>Owner: {o.accountableEmployee}</span> : null}
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
