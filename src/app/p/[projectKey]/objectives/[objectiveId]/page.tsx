import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getObjective } from '@/domain/objectives/objectives';
import { NotFoundError } from '@/lib/errors';
import { Card, EmptyState, PageHeader, ProgressBar, StatusBadge } from '@/components/ui';
import {
  AddMilestoneForm,
  CriterionButtons,
  MilestoneStatusButton,
  ObjectiveStatusButtons,
} from './mutation-forms';

const CRITERION_STYLE: Record<string, string> = {
  unmet: 'border-[var(--border)]',
  met: 'border-[#3d6b58] bg-[#1f3a2a1a]',
  waived: 'border-[#6b5a3d] bg-[#3a32201a]',
};

export default async function ObjectiveDetailPage({
  params,
}: {
  params: Promise<{ projectKey: string; objectiveId: string }>;
}) {
  const { projectKey, objectiveId } = await params;
  const ctx = await requireTenant(projectKey);

  let o;
  try {
    o = await withTenant(ctx, (tx) => getObjective(tx, ctx, objectiveId));
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const open = o.status === 'draft' || o.status === 'active';

  return (
    <div>
      <PageHeader
        title={o.title}
        subtitle={[
          o.sponsoringDepartment ? `Sponsored by ${o.sponsoringDepartment}` : null,
          o.accountableEmployee ? `accountable: ${o.accountableEmployee}` : null,
          `created ${o.createdAt.toISOString().slice(0, 10)}`,
        ]
          .filter(Boolean)
          .join(' · ')}
        action={<StatusBadge status={o.status} />}
      />

      <div className="mb-6">
        <div className="mb-1 flex items-center justify-between text-sm">
          <span className="text-[var(--muted)]">
            {o.progress.tasksCompleted}/{o.progress.tasksTotal} tasks ·{' '}
            {o.progress.criteriaSatisfied}/{o.progress.criteriaTotal} criteria
            {o.progress.milestonesTotal > 0
              ? ` · ${o.progress.milestonesCompleted}/${o.progress.milestonesTotal} milestones`
              : ''}
          </span>
          <span className="font-medium">{o.progress.percent}%</span>
        </div>
        <ProgressBar percent={o.progress.percent} />
      </div>

      {o.description ? (
        <Card className="mb-6">
          <p className="whitespace-pre-wrap text-sm">{o.description}</p>
        </Card>
      ) : null}

      <Card title="Success criteria" className="mb-6">
        {o.successCriteria.length === 0 ? (
          <EmptyState>
            No success criteria. Without them, completion is a judgment call — consider adding
            measurable ones on the next objective.
          </EmptyState>
        ) : (
          <ul className="space-y-2">
            {o.successCriteria.map((c, i) => (
              <li
                key={i}
                className={`flex items-center justify-between gap-3 rounded-md border p-3 text-sm ${CRITERION_STYLE[c.status] ?? ''}`}
              >
                <div>
                  <span className="font-medium">{c.label}</span>
                  <span className="ml-2 text-xs text-[var(--muted)]">
                    target {c.target} {c.unit}
                  </span>
                  <span className="ml-2">
                    <StatusBadge status={c.status} />
                  </span>
                </div>
                {open ? (
                  <CriterionButtons
                    projectKey={projectKey}
                    objectiveId={o.id}
                    index={i}
                    status={c.status}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Milestones" className="mb-6">
        {o.milestones.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No milestones yet.</p>
        ) : (
          <ul className="space-y-2">
            {o.milestones.map((m) => (
              <li
                key={m.id}
                className="flex items-center justify-between gap-3 rounded-md border border-[var(--border)] p-3 text-sm"
              >
                <div className="flex items-center gap-2">
                  <span className="font-medium">{m.title}</span>
                  <StatusBadge status={m.status} />
                </div>
                {open ? (
                  <MilestoneStatusButton
                    projectKey={projectKey}
                    objectiveId={o.id}
                    milestoneId={m.id}
                    status={m.status}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {open ? <AddMilestoneForm projectKey={projectKey} objectiveId={o.id} /> : null}
      </Card>

      <Card title="Work toward this objective" className="mb-6">
        {o.tasks.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No tasks assigned yet.</p>
        ) : (
          <ul className="space-y-1">
            {o.tasks.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/p/${projectKey}/tasks/${t.id}`}
                  className="flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-[var(--surface-raised)]"
                >
                  <span>{t.title}</span>
                  <StatusBadge status={t.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {open ? (
          <Link
            href={`/p/${projectKey}/tasks/new?objective=${o.id}`}
            className="mt-3 inline-block rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)]"
          >
            + Assign work toward this objective
          </Link>
        ) : null}
      </Card>

      <ObjectiveStatusButtons projectKey={projectKey} objectiveId={o.id} status={o.status} />
    </div>
  );
}
