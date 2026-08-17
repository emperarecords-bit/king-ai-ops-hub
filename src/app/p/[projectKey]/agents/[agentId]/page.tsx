import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listAgents } from '@/domain/agents/agents';
import { listDepartments, listEmployees } from '@/domain/agents/org';
import { employeeAttributionDrilldown } from '@/domain/agents/attribution';
import { employeeProfile } from '@/domain/agents/profile';
import { modelsForProvider } from '@/providers/pricing';
import { formatMoney } from '@/lib/money';
import { type ProviderId } from '@/types/provider';
import { Card, PageHeader, ProviderBadge, StatusBadge } from '@/components/ui';
import { AgentForm } from '../agent-form';
import { EmployeeOrgForm } from '../employee-org-form';

/**
 * Employee Profile (owner directive 2026-08-17): everything about ONE employee in one place —
 * identity (name/title/department/manager/status), the job (AI configuration + full mission),
 * WHAT THIS EMPLOYEE KNOWS (the workspace information that actually reaches their runs), and
 * their track record. Editing reuses the exact admin-gated forms and actions the Employees page
 * already trusts — this page adds visibility, never a new mutation path.
 */
export default async function EmployeeProfilePage({
  params,
}: {
  params: Promise<{ projectKey: string; agentId: string }>;
}) {
  const { projectKey, agentId } = await params;
  const ctx = await requireTenant(projectKey);
  const canEdit = ctx.projectRole === 'admin';

  const data = await withTenant(ctx, async (tx) => {
    const agent = (await listAgents(tx, ctx)).find((a) => a.id === agentId);
    if (!agent) return null;
    const employees = await listEmployees(tx, ctx);
    return {
      agent,
      employee: employees.find((e) => e.id === agentId) ?? null,
      employees,
      departments: await listDepartments(tx, ctx),
      profile: await employeeProfile(tx, ctx, agentId),
      drilldown: await employeeAttributionDrilldown(tx, ctx, agentId),
    };
  });
  if (!data || !data.employee) notFound();
  const { agent, employee, employees, departments, profile, drilldown } = data;

  const money = (m: bigint): string => formatMoney({ usdMicros: m });
  const canTalk = agent.enabled && agent.role === 'primary';

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={employee.name}
        subtitle={[
          employee.title || (agent.role === 'reviewer' ? 'Reviewer' : 'Employee'),
          employee.departmentName ?? null,
          profile.isGeneralManager ? 'General Manager of this workspace' : null,
          employee.enabled ? null : 'DORMANT',
        ]
          .filter(Boolean)
          .join(' · ')}
        action={
          <div className="flex items-center gap-2">
            {canTalk ? (
              <>
                <Link href={`/p/${projectKey}/agents/${agentId}/talk`} className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2,#222)]">
                  🎤 Talk
                </Link>
                <Link href={`/p/${projectKey}/agents/${agentId}/chat`} className="rounded border border-[var(--border)] px-3 py-1.5 text-sm hover:bg-[var(--surface-2,#222)]">
                  ⌨️ Chat
                </Link>
              </>
            ) : null}
            <Link href={`/p/${projectKey}/agents`} className="text-sm text-[var(--muted)] underline">
              All employees
            </Link>
          </div>
        }
      />

      <div className="space-y-5">
        <Card title="Identity">
          {canEdit ? (
            <EmployeeOrgForm
              projectKey={projectKey}
              mode="edit"
              employee={employee}
              departments={departments}
              employees={employees}
            />
          ) : (
            <p className="text-sm text-[var(--muted)]">
              Reports to {employee.managerName ?? 'nobody'} · {employee.enabled ? 'active' : 'dormant'}
            </p>
          )}
        </Card>

        <Card title="The job — AI configuration and mission">
          <div className="mb-3 flex items-center gap-2 text-sm">
            <ProviderBadge provider={agent.provider} />
            <span className="text-[var(--muted)]">{agent.model}</span>
          </div>
          {canEdit ? (
            <AgentForm projectKey={projectKey} agent={agent} models={modelsForProvider(agent.provider as ProviderId)} />
          ) : (
            <pre className="whitespace-pre-wrap text-sm text-[var(--muted)]">{agent.systemPrompt}</pre>
          )}
        </Card>

        <Card title="What this employee knows">
          <p className="mb-3 text-sm text-[var(--muted)]">
            Every run this employee performs automatically carries: the workspace charter and operating
            priorities, the active knowledge below, relevant document content, and the shared repository
            files below.
            {profile.isGeneralManager
              ? ' As General Manager they ALSO receive the live team briefing (their team’s recent work) and the delegation contract.'
              : ''}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase text-[var(--muted)]">
                Active knowledge ({profile.knowledge.activeCount})
              </h3>
              {profile.knowledge.titles.length > 0 ? (
                <ul className="list-inside list-disc text-sm">
                  {profile.knowledge.titles.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[var(--danger)]">
                  None — this employee is working blind. Add knowledge to ground them.
                </p>
              )}
              <Link href={`/p/${projectKey}/knowledge`} className="mt-1 inline-block text-xs underline">
                Manage knowledge
              </Link>
            </div>
            <div>
              <h3 className="mb-1 text-xs font-semibold uppercase text-[var(--muted)]">
                Shared repository files ({profile.sharedContext.approvedCount}) · Documents ({profile.documentsCount})
              </h3>
              {profile.sharedContext.titles.length > 0 ? (
                <ul className="list-inside list-disc text-sm">
                  {profile.sharedContext.titles.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-[var(--muted)]">No repository files shared yet.</p>
              )}
              <Link href={`/p/${projectKey}/documents`} className="mt-1 inline-block text-xs underline">
                Manage documents
              </Link>
            </div>
          </div>
        </Card>

        <Card title="Track record">
          <p className="mb-3 text-sm text-[var(--muted)]">
            Lifetime execution spend: {money(drilldown.performedExecutionTotal)}
            {agent.role === 'reviewer' ? ` · review spend: ${money(drilldown.reviewedTotal)}` : ''}
          </p>
          {profile.recentTasks.length > 0 ? (
            <table className="w-full text-sm">
              <tbody>
                {profile.recentTasks.map((t) => (
                  <tr key={t.id} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-3">
                      <Link href={`/p/${projectKey}/tasks/${t.id}`} className="hover:underline">
                        {t.title}
                      </Link>
                      {t.isChat ? <span className="ml-2 text-xs text-[var(--muted)]">(chat)</span> : null}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      <StatusBadge status={t.status} />
                    </td>
                    <td className="py-1.5 text-right text-xs text-[var(--muted)]">
                      {t.updatedAt.toISOString().slice(0, 10)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-[var(--muted)]">No work performed yet.</p>
          )}
        </Card>
      </div>
    </div>
  );
}
