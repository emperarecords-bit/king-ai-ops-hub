import Link from 'next/link';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { reconcileStrandedApprovalTasks } from '@/domain/approvals/approvals';
import { listAutomations, listExecution } from '@/domain/execution/execution';
import {
  assessTask,
  assessWorkItem,
  ACTIVE_CONDITION_ORDER,
  CONDITION_LABEL,
  type ExecutionAssessment,
} from '@/domain/execution/assess';
import { assessAutomation, AUTOMATION_STATE_LABEL } from '@/domain/execution/automation';
import { listEmployees } from '@/domain/agents/org';
import { listObjectives } from '@/domain/objectives/objectives';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { visibilityFromParam } from '@/domain/classification/classification';
import { type DataClassification } from '@/types/domain';
import { CreateWorkItemForm } from './work-item-form';
import { WorkItemRow } from './work-item-row';
import { ClassificationChip, NonLiveControls } from '../non-live-controls';

/**
 * Execution — the complete state of the work, in one operational language over two engines
 * (HUB-PRODUCT.md). Organized by condition (Moving/Waiting/Planned/Unknown), with a "Requires you"
 * lens over the items needing involvement, and terminal work in Recent. One stream; work type is
 * secondary. The condition/intervention/reason translation is the shared assess.ts.
 */
