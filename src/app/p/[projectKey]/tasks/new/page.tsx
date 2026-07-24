import { requireTenant } from '@/domain/auth/guard';
import { Card, PageHeader } from '@/components/ui';
import { TaskForm } from './task-form';

export default async function NewTaskPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  await requireTenant(projectKey);

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="New task"
        subtitle="The task is created first; you start the run from the task page. Any consequential action the models propose lands in the approval queue — nothing executes on its own."
      />
      <Card>
        <TaskForm projectKey={projectKey} />
      </Card>
    </div>
  );
}
