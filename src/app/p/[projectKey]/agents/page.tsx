import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listAgents } from '@/domain/agents/agents';
import { employeeStats } from '@/domain/agents/stats';
import { modelsForProvider } from '@/providers/pricing';
import { formatMoney } from '@/lib/money';
import { type ProviderId } from '@/types/provider';
import { Card, PageHeader, ProviderBadge } from '@/components/ui';
import { AgentForm } from './agent-form';

/**
 * Employees (Sprint 4 P2). The workforce view: who works here, what they've
 * done, what it cost. Model/provider configuration still exists but lives
 * behind "Configure" — diagnostics, not the product (P5).
 */
export default async function EmployeesPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const { agents, stats } = await withTenant(ctx, async (tx) => ({
    agents: await listAgents(tx, ctx),
    stats: await employeeStats(tx, ctx),
  }));

  // Group by department for the org-chart feel.
  const byDepartment = new Map<string, typeof agents>();
  for (const agent of agents) {
    const dept = stats.get(agent.id)?.departmentName ?? 'Unassigned';
    if (!byDepartment.has(dept)) byDepartment.set(dept, []);
    byDepartment.get(dept)!.push(agent);
  }

  return (
    <div>
      <PageHeader
        title="Employees"
        subtitle="Your AI workforce for this workspace, organized by department. Numbers are for the current period."
      />
      <div className="space-y-8">
        {[...byDepartment.entries()].map(([dept, members]) => (
          <section key={dept}>
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-[var(--muted)]">
              {dept} <span className="font-normal">· {members.length}</span>
            </h2>
            <div className="grid gap-4 lg:grid-cols-2">
              {members.map((agent) => {
                const s = stats.get(agent.id);
                const intervention =
                  s && s.reviewsGiven > 0
                    ? Math.round((s.interventions / s.reviewsGiven) * 100)
                    : null;
                return (
                  <Card key={agent.id}>
                    <div className="mb-2 flex items-center gap-3">
                      <h3 className="font-semibold">{agent.name}</h3>
                      <span className="rounded bg-[var(--surface-raised)] px-2 py-0.5 text-xs capitalize text-[var(--muted)]">
                        {agent.role}
                      </span>
                      {s && s.activeRuns > 0 ? (
                        <span className="rounded bg-[#3a3420] px-2 py-0.5 text-xs text-[var(--accent-strong)]">
                          working now
                        </span>
                      ) : null}
                      {!agent.enabled ? (
                        <span className="text-xs text-[var(--danger)]">on leave (disabled)</span>
                      ) : null}
                    </div>

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
                            <span className="ml-1 text-xs font-normal text-[var(--muted)]">
                              of {s.reviewsGiven}
                            </span>
                          ) : null}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-[var(--muted)]">Cost</dt>
                        <dd className="font-semibold">
                          {formatMoney({ usdMicros: s?.costMicros ?? 0n })}
                        </dd>
                      </div>
                    </dl>

                    {s && s.accountableObjectives.length > 0 ? (
                      <p className="mb-3 text-xs text-[var(--muted)]">
                        Accountable for: {s.accountableObjectives.join(' · ')}
                      </p>
                    ) : null}

                    <details>
                      <summary className="cursor-pointer text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                        Configure <ProviderBadge provider={agent.provider} />
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
