import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listWorkItems } from '@/domain/work/work-items';
import { listEmployees } from '@/domain/agents/org';
import { listObjectives } from '@/domain/objectives/objectives';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { CreateWorkItemForm } from './work-item-form';
import { WorkItemRow } from './work-item-row';

/**
 * Work — human-owned tracking items (Slice 1 follow-up). The counterpart to
 * Tasks (AI executions): a place to track human work — conversations, deals,
 * follow-ups — that a person owns and advances by hand through their own
 * stages. No AI run, no cost. Descriptive only.
 */
export default async function WorkPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const canEdit = ctx.projectRole !== 'viewer';

  const { items, employees, objectives } = await withTenant(ctx, async (tx) => ({
    items: await listWorkItems(tx, ctx),
    employees: await listEmployees(tx, ctx),
    objectives: await listObjectives(tx, ctx),
  }));

  const ownerOptions = employees.map((e) => ({ id: e.id, name: e.name, title: e.title }));
  const objectiveOptions = objectives.map((o) => ({ id: o.id, title: o.title }));

  return (
    <div>
      <PageHeader
        title="Work"
        subtitle="Human work you own and advance by hand — conversations, deals, follow-ups. Unlike a task, a work item runs no AI and costs nothing; you move it through your own stages."
      />

      {canEdit ? (
        <Card title="Add a work item" className="mb-6">
          <CreateWorkItemForm projectKey={projectKey} objectives={objectiveOptions} />
        </Card>
      ) : null}

      <Card title={`Work items (${items.length})`}>
        {items.length === 0 ? (
          <EmptyState>No work items yet.</EmptyState>
        ) : (
          <ul>
            {items.map((it) => (
              <WorkItemRow
                key={it.id}
                projectKey={projectKey}
                item={{
                  id: it.id,
                  title: it.title,
                  stage: it.stage,
                  notes: it.notes,
                  ownerAgentId: it.ownerAgentId,
                  ownerName: it.ownerName,
                  objectiveTitle: it.objectiveTitle,
                }}
                employees={ownerOptions}
                canEdit={canEdit}
              />
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
