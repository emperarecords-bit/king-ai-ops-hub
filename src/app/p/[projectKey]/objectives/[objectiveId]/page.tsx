import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getObjective } from '@/domain/objectives/objectives';
import { assessObjective, describeEvidence } from '@/domain/objectives/assess';
import { listAssignableEmployees } from '@/domain/agents/agents';
import { listSchedules } from '@/domain/standing/standing';
import { NotFoundError } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import {
  AddCriterionForm,
  AddMilestoneForm,
  CriterionButtons,
  CriterionEditor,
  MilestoneStatusButton,
  ObjectiveDetailsEditor,
  ObjectiveStatusButtons,
} from './mutation-forms';
import { AddStandingWorkForm, ToggleScheduleButton } from './standing-forms';
import { OwnerPicker } from '../../owner-picker';
import { Breadcrumb } from '../../breadcrumb';
import { ReasoningPanel } from '../../reasoning-panel';

const CADENCE_LABEL: Record<string, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
};

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
  let schedules;
  let employees;
  try {
    ({ o, schedules, employees } = await withTenant(ctx, async (tx) => ({
      o: await getObjective(tx, ctx, objectiveId),
      schedules: await listSchedules(tx, ctx, objectiveId),
      employees: await listAssignableEmployees(tx, ctx),
    })));
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const open = o.status === 'draft' || o.status === 'active';
  const isAdmin = ctx.projectRole === 'admin';
  const ownerOptions = employees.map((e) => ({ id: e.id, name: e.name, title: null }));
  const assessment = assessObjective({
    status: o.status,
    criteria: o.successCriteria,
    taskTotal: o.tasks.length,
    workItemTotal: o.workItems.length,
  });

  return (
    <div>
      <Breadcrumb leaf={o.title} />
      <PageHeader
        title={o.title}
        subtitle={[
          o.sponsoringDepartment ? `Sponsored by ${o.sponsoringDepartment}` : null,
          `created ${o.createdAt.toISOString().slice(0, 10)}`,
        ]
          .filter(Boolean)
          .join(' · ')}
        action={<StatusBadge status={o.status} />}
      />

      <div className="mb-6 flex items-center gap-2 text-sm">
        <span className="text-[var(--muted)]">Owner:</span>
        {isAdmin ? (
          <OwnerPicker
            projectKey={projectKey}
            object="objective"
            objectId={o.id}
            ownerAgentId={o.accountableAgentId}
            employees={ownerOptions}
            revalidate={`/p/${projectKey}/objectives/${o.id}`}
          />
        ) : (
          <span>{o.accountableEmployee ?? 'Unassigned'}</span>
        )}
      </div>

      {o.description || open ? (
        <Card title="Why it matters" className="mb-6">
          <div className="flex items-start justify-between gap-4">
            <p className="whitespace-pre-wrap text-sm">
              {o.description || <span className="text-[var(--muted)]">No description.</span>}
            </p>
            {open ? (
              <ObjectiveDetailsEditor
                projectKey={projectKey}
                objectiveId={o.id}
                title={o.title}
                description={o.description}
              />
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* The success contract — the authoritative definition of the outcome, above the work. */}
      <Card title="How we'll know it succeeded" className="mb-6">
        {o.successCriteria.length === 0 ? (
          <EmptyState>
            No success criteria yet. An objective needs at least one to activate — add one below.
          </EmptyState>
        ) : (
          <ul className="space-y-2">
            {o.successCriteria.map((c, i) => {
              const src = describeEvidence(c, c.verifiedBy ? (o.verifierNames[c.verifiedBy] ?? null) : null);
              return (
                <li
                  key={i}
                  className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm ${CRITERION_STYLE[c.status] ?? ''}`}
                >
                  <div>
                    <span className="font-medium">{c.label}</span>
                    <span className="ml-2 text-xs text-[var(--muted)]">
                      target {c.target} {c.unit}
                    </span>
                    <span className="ml-2">
                      <StatusBadge status={c.status} />
                    </span>
                    {src ? (
                      <span className="ml-2 text-xs text-[var(--muted)]">· {src}</span>
                    ) : (
                      <span className="ml-2 text-xs text-[var(--muted)]">· not yet evidenced</span>
                    )}
                  </div>
                  {open ? (
                    <div className="flex items-center gap-2">
                      <CriterionButtons projectKey={projectKey} objectiveId={o.id} index={i} status={c.status} />
                      <CriterionEditor
                        projectKey={projectKey}
                        objectiveId={o.id}
                        index={i}
                        label={c.label}
                        target={c.target}
                        unit={c.unit}
                        canRemove={o.status !== 'active' || o.successCriteria.length > 1}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {open ? <AddCriterionForm projectKey={projectKey} objectiveId={o.id} /> : null}
      </Card>

      {/* The Hub's read — judgment from evidence, never from activity. */}
      <Card title="The Hub's read" className="mb-6">
        <p className="text-[15px] leading-relaxed text-[var(--foreground)]">{assessment.headline}</p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          {assessment.outcomeSummary}
          {assessment.confidence ? ` · ${assessment.confidence}` : ''}
        </p>
        {assessment.reasoning ? <ReasoningPanel reasoning={assessment.reasoning} /> : null}
      </Card>

      {!open ? (
        <Card title="Closure record" className="mb-6">
          <p className="text-sm">
            {o.status === 'completed' ? 'Completed' : 'Cancelled'}
            {o.closedByName ? ` by ${o.closedByName}` : ''}
            {o.closedAt ? ` on ${o.closedAt.toISOString().slice(0, 10)}` : ''}.
          </p>
          <p className="mt-1 text-sm text-[var(--muted)]">Conditions at closure: {assessment.outcomeSummary}.</p>
          {o.closureReason ? (
            <p className="mt-2 text-sm">
              <span className="text-[var(--muted)]">
                {o.status === 'cancelled' ? 'Reason: ' : 'Caveat: '}
              </span>
              {o.closureReason}
            </p>
          ) : o.status === 'cancelled' ? (
            <p className="mt-2 text-xs text-[var(--muted)]">No reason recorded (cancelled before reasons were required).</p>
          ) : null}
          <p className="mt-2 text-xs text-[var(--muted)]">
            Full history is in the{' '}
            <Link href={`/p/${projectKey}/audit`} className="text-[var(--accent)]">
              audit log
            </Link>
            .
          </p>
        </Card>
      ) : null}

      <Card title="Milestones" className="mb-6">
        {o.milestones.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No milestones yet. Milestones are checkpoints on the path — not fractions of success.
          </p>
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

      <Card title="Standing work" className="mb-6">
        {schedules.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            Nothing recurring yet. Standing work keeps producing toward this objective while you&apos;re
            away — every result still cross-checked, budgeted, and gated by your approval.
          </p>
        ) : (
          <ul className="space-y-2">
            {schedules.map((s) => (
              <li
                key={s.id}
                className="flex items-center justify-between gap-3 rounded-md border border-[var(--border)] p-3 text-sm"
              >
                <div>
                  <span className={`font-medium ${s.enabled ? '' : 'text-[var(--muted)] line-through'}`}>
                    {s.title}
                  </span>
                  <span className="ml-2 text-xs text-[var(--muted)]">
                    {CADENCE_LABEL[s.cadence] ?? s.cadence} ·{' '}
                    {s.enabled
                      ? `next ${s.nextRunAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`
                      : 'paused'}
                    {s.producedCount > 0
                      ? ` · ${s.producedCount} produced for ${formatMoney({ usdMicros: s.spentMicros })}`
                      : ' · never run'}
                  </span>
                </div>
                {open ? (
                  <ToggleScheduleButton
                    projectKey={projectKey}
                    objectiveId={o.id}
                    scheduleId={s.id}
                    enabled={s.enabled}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {open && employees.length > 0 ? (
          <AddStandingWorkForm
            projectKey={projectKey}
            objectiveId={o.id}
            employees={employees.map((e) => ({
              id: e.id,
              name: e.departmentName ? `${e.name} (${e.departmentName})` : e.name,
            }))}
          />
        ) : null}
      </Card>

      {/* Work contributing — human and AI effort together, subordinate to the contract. */}
      <Card title="Work contributing" className="mb-6">
        <p className="mb-3 text-xs text-[var(--muted)]">{assessment.work}</p>
        {o.tasks.length === 0 && o.workItems.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No work recorded yet.</p>
        ) : (
          <ul className="space-y-1">
            {o.tasks.map((t) => (
              <li key={t.id}>
                <Link
                  href={`/p/${projectKey}/tasks/${t.id}`}
                  className="flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-[var(--surface-raised)]"
                >
                  <span>
                    <span className="mr-2 text-xs uppercase text-[var(--muted)]">AI</span>
                    {t.title}
                  </span>
                  <StatusBadge status={t.status} />
                </Link>
              </li>
            ))}
            {o.workItems.map((w) => (
              <li key={w.id}>
                <Link
                  href={`/p/${projectKey}/work`}
                  className="flex items-center justify-between rounded-md px-3 py-2 text-sm hover:bg-[var(--surface-raised)]"
                >
                  <span>
                    <span className="mr-2 text-xs uppercase text-[var(--muted)]">Human</span>
                    {w.title}
                  </span>
                  <span className="text-xs text-[var(--muted)]">{w.stage}</span>
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
            + Assign AI work toward this objective
          </Link>
        ) : null}
      </Card>

      <ObjectiveStatusButtons projectKey={projectKey} objectiveId={o.id} status={o.status} />
    </div>
  );
}
