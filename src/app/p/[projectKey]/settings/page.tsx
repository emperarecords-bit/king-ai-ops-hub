import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getWorkspaceSettings } from '@/domain/projects/settings';
import { Card, PageHeader } from '@/components/ui';
import { ArchiveWorkspaceButton, WorkspaceSettingsForm } from './settings-forms';

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const settings = await withTenant(ctx, (tx) => getWorkspaceSettings(tx, ctx));
  const isAdmin = ctx.projectRole === 'admin';

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
