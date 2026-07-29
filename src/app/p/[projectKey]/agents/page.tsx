import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listAgents } from '@/domain/agents/agents';
import { listDepartments, listEmployees } from '@/domain/agents/org';
import {
  attributionReconciliation,
  employeeAttribution,
  employeeAttributionDrilldown,
  type EmployeeDrilldown,
} from '@/domain/agents/attribution';
import { modelsForProvider } from '@/providers/pricing';
import { formatMoney } from '@/lib/money';
import { type ProviderId } from '@/types/provider';
import { Card, PageHeader, ProviderBadge } from '@/components/ui';
import { visibilityFromParam } from '@/domain/classification/classification';
import { ClassificationChip, NonLiveControls } from '../non-live-controls';
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
  searchParams,
}: {
  params: Promise<{ projectKey: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { projectKey } = await params;
  const sp = await searchParams;
  const visibility = visibilityFromParam(sp.includeNonLive);
  const ctx = await requireTenant(projectKey);
  const canEdit = ctx.projectRole === 'admin';
  // HUB-009 — headline attribution is ALWAYS live-only (never recombined). When the operator opts in, a
  // SEPARATE non-live reconciliation is shown alongside; the drilldowns follow the visibility so demo/seed
  // rows can be inspected without changing the live figures.
  const { agents, attribution, reconciliation, classBreakdown, drilldowns, employees, departments } = await withTenant(ctx, async (tx) => {
    const agentList = await listAgents(tx, ctx);
    const drill = new Map<string, EmployeeDrilldown>();
    for (const a of agentList) drill.set(a.id, await employeeAttributionDrilldown(tx, ctx, a.id, visibility));
    return {
      agents: agentList,
      attribution: await employeeAttribution(tx, ctx), // headline: live-only always
      reconciliation: await attributionReconciliation(tx, ctx), // LIVE_ONLY headline
      // Separate demo + seed reconciliations, shown alongside (never merged into the live figures).
      classBreakdown: visibility.includeNonLive
        ? {
            demo: await attributionReconciliation(tx, ctx, { includeNonLive: true }, 'demo'),
            seed: await attributionReconciliation(tx, ctx, { includeNonLive: true }, 'seed'),
            demoWork: await employeeAttribution(tx, ctx, { includeNonLive: true }, 'demo'),
            seedWork: await employeeAttribution(tx, ctx, { includeNonLive: true }, 'seed'),
          }
        : null,
      drilldowns: drill,
      employees: await listEmployees(tx, ctx),
      departments: await listDepartments(tx, ctx),
    };
  });
  const sumPerformed = (m: Map<string, { performedWork: number }>) => [...m.values()].reduce((s, a) => s + a.performedWork, 0);

  const money = (m: bigint): string => formatMoney({ usdMicros: m });
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

      <NonLiveControls pathname={`/p/${projectKey}/agents`} searchParams={sp} includeNonLive={visibility.includeNonLive} />
      {classBreakdown ? (
        <div className="mb-4 grid gap-2 text-xs text-[var(--muted)] sm:grid-cols-2" data-testid="non-live-attribution">
          <p>
            <span className="font-semibold uppercase text-[#c9a769]">Demo</span> (separate, NOT in live figures):
            {' '}{sumPerformed(classBreakdown.demoWork)} performed · {money(classBreakdown.demo.totalMicros)} cost.
          </p>
          <p>
            <span className="font-semibold uppercase text-[#7fb2d1]">Seed</span> (separate, NOT in live figures):
            {' '}{sumPerformed(classBreakdown.seedWork)} performed · {money(classBreakdown.seed.totalMicros)} cost.
          </p>
        </div>
      ) : null}

      {/* Workspace cost reconciliation — employee execution + review + workspace overhead = Governance Usage. */}
      <Card title="Cost reconciliation" className="mb-8">
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <div className="text-xs text-[var(--muted)]">Employee execution</div>
            <div className="font-semibold">{money(reconciliation.employeeExecutionMicros)}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--muted)]">Employee review</div>
            <div className="font-semibold">{money(reconciliation.employeeReviewMicros)}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--muted)]">Workspace overhead</div>
            <div className="font-semibold">{money(reconciliation.workspaceOverheadMicros)}</div>
          </div>
          <div>
            <div className="text-xs text-[var(--muted)]">Governance Usage total</div>
            <div className="font-semibold">{money(reconciliation.totalMicros)}</div>
          </div>
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">
          Reconciled:{' '}
          <span className={reconciliation.reconciles ? 'text-[var(--success)]' : 'text-[var(--danger)]'}>
            {reconciliation.reconciles ? 'yes' : 'no'}
          </span>{' '}
          · exact micros {reconciliation.totalMicros.toString()} ({reconciliation.employeeExecutionMicros.toString()} +{' '}
          {reconciliation.employeeReviewMicros.toString()} + {reconciliation.workspaceOverheadMicros.toString()}).
          Reconciliation is computed in exact integer micros; the rounded dollar figures above may not visually
          sum at four decimals. Workspace overhead is spend without an employee execution attribution
          (embeddings, ingestion, extraction) — not unassigned work.
        </p>
      </Card>

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
                const m = attribution.get(agent.id);
                const d = drilldowns.get(agent.id);
                const org = orgById.get(agent.id);
                const attributedCost = (m?.executionCostMicros ?? 0n) + (m?.reviewCostMicros ?? 0n);
                return (
                  <Card key={agent.id}>
                    <div className="mb-1 flex flex-wrap items-center gap-3">
                      <h3 className="font-semibold">{agent.name}</h3>
                      {org?.title ? (
                        <span className="rounded bg-[var(--surface-raised)] px-2 py-0.5 text-xs text-[var(--foreground)]">
                          {org.title}
                        </span>
                      ) : null}
                      {/* Actual function — role + department, not an inferred system/business label. */}
                      <span className="rounded bg-[var(--surface-raised)] px-2 py-0.5 text-xs text-[var(--muted)]">
                        {m?.role ?? agent.role}
                        {m?.departmentName ? ` · ${m.departmentName}` : ''}
                      </span>
                      {org && !org.enabled ? (
                        <span className="text-xs text-[var(--danger)]">on leave (disabled)</span>
                      ) : null}
                    </div>
                    <p className="mb-3 text-xs text-[var(--muted)]">
                      {org?.managerName ? `Reports to ${org.managerName}` : 'Reports to nobody'}
                    </p>

                    {/* Five INDEPENDENT metrics — performing, owning, being accountable, and reviewing are
                        different things and are never conflated. */}
                    <dl className="mb-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
                      <div>
                        <dt className="text-xs text-[var(--muted)]">Performed work</dt>
                        <dd className="font-semibold">{m?.performedWork ?? 0}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-[var(--muted)]">Owned tasks</dt>
                        <dd className="font-semibold">{m?.ownedTasks ?? 0}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-[var(--muted)]">Objectives owned</dt>
                        <dd className="font-semibold">{m?.objectivesOwned ?? 0}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-[var(--muted)]">Review impact</dt>
                        <dd className="font-semibold">
                          {m && m.reviewImpact > 0 ? `${Math.round(m.interventionRate * 100)}%` : '—'}
                          {m && m.reviewImpact > 0 ? (
                            <span className="ml-1 text-xs font-normal text-[var(--muted)]">of {m.reviewImpact}</span>
                          ) : null}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-[var(--muted)]">Attributed cost</dt>
                        <dd className="font-semibold">{money(attributedCost)}</dd>
                      </div>
                    </dl>

                    {/* Drill-down: the exact records behind every figure (req 3). */}
                    {d && (d.performed.length || d.reviewed.length || d.ownedTasks.length || d.ownedObjectives.length) ? (
                      <details className="mb-2">
                        <summary className="cursor-pointer text-xs text-[var(--muted)] hover:text-[var(--foreground)]">
                          Show the records behind these figures
                        </summary>
                        <div className="mt-3 space-y-3 text-xs">
                          {d.performed.length ? (
                            <div>
                              <div className="font-semibold text-[var(--foreground)]">
                                Performed tasks · execution {money(d.performedExecutionTotal)}
                              </div>
                              <ul className="mt-1 space-y-0.5">
                                {d.performed.map((r) => (
                                  <li key={`p-${r.taskId}`} className="flex justify-between gap-3">
                                    <span className="flex items-center gap-1.5">
                                      <ClassificationChip classification={r.classification} />
                                      <Link href={`/p/${projectKey}/tasks/${r.taskId}`} className="text-[var(--accent)]">{r.taskTitle}</Link>
                                    </span>
                                    <span className="text-[var(--muted)]">{money(r.costMicros)} · {r.provenance === 'snapshot' ? 'snapshot' : 'legacy-derived'}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {d.reviewed.length ? (
                            <div>
                              <div className="font-semibold text-[var(--foreground)]">
                                Reviewed tasks · review {money(d.reviewedTotal)}
                              </div>
                              <ul className="mt-1 space-y-0.5">
                                {d.reviewed.map((r) => (
                                  <li key={`r-${r.taskId}`} className="flex justify-between gap-3">
                                    <Link href={`/p/${projectKey}/tasks/${r.taskId}`} className="text-[var(--accent)]">
                                      {r.taskTitle}
                                    </Link>
                                    <span className="text-[var(--muted)]">
                                      {r.verdicts.length ? r.verdicts.join(', ') + ' · ' : ''}{money(r.costMicros)}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {d.ownedTasks.length ? (
                            <div>
                              <div className="font-semibold text-[var(--foreground)]">Currently owned tasks</div>
                              <ul className="mt-1 space-y-0.5">
                                {d.ownedTasks.map((t) => (
                                  <li key={`o-${t.id}`}>
                                    <Link href={`/p/${projectKey}/tasks/${t.id}`} className="text-[var(--accent)]">
                                      {t.title}
                                    </Link>{' '}
                                    <span className="text-[var(--muted)]">· {t.status}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                          {d.ownedObjectives.length ? (
                            <div>
                              <div className="font-semibold text-[var(--foreground)]">Owned objectives</div>
                              <ul className="mt-1 space-y-0.5">
                                {d.ownedObjectives.map((o) => (
                                  <li key={`ob-${o.id}`}>
                                    <Link href={`/p/${projectKey}/objectives/${o.id}`} className="text-[var(--accent)]">
                                      {o.title}
                                    </Link>{' '}
                                    <span className="text-[var(--muted)]">· {o.status}</span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          ) : null}
                        </div>
                      </details>
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
