import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listDecisions } from '@/domain/decisions/decisions';
import { listObjectives } from '@/domain/objectives/objectives';
import { listEmployees } from '@/domain/agents/org';
import { Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui';
import { CreateDecisionForm, DecisionButtons, RetireButton } from './decision-forms';
import { OwnerPicker } from '../owner-picker';

const SCOPE_LABEL: Record<string, string> = {
  task: 'this task',
  objective: 'an objective',
  workspace: 'workspace-wide',
};

export default async function DecisionsPage({
  params,
}: {
  params: Promise<{ projectKey: string }>;
}) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const { decisions, employees, objectives } = await withTenant(ctx, async (tx) => ({
    decisions: await listDecisions(tx, ctx),
    employees: await listEmployees(tx, ctx),
    objectives: await listObjectives(tx, ctx),
  }));
  const isAdmin = ctx.projectRole === 'admin';
  const ownerOptions = employees.map((e) => ({ id: e.id, name: e.name, title: e.title }));
  const ownerName = (id: string | null) =>
    id ? (employees.find((e) => e.id === id)?.name ?? null) : null;
  const objectiveOptions = objectives.map((o) => ({ id: o.id, title: o.title }));

  const proposed = decisions.filter((d) => d.status === 'proposed');
  const accepted = decisions.filter((d) => d.status === 'accepted');
  const closed = decisions.filter((d) => d.status === 'superseded' || d.status === 'rejected' || d.status === 'retired');
  const supersedable = accepted.map((d) => ({ id: d.id, title: d.title }));
  const now = new Date();

  return (
    <div>
      <PageHeader
        title="Decision memory"
        subtitle="Approved operational and creative conclusions the organization remembers across tasks. Accepted decisions are made available to every future run in this workspace — this is organizational memory, not conversation history."
      />

      <Card title="Propose a decision" className="mb-6">
        <CreateDecisionForm projectKey={projectKey} supersedable={supersedable} objectives={objectiveOptions} />
      </Card>

      {proposed.length > 0 ? (
        <Card title={`Awaiting approval (${proposed.length})`} className="mb-6 border-[var(--accent)]">
          <ul className="space-y-3">
            {proposed.map((d) => (
              <li key={d.id} className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-sm font-medium">{d.title}</div>
                  <div className="text-sm text-[var(--muted)]">{d.summary}</div>
                  <div className="mt-1 text-xs text-[var(--muted)]">
                    {d.decisionType} · proposed by {d.authorLabel} ·{' '}
                    {d.createdAt.toISOString().slice(0, 10)}
                  </div>
                </div>
                {isAdmin ? <DecisionButtons projectKey={projectKey} decisionId={d.id} /> : null}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title={`Accepted (${accepted.length})`} className="mb-6">
        {accepted.length === 0 ? (
          <EmptyState>No accepted decisions yet.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {accepted.map((d) => (
              <li key={d.id} className="border-b border-[var(--border)] pb-3 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{d.title}</span>
                  <span className="text-xs text-[var(--muted)]">{d.decisionType}</span>
                  {/* Record vs guidance, and — for guidance — its scope and validity: the "where it applies" the memory model needs. */}
                  {d.applicability === 'record' ? (
                    <span className="rounded bg-[var(--surface-raised)] px-2 py-0.5 text-xs text-[var(--muted)]">record only</span>
                  ) : (
                    <span className="rounded bg-[#1f3a2a] px-2 py-0.5 text-xs text-[var(--success)]">
                      guides {SCOPE_LABEL[d.scope]}
                    </span>
                  )}
                  {d.effectiveUntil ? (
                    <span className={`rounded px-2 py-0.5 text-xs ${d.effectiveUntil < now ? 'bg-[#2a2a2a] text-[var(--muted)]' : 'bg-[#3a3220] text-[var(--warning,#c99a3a)]'}`}>
                      {d.effectiveUntil < now ? 'expired' : 'until'} {d.effectiveUntil.toISOString().slice(0, 10)}
                    </span>
                  ) : null}
                </div>
                <div className="mt-1 text-sm text-[var(--muted)]">{d.summary}</div>
                <div className="mt-1 text-xs text-[var(--muted)]">
                  decided by {d.authorLabel} · {d.createdAt.toISOString().slice(0, 10)}
                  {d.originatingTaskTitle ? ` · from “${d.originatingTaskTitle}”` : ''}
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                  <span className="flex items-center gap-2">
                    <span className="text-[var(--muted)]">Owner:</span>
                    {isAdmin ? (
                      <OwnerPicker
                        projectKey={projectKey}
                        object="decision"
                        objectId={d.id}
                        ownerAgentId={d.ownerAgentId}
                        employees={ownerOptions}
                        revalidate={`/p/${projectKey}/decisions`}
                      />
                    ) : (
                      <span>{ownerName(d.ownerAgentId) ?? 'Unassigned'}</span>
                    )}
                  </span>
                  {isAdmin && d.applicability === 'guidance' ? <RetireButton projectKey={projectKey} decisionId={d.id} /> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {closed.length > 0 ? (
        <Card title={`Historical (${closed.length})`}>
          <ul className="space-y-2">
            {closed.map((d) => (
              <li key={d.id} className="flex items-center gap-2 text-sm">
                <StatusBadge status={d.status} />
                <span className="text-[var(--muted)] line-through">{d.title}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
