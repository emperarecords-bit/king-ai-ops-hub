import { requireUser } from '@/domain/auth/guard';
import { Card } from '@/components/ui';
import { WorkspaceForm } from './workspace-form';

export default async function NewWorkspacePage() {
  await requireUser();

  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-2xl font-bold">Create a workspace</h1>
      <p className="mb-6 mt-1 text-sm text-[var(--muted)]">
        Your workspace comes staffed: a default AI team organized by department, a monthly budget
        with a hard stop, and full isolation — nothing here is ever visible to another workspace.
      </p>
      <Card>
        <WorkspaceForm />
      </Card>
    </main>
  );
}