export default async function ExecutionPage({
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
  const canEdit = ctx.projectRole !== 'viewer';

  const { feed, automations, employees, objectives } = await withTenant(ctx, async (tx) => {
    // Self-heal any task stranded in awaiting_approval with no pending proposal, so "Requires you"
    // never asks for a decision already made (HUB-001).
    await reconcileStrandedApprovalTasks(tx, ctx);
    return {
      feed: await listExecution(tx, ctx, visibility),
      automations: await listAutomations(tx, ctx),
      employees: await listEmployees(tx, ctx),
      objectives: await listObjectives(tx, ctx),
    };
  });
  const rows = feed.rows;

  const assessedAutomations = automations.map((x) => ({
    x,
    aa: assessAutomation({ enabled: x.enabled, recentRuns: x.recentRuns, recentFailures: x.recentFailures }),
  }));
  const automationsRequiring = assessedAutomations.filter((a) => a.aa.intervention === 'required');

  const now = new Date();
  const assessed = rows.map((r) => ({
    r,
    a:
      r.kind === 'work_item'
        ? assessWorkItem({ condition: r.condition, waitingOn: r.waitingOn, ownerAgentId: r.ownerAgentId, updatedAt: r.updatedAt, now })
        : assessTask({ status: r.status!, ownerAgentId: r.ownerAgentId, authorizedUnexecuted: r.authorizedUnexecuted }),
  }));

  const requiresYou = assessed.filter((x) => x.a.intervention === 'required');
  const activeGroups = ACTIVE_CONDITION_ORDER.map((cond) => ({
    cond,
    items: assessed.filter((x) => x.a.condition === cond),
  })).filter((g) => g.items.length > 0);
  const recent = assessed.filter((x) => x.a.condition === 'finished' || x.a.condition === 'stopped');
  const activeCount = assessed.length - recent.length;

  const ownerOptions = employees.map((e) => ({ id: e.id, name: e.name, title: e.title }));
  const objectiveOptions = objectives.map((o) => ({ id: o.id, title: o.title }));

  return (
    <div>
      <PageHeader
        title="Execution"
        subtitle="The complete state of the work — human and AI, in one language. Organized by what it's doing; the lens above shows only what needs you."
      />

      <NonLiveControls
        pathname={`/p/${projectKey}/work`}
        searchParams={sp}
        includeNonLive={visibility.includeNonLive}
        excluded={feed.excluded}
      />

      {canEdit ? (
        <details className="mb-6">
          <summary className="cursor-pointer text-sm text-[var(--accent)]">+ Add a work item</summary>
          <div className="mt-3 rounded-md border border-[var(--border)] p-4">
            <CreateWorkItemForm projectKey={projectKey} objectives={objectiveOptions} />
          </div>
        </details>
      ) : null}

      {assessed.length === 0 ? (
        <EmptyState>No work yet. Add a work item, or assign an AI task from the Dashboard or an objective.</EmptyState>
      ) : (
        <>
          {(() => {
            const needCount = requiresYou.length + automationsRequiring.length;
            return (
              <p className="mb-5 text-[15px] text-[var(--foreground)]">
                {activeCount} piece{activeCount === 1 ? '' : 's'} of work in flight
                {automations.length > 0 ? ` · ${automations.length} ongoing automation${automations.length === 1 ? '' : 's'}` : ''}
                {needCount > 0 ? `; ${needCount} need${needCount === 1 ? 's' : ''} you.` : '; nothing needs you right now.'}
              </p>
            );
          })()}

          {requiresYou.length > 0 || automationsRequiring.length > 0 ? (
            <Card title="Requires you" className="mb-6 border-l-2 border-l-[var(--accent-strong)]">
              <ul className="space-y-2">
                {automationsRequiring.map(({ x, aa }) => (
                  <li key={`req-auto-${x.id}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span className="rounded border border-[var(--border)] px-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">Automation</span>
                    <a href={`#auto-${x.id}`} className="text-[var(--foreground)] hover:text-[var(--accent)]">{x.title}</a>
                    <span className="text-xs text-[var(--muted)]">· {AUTOMATION_STATE_LABEL[aa.state]}</span>
                    <span className="text-xs text-[var(--accent)]">· {aa.requiredAction}</span>
                  </li>
                ))}
                {requiresYou.map(({ r, a }) => (
                  <li key={`req-${r.kind}-${r.id}`} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <Kind kind={r.kind} />
                    <ClassificationChip classification={r.classification} />
                    {r.kind === 'ai_task' ? (
                      <Link href={`/p/${projectKey}/tasks/${r.id}`} className="text-[var(--foreground)] hover:text-[var(--accent)]">
                        {r.title}
                      </Link>
                    ) : (
                      <Link href={`/p/${projectKey}/work/${r.id}`} className="text-[var(--foreground)] hover:text-[var(--accent)]">
                        {r.title}
                      </Link>
                    )}
                    <span className="text-xs text-[var(--muted)]">· {CONDITION_LABEL[a.condition]}</span>
                    <span className="text-xs text-[var(--accent)]">· {a.requiredAction}</span>
                    <span className="ml-auto text-xs text-[var(--muted)]">{r.ownerName ?? 'unowned'}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}

          {activeGroups.map(({ cond, items }) => (
            <section key={cond} className="mb-6">
              <h2 className={`mb-2 text-xs font-medium uppercase tracking-wide ${cond === 'unknown' ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}`}>
                {CONDITION_LABEL[cond]}
              </h2>
              <div className="space-y-2">
                {items.map(({ r, a }) =>
                  r.kind === 'work_item' ? (
                    <div key={r.id} id={`exec-${r.id}`}>
                      <AssessLine a={a} />
                      <WorkItemRow
                        projectKey={projectKey}
                        classification={r.classification}
                        item={{
                          id: r.id,
                          title: r.title,
                          condition: r.condition,
                          waitingOn: r.waitingOn,
                          stage: r.stage ?? '',
                          notes: r.notes ?? '',
                          ownerAgentId: r.ownerAgentId,
                          ownerName: r.ownerName,
                          objectiveTitle: r.objectiveTitle,
                        }}
                        employees={ownerOptions}
                        canEdit={canEdit}
                      />
                    </div>
                  ) : (
                    <TaskRow key={r.id} projectKey={projectKey} classification={r.classification} title={r.title} id={r.id} a={a} owner={r.ownerName} objective={r.objectiveTitle} />
                  ),
                )}
              </div>
            </section>
          ))}

          {assessedAutomations.length > 0 ? (
            <section className="mb-6">
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Ongoing automations</h2>
              <p className="mb-2 text-xs text-[var(--muted)]">Recurring authority to create work — not currently-executing tasks. The tasks they produce appear above as their own records.</p>
              <div className="space-y-2">
                {assessedAutomations.map(({ x, aa }) => (
                  <div key={x.id} id={`auto-${x.id}`} className="rounded-md border border-[var(--border)] p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded border border-[var(--border)] px-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">Automation</span>
                      <span className="text-sm font-medium">{x.title}</span>
                      <span className="text-xs text-[var(--muted)]">· {AUTOMATION_STATE_LABEL[aa.state]}</span>
                      <span className="ml-auto">
                        {aa.intervention === 'required' ? (
                          <span className="text-xs text-[var(--accent)]">needs you</span>
                        ) : aa.intervention === 'watch' ? (
                          <span className="text-xs text-[var(--warning,#c99a3a)]">watch</span>
                        ) : null}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      {aa.reason} · {x.cadence} · next run {x.nextRunAt.toISOString().slice(0, 16).replace('T', ' ')} UTC · {x.producedCount} produced
                      {x.recentFailures > 0 ? ` · ${x.recentFailures} of last ${x.recentRuns} runs failed` : ''}
                    </p>
                    {x.objectiveId ? (
                      <Link href={`/p/${projectKey}/objectives/${x.objectiveId}`} className="mt-1 inline-block text-xs text-[var(--accent)]">
                        Manage (pause / inspect) on {x.objectiveTitle ?? 'its objective'} →
                      </Link>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {recent.length > 0 ? (
            <section>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">Recent</h2>
              <div className="divide-y divide-[var(--border)]">
                {recent.map(({ r, a }) => (
                  <div key={`rec-${r.id}`} className="py-2 text-sm">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <Kind kind={r.kind} />
                      <ClassificationChip classification={r.classification} />
                      {r.kind === 'ai_task' ? (
                        <Link href={`/p/${projectKey}/tasks/${r.id}`} className="text-[var(--foreground)] hover:text-[var(--accent)]">
                          {r.title}
                        </Link>
                      ) : (
                        <Link href={`/p/${projectKey}/work/${r.id}`} className="text-[var(--foreground)] hover:text-[var(--accent)]">
                          {r.title}
                        </Link>
                      )}
                      <span className="text-xs text-[var(--muted)]">· {CONDITION_LABEL[a.condition]}</span>
                      <span className="ml-auto text-xs text-[var(--muted)]">{r.ownerName ?? ''}</span>
                    </div>
                    {r.closureReason ? (
                      <p className="mt-0.5 text-xs text-[var(--muted)]">
                        {a.condition === 'stopped' ? 'Stopped' : 'Note'}
                        {r.closedByName ? ` by ${r.closedByName}` : ''}
                        {r.closedAt ? ` on ${r.closedAt.toISOString().slice(0, 10)}` : ''}: {r.closureReason}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function Kind({ kind }: { kind: 'work_item' | 'ai_task' }) {
  return (
    <span className="rounded border border-[var(--border)] px-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">
      {kind === 'ai_task' ? 'AI' : 'Human'}
    </span>
  );
}

function InterventionChip({ a }: { a: ExecutionAssessment }) {
  if (a.intervention === 'required') return <span className="text-xs text-[var(--accent)]">needs you</span>;
  if (a.intervention === 'watch') return <span className="text-xs text-[var(--warning,#c99a3a)]">watch</span>;
  return null;
}

function AssessLine({ a }: { a: ExecutionAssessment }) {
  return (
    <p className="mb-1 flex flex-wrap items-baseline gap-x-2 text-xs text-[var(--muted)]">
      <InterventionChip a={a} />
      <span>{a.reason}</span>
      {a.confidence ? <span>· {a.confidence}</span> : null}
    </p>
  );
}

function TaskRow({
  projectKey,
  id,
  title,
  a,
  owner,
  objective,
  classification,
}: {
  projectKey: string;
  id: string;
  title: string;
  a: ExecutionAssessment;
  owner: string | null;
  objective: string | null;
  classification: DataClassification;
}) {
  return (
    <div className="rounded-md border border-[var(--border)] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Kind kind="ai_task" />
        <ClassificationChip classification={classification} />
        <Link href={`/p/${projectKey}/tasks/${id}`} className="text-sm font-medium hover:text-[var(--accent)]">
          {title}
        </Link>
        <span className="ml-auto">
          <InterventionChip a={a} />
        </span>
      </div>
      <p className="mt-1 text-xs text-[var(--muted)]">
        {a.reason}
        {a.requiredAction ? ` · ${a.requiredAction}` : ''} · {owner ?? 'unowned'} · system-observed
        {objective ? ` · ${objective}` : ''}
      </p>
    </div>
  );
}
