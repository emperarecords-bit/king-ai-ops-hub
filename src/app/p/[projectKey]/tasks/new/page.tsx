import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listObjectives } from '@/domain/objectives/objectives';
import { Card, PageHeader } from '@/components/ui';
import { TaskForm } from './task-form';

export default async function NewTaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<{ objective?: string }>;
}) {
  const { projectKey } = await params;
  const { objective } = await searchParams;
  const ctx = await requireTenant(projectKey);

  const objectives = await withTenant(ctx, (tx) => listObjectives(tx, ctx));
  const openObjectives = objectives
    .filter((o) => o.status === 'active' || o.status === 'draft')
    .map((o) => ({ id: o.id, title: o.title }));

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="New task"
        subtitle="The task is created first; you start the run from the task page. Any consequential action the models propose lands in the approval queue — nothing executes on its own."
      />
      <Card>
        <TaskForm
          projectKey={projectKey}
          objectives={openObjectives}
          preselectedObjectiveId={
            openObjectives.some((o) => o.id === objective) ? objective! : null
          }
        />
      </Card>
    </div>
  );
}
