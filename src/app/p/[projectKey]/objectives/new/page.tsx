import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listDepartments, listEmployeeOptions } from '@/domain/objectives/objectives';
import { PageHeader } from '@/components/ui';
import { ObjectiveForm } from './objective-form';

export default async function NewObjectivePage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const { departments, employees } = await withTenant(ctx, async (tx) => ({
    departments: await listDepartments(tx, ctx),
    employees: await listEmployeeOptions(tx, ctx),
  }));

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="New objective"
        subtitle="Objectives are the unit of business intent — work gets assigned toward them, and they complete only when their success criteria are satisfied."
      />
      <ObjectiveForm
        projectKey={projectKey}
        departments={departments}
        employees={employees.map((e) => ({
          id: e.id,
          name: e.departmentName ? `${e.name} (${e.departmentName})` : e.name,
        }))}
      />
    </div>
  );
}
