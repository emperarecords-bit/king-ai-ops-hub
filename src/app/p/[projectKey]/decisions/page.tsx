import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { injectionCounts, listDecisions, type DecisionRow } from '@/domain/decisions/decisions';
import { assessDecision, INACTIVE_LABEL, type DecisionAssessment } from '@/domain/decisions/assess';
import { listObjectives } from '@/domain/objectives/objectives';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { CreateDecisionForm, ReviewDecision, RetireButton } from './decision-forms';

const SCOPE_LABEL: Record<string, string> = { task: 'this task', objective: 'an objective', workspace: 'workspace-wide' };
const APPLICABILITY_SUGGESTION: Record<string, string> = { record: 'record only', guidance: 'active guidance' };
const EXPIRY_SOON_MS = 3 * 24 * 60 * 60 * 1000;

function ts(d: Date): string {
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

export default async function DecisionsPage({ params }: { params: Promise<{ projectKey: string }> }) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const { decisions, objectives, counts } = await withTenant(ctx, async (tx) => ({
    decisions: await listDecisions(tx, ctx),
    objectives: await listObjectives(tx, ctx),
    counts: await injectionCounts(tx, ctx),
  }));
  const isAdmin = ctx.projectRole === 'admin';
  const objectiveOptions = objectives.map((o) => ({ id: o.id, title: o.title }));
  const now = new Date();
  const base = `/p/${projectKey}`;

  // The ONE shared assessment — the Portfolio groups a decision by the same fact the Detail and the
  // selector use. A decision has exactly one canonical group; Needs review is a lens over these.
  const assessed = decisions.map((d) => ({ d, a: assessDecision({ ...d, now }) }));

  const awaiting = assessed.filter((x) => x.a.recordStatus === 'proposed');
  const active = assessed.filter((x) => x.a.isActiveGuidance);
  const recordOnly = assessed.filter((x) => x.a.recordStatus === 'accepted' && x.a.memoryRole === 'record');
  const historical = assessed.filter((x) => x.a.historical);

  // Needs review LENS (not a lifecycle state): evidence-backed concerns over items that keep their
  // canonical home above. Shared applicability is NOT a concern — several decisions may legitimately
  // guide one objective (it shows as neutral context on Detail only). "Never injected" is also NOT a
  // concern. The lens fires only on an actual defect or a decision requiring deliberate attention.
  const needsReview = assessed.filter(({ d, a }) => {
    if (a.inactiveReason === 'invalid_scope') return true; // missing/invalid target — a real defect
    if (a.isActiveGuidance && d.effectiveUntil && d.effectiveUntil.getTime() - now.getTime() < EXPIRY_SOON_MS) return true;
    if (a.inactiveReason === 'task_closed' || a.inactiveReason === 'objective_closed') return true; // scope closed — promote or restate?
    return false;
  });

  return (
    <div>
      <PageHeader
        title="Decisions"
        subtitle="What this workspace has concluded — what actively guides work, what is preserved as record, and what is now historical. Accepted guidance is supplied to future runs only within its scope."
      />

      <Card title="File a decision" className="mb-6">
        <CreateDecisionForm projectKey={projectKey} supersedable={active.map((x) => ({ id: x.d.id, title: x.d.title }))} objectives={objectiveOptions} />
      </Card>

      {needsReview.length > 0 ? (
        <Card title={`Needs review (${needsReview.length})`} className="mb-6 border-[#6b5a3d]">
          <p className="mb-2 text-xs text-[var(--muted)]">A focus lens — each item also lives in its group below.</p>
          <ul className="space-y-1 text-sm">
            {needsReview.map(({ d, a }) => (
              <li key={`nr-${d.id}`} className="flex flex-wrap items-baseline gap-x-2">
                <Link href={`${base}/decisions/${d.id}`} className="hover:text-[var(--accent)]">{d.title}</Link>
                <span className="text-xs text-[var(--warning,#c99a3a)]">{needsReviewReason(d, a, now)}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title={`Awaiting review (${awaiting.length})`} className="mb-6">
        {awaiting.length === 0 ? (
          <EmptyState>Nothing awaiting review.</EmptyState>
        ) : (
          <ul className="space-y-4">
            {awaiting.map(({ d }) => (
              <li key={d.id} className="border-b border-[var(--border)] pb-4 last:border-0">
                <Link href={`${base}/decisions/${d.id}`} className="text-sm font-medium hover:text-[var(--accent)]">{d.title}</Link>
                <span className="ml-2 text-xs text-[var(--muted)]">{d.decisionType}</span>
                <p className="mt-1 text-sm text-[var(--muted)]">{d.summary}</p>
                {d.rationale ? <p className="mt-1 text-xs text-[var(--muted)]">Rationale: {d.rationale}</p> : null}
                <p className="mt-1 text-xs text-[var(--muted)]">Proposed by {d.authorLabel}</p>
                {d.suggestedApplicability ? (
                  <p className="mt-1 text-xs text-[var(--info)]">
                    AI suggested: {APPLICABILITY_SUGGESTION[d.suggestedApplicability]}
                    {d.suggestedScope ? ` · ${SCOPE_LABEL[d.suggestedScope]}` : ''}
                    {d.suggestionConfidence ? ` · ${d.suggestionConfidence} confidence` : ''} (a suggestion, not active scope)
                  </p>
                ) : null}
                {isAdmin ? <ReviewDecision projectKey={projectKey} decisionId={d.id} objectives={objectiveOptions} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Active guidance (${active.length})`} className="mb-6">
        {active.length === 0 ? (
          <EmptyState>No active guidance.</EmptyState>
        ) : (
          <ul className="space-y-3">
            {active.map(({ d }) => (
              <li key={d.id} className="border-b border-[var(--border)] pb-3 last:border-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Link href={`${base}/decisions/${d.id}`} className="text-sm font-medium hover:text-[var(--accent)]">{d.title}</Link>
                  <span className="rounded bg-[#1f3a2a] px-2 py-0.5 text-xs text-[var(--success)]">guides {SCOPE_LABEL[d.scope]}</span>
                  {d.effectiveUntil ? <span className="text-xs text-[var(--muted)]">until {ts(d.effectiveUntil)}</span> : null}
                </div>
                <p className="mt-1 text-sm text-[var(--muted)]">{d.summary}</p>
                <p className="mt-1 text-xs text-[var(--muted)]">
                  {scopeTarget(d)} · supplied to {counts.get(d.id) ?? 0} run{(counts.get(d.id) ?? 0) === 1 ? '' : 's'}
                </p>
                {isAdmin ? <RetireButton projectKey={projectKey} decisionId={d.id} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title={`Record only (${recordOnly.length})`} className="mb-6">
        {recordOnly.length === 0 ? (
          <EmptyState>No record-only conclusions.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {recordOnly.map(({ d }) => (
              <li key={d.id} className="text-sm">
                <Link href={`${base}/decisions/${d.id}`} className="hover:text-[var(--accent)]">{d.title}</Link>
                <span className="ml-2 text-xs text-[var(--muted)]">preserved memory · not supplied to runs</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {historical.length > 0 ? (
        <Card title={`Historical (${historical.length})`}>
          <ul className="space-y-1 text-sm">
            {historical.map(({ d, a }) => (
              <li key={d.id} className="flex flex-wrap items-baseline gap-x-2">
                <Link href={`${base}/decisions/${d.id}`} className="text-[var(--muted)] hover:text-[var(--foreground)]">{d.title}</Link>
                <span className="text-xs text-[var(--muted)]">
                  {a.inactiveReason ? INACTIVE_LABEL[a.inactiveReason] : 'historical'}
                  {d.statusReason ? ` — ${d.statusReason}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function scopeTarget(d: DecisionRow): string {
  if (d.scope === 'task') return `task: ${d.scopeTaskId ? 'set' : 'MISSING'}`;
  if (d.scope === 'objective') return `objective: ${d.scopeObjectiveId ? 'set' : 'MISSING'}`;
  return 'workspace';
}

function needsReviewReason(d: DecisionRow, a: DecisionAssessment, now: Date): string {
  if (a.inactiveReason === 'invalid_scope') return 'invalid scope — missing target';
  if (a.isActiveGuidance && d.effectiveUntil && d.effectiveUntil.getTime() - now.getTime() < EXPIRY_SOON_MS) return `expires ${ts(d.effectiveUntil)}`;
  if (a.inactiveReason === 'task_closed' || a.inactiveReason === 'objective_closed') return 'scope closed — promote or restate?';
  return 'review';
}
