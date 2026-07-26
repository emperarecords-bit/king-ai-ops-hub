import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listAgents } from '@/domain/agents/agents';
import { listDepartments, listEmployees } from '@/domain/agents/org';
import { employeeStats } from '@/domain/agents/stats';
import { modelsForProvider } from '@/providers/pricing';
import { formatMoney } from '@/lib/money';
import { type ProviderId } from '@/types/provider';
import { Card, PageHeader, ProviderBadge } from '@/components/ui';
import { AgentForm } from './agent-form';
import { EmployeeOrgForm } from './employee-org-form';

/**
 * Employees (Sprint 4 P2 + Org Slice 1). The workforce view: who works here, who
 * they report to, what they own, what they've done. "Role before person" — every
 * employee has a title, a department, and a manager. AI configuration lives
 * behind "Configure AI" — diagnostics, not the product.
 */
export default async function EmployeesPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const canEdit = ctx.projectRole === 'admin';
  const { agents, stats, employees, departments } = await withTenant(ctx, async (tx) => ({
    agents: await listAgents(tx, ctx),
    stats: await employeeStats(tx, ctx),
    employees: await listEmployees(tx, ctx),
    departments: await listDepartments(tx, ctx),
  }));

  const orgById = new Map(employees.map((e) => [e.id, e]));
  const pickerEmployees = employees.map((e) => ({ id: e.id, name: e.name }));

  // Group by department for the org-chart feel (uses the org record's department).
  const byDepartment = new Map<string, typeof agents>();
  for (const agent of agents) {
    const dept = orgById.get(agent.id)?.departmentName ?? 'Unassigned';
    if (!byDepartment.has(dept)) byDepartment.set(dept, []);
    byDepartment.get(dept)!.push(agent);
  }

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle="Your organization for this workspace — who works here, who they report to, and what they own."
      />

      {canEdit ? (
        <Card className="mb-8">
          <h2 className="mb-3 text-sm font-semibold">Add an employee</h2>
          <EmployeeOrgForm projectKey={projectKey} mode="create" departments={departments} employees={pickerEmployees} />
        </Card>
      ) : null}

      <div className="space-y-8">
        {[...byDepartment.entries()].map(([dept, members]) => (
          <section key={dept}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
              {dept} <span className="font-normal">· {members.length}</span>
            </h2>
            <div className="grid gap-4 lg:grid-cols-2">
              {members.map((agent) => {
                const s = stats.get(agent.id);
                const org = orgById.get(agent.id);
                const intervention =
                  s && s.reviewsGiven > 0 ? Math.round((s.interventions / s.reviewsGiven) * 100) : null;
                return (
                  <Card key={agent.id}>
                    <div className="mb-1 flex flex-wrap items-center gap-3">
                      <h3 className="font-semibold">{agent.name}</h3>
                      {org?.title ? (
                        <span className="rounded bg-[var(--surface-raised)] px-2 py-0.5 text-xs text-[var(--foreground)]">
                          {org.title}
                        </span>
                      ) : null}
                      {s && s.activeRuns > 0 ? (
                        <span className="rounded bg-[#3a3420] px-2 py-0.5 text-xs text-[var(--accent-strong)]">
                          working now
                        </span>
                      ) : null}
                      {org && !org.enabled ? (
                        <span className="text-xs text-[var(--danger)]">on leave (disabled)</span>
                      ) : null}
                    </div>
                    <p className="mb-3 text-xs text-[var(--muted)]">
                      {org?.managerName ? `Reports to ${org.managerName}` : 'Reports to nobody'}
                    </p>

                    <dl className="mb-3 grid grid-cols-3 gap-2 text-sm">
                      <div>
                        <dt className="text-xs text-[var(--muted)]">Work done</dt>
                        <dd className="font-semibold">{s?.workDone ?? 0}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-[var(--muted)]">Review impact</dt>
                        <dd className="font-semibold">
                          {intervention == null ? '—' : `${intervention}%`}
                          {s && s.reviewsGiven > 0 ? (
                            <span className="ml-1 text-xs font-normal text-[var(--muted)]">of {s.reviewsGiven}</span>
                          ) : null}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-[var(--muted)]">Cost</dt>
                        <dd className="font-semibold">{formatMoney({ usdMicros: s?.costMicros ?? 0n })}</dd>
                      </div>
                    </dl>

                    {s && s.accountableObjectives.length > 0 ? (
                      <p className="mb-3 text-xs text-[var(--muted)]">
                        Owns objectives: {s.accountableObjectives.join(' · ')}
                      </p>
                    ) : null}

                    {canEdit ? (
                      <details className="mb-2">
                        <summary className="cursor-pointer text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                          Edit details
                        </summary>
                        <div className="mt-3">
                          <EmployeeOrgForm
                            projectKey={projectKey}
                            mode="edit"
                            employee={
                              org ?? {
                                id: agent.id,
                                name: agent.name,
                                title: null,
                                departmentId: null,
                                reportsToId: null,
                                enabled: agent.enabled,
                              }
                            }
                            departments={departments}
                            employees={pickerEmployees}
                          />
                        </div>
                      </details>
                    ) : null}

                    <details>
                      <summary className="cursor-pointer text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                        Configure AI <ProviderBadge provider={agent.provider} />
                      </summary>
                      <div className="mt-3">
                        <AgentForm
                          projectKey={projectKey}
                          agent={agent}
                          models={modelsForProvider(agent.provider as ProviderId)}
                        />
                      </div>
                    </details>
                  </Card>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
