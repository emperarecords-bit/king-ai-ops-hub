import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getWorkspaceSettings } from '@/domain/projects/settings';
import { listEmployees } from '@/domain/agents/org';
import { Card, PageHeader } from '@/components/ui';
import { ArchiveWorkspaceButton, WorkspaceSettingsForm } from './settings-forms';
import { OwnerPicker } from '../owner-picker';

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const { settings, employees } = await withTenant(ctx, async (tx) => ({
    settings: await getWorkspaceSettings(tx, ctx),
    employees: await listEmployees(tx, ctx),
  }));
  const isAdmin = ctx.projectRole === 'admin';
  const ownerOptions = employees.map((e) => ({ id: e.id, name: e.name, title: e.title }));
  const ownerName = settings.ownerAgentId
    ? (employees.find((e) => e.id === settings.ownerAgentId)?.name ?? null)
    : null;

  return (
    <div>
      <PageHeader
        title="Workspace settings"
        subtitle="Name, description, and budget. Changes are recorded in the audit log."
      />

      {!isAdmin ? (
        <Card className="mb-6">
          <p className="text-sm text-[var(--muted)]">
            Only workspace admins can change these settings.
          </p>
        </Card>
      ) : (
        <Card title="Details" className="mb-6">
          <WorkspaceSettingsForm
            projectKey={projectKey}
            name={settings.name}
            description={settings.description}
            monthlyBudgetUsd={String(Number(settings.monthlyBudgetMicros) / 1_000_000)}
          />
        </Card>
      )}

      <Card title="Owner" className="mb-6">
        <p className="mb-3 text-sm text-[var(--muted)]">
          Which employee owns this workspace. Descriptive only — naming an owner records
          accountability; it does not change permissions or route any work.
        </p>
        {isAdmin ? (
          <OwnerPicker
            projectKey={projectKey}
            object="project"
            objectId={ctx.projectId}
            ownerAgentId={settings.ownerAgentId}
            employees={ownerOptions}
            revalidate={`/p/${projectKey}/settings`}
          />
        ) : (
          <p className="text-sm">{ownerName ?? 'Unassigned'}</p>
        )}
      </Card>

      <Card title="Workspace address" className="mb-6">
        <p className="font-mono text-sm">{settings.key}</p>
        <p className="mt-2 text-sm text-[var(--muted)]">
          This cannot change. It appears in every link and in every audit record, so renaming it
          would break existing links and make past records point at a name that no longer exists.
          The workspace name above is what people read; this is what the system uses.
        </p>
      </Card>

      {isAdmin ? (
        <Card title={settings.archived ? 'Archived' : 'Archive'}>
          <p className="mb-3 text-sm text-[var(--muted)]">
            {settings.archived
              ? 'This workspace is archived: it stays out of the picker and the briefing, and its history is intact. Restore it to use it again.'
              : 'Archiving hides this workspace from the picker and the briefing. Nothing is deleted — its work, costs, and audit history stay exactly as they are, and you can restore it at any time.'}
          </p>
          <ArchiveWorkspaceButton projectKey={projectKey} archived={settings.archived} />
        </Card>
      ) : null}
    </div>
  );
}
