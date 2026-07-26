import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getWorkItem } from '@/domain/work/work-items';
import { assessWorkItem, CONDITION_LABEL } from '@/domain/execution/assess';
import { listEmployees } from '@/domain/agents/org';
import { NotFoundError } from '@/lib/errors';
import { Card, PageHeader } from '@/components/ui';
import { WorkFrame } from '../../work-frame';
import { WorkItemRow } from '../work-item-row';
import { Breadcrumb } from '../../breadcrumb';

/**
 * Canonical Work Item detail (Execution 2c). Opens with the shared operator frame, then the
 * human-specific detail. Editable and coordination-oriented while active; a frozen, read-only
 * closure record once terminal.
 */
export default async function WorkItemDetailPage({
  params,
}: {
  params: Promise<{ projectKey: string; workItemId: string }>;
}) {
  const { projectKey, workItemId } = await params;
  const ctx = await requireTenant(projectKey);
  const canEdit = ctx.projectRole !== 'viewer';

  let w;
  let employees;
  try {
    ({ w, employees } = await withTenant(ctx, async (tx) => ({
      w: await getWorkItem(tx, ctx, workItemId),
      employees: await listEmployees(tx, ctx),
    })));
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const now = new Date();
  const assessment = assessWorkItem({ condition: w.condition, waitingOn: w.waitingOn, ownerAgentId: w.ownerAgentId, updatedAt: w.updatedAt, now });
  const terminal = w.condition === 'finished' || w.condition === 'stopped';
  const ownerOptions = employees.map((e) => ({ id: e.id, name: e.name, title: e.title }));

  return (
    <div className="mx-auto max-w-3xl">
      <Breadcrumb leaf={w.title} />
      <PageHeader
        title={w.title}
        subtitle={w.objectiveTitle ? `Toward ${w.objectiveTitle}` : 'Operational — not tied to an objective'}
        action={<span className="text-sm text-[var(--muted)]">{w.condition ? CONDITION_LABEL[w.condition] : 'Unknown'}</span>}
      />

      <WorkFrame
        kind="work_item"
        purpose={w.objectiveTitle}
        assessment={assessment}
        accountable={w.ownerName}
        performer={null}
        recent={`last update ${w.updatedAt.toISOString().slice(0, 10)}`}
      />

      {terminal ? (
        <Card title="Closure record" className="mb-6">
          <p className="text-sm">
            {w.condition === 'stopped' ? 'Stopped' : 'Finished'}
            {w.closedByName ? ` by ${w.closedByName}` : ''}
            {w.closedAt ? ` on ${w.closedAt.toISOString().slice(0, 10)}` : ''}.
          </p>
          {w.closureReason ? (
            <p className="mt-2 text-sm">
              <span className="text-[var(--muted)]">{w.condition === 'stopped' ? 'Reason: ' : 'Note: '}</span>
              {w.closureReason}
            </p>
          ) : null}
          {w.notes ? <p className="mt-3 whitespace-pre-wrap text-sm text-[var(--muted)]">{w.notes}</p> : null}
          <p className="mt-3 text-xs text-[var(--muted)]">
            This record is frozen. Full history is in the{' '}
            <Link href={`/p/${projectKey}/audit`} className="text-[var(--accent)]">
              audit log
            </Link>
            .
          </p>
        </Card>
      ) : (
        <ul>
          <WorkItemRow
            projectKey={projectKey}
            item={{
              id: w.id,
              title: w.title,
              condition: w.condition,
              waitingOn: w.waitingOn,
              stage: w.stage,
              notes: w.notes,
              ownerAgentId: w.ownerAgentId,
              ownerName: w.ownerName,
              objectiveTitle: w.objectiveTitle,
            }}
            employees={ownerOptions}
            canEdit={canEdit}
          />
        </ul>
      )}
    </div>
  );
}
