import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CONTEXT_SOURCES, type ContextSource } from '@/types/domain';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getTask, listMessages, listRuns, listRunSteps, listTasks, selectableTaskCandidates } from '@/domain/tasks/tasks';
import { listDirectDependencies } from '@/domain/dependencies/dependencies';
import { listCandidatesForTask } from '@/domain/decisions/decisions';
import { listApprovals } from '@/domain/approvals/approvals';
import { listEmployees } from '@/domain/agents/org';
import { NotFoundError } from '@/lib/errors';
import { Card, ModelText, PageHeader, ProviderBadge, StatusBadge } from '@/components/ui';
import { OwnerPicker } from '../../owner-picker';
import { Breadcrumb } from '../../breadcrumb';
import { WorkFrame } from '../../work-frame';
import { assessTask } from '@/domain/execution/assess';
import { CancelTaskButton, RunButton } from './run-button';
import { AddDependencyForm, RemoveDependencyButton } from './dependency-forms';
import { CandidateReview } from './candidate-review';
import { PromptIdentity } from './prompt-identity';
import { TaskRecoveryControls } from './recovery-controls';
import { ObjectiveLinkControls } from './objective-controls';
import { noEligibleExecutor } from '@/domain/execution/executors';
import { classifyTaskObjectiveLink, listOpenObjectives } from '@/domain/objectives/task-link';

const ROLE_LABEL: Record<string, string> = {
  user: 'You',
  assistant: 'Primary',
  reviewer: 'Reviewer',
  system: 'System',
};

const CONTEXT_SOURCE_LABEL: Record<ContextSource, string> = {
  objective: 'Objective',
  charter: 'Workspace charter & knowledge',
  retrieved: 'Retrieved by relevance',
  core_reference: 'Core reference (quota)',
  production_status: 'Production status',
  objective_progress: 'Objective progress',
  active_work: 'Active work',
  blocker: 'Blockers',
  recent_outcome: 'Recent outcomes',
  pending_review: 'Pending reviews',
  task_graph: 'Task graph',
  decision_memory: 'Decision memory',
};

const SEVERITY_STYLE: Record<string, string> = {
  critical: 'bg-[#3a2026] text-[var(--danger)]',
  major: 'bg-[#3a3220] text-[#e5c07b]',
  minor: 'bg-[#22303a] text-[#7bb8e5]',
};

export default async function TaskDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ projectKey: string; taskId: string }>;
  searchParams: Promise<{ autorun?: string }>;
}) {
  const { projectKey, taskId } = await params;
  const { autorun } = await searchParams;
  const ctx = await requireTenant(projectKey);

  let data;
  try {
    data = await withTenant(ctx, async (tx) => {
      const task = await getTask(tx, ctx, taskId);
      const msgs = await listMessages(tx, ctx, taskId);
      const runs = await listRuns(tx, ctx, taskId);
      const latestRun = runs[0] ?? null;
      const steps = latestRun ? await listRunSteps(tx, ctx, latestRun.id) : [];
      const deps = await listDirectDependencies(tx, ctx, taskId);
      const allTasks = await listTasks(tx, ctx, 100);
      const candidates = await listCandidatesForTask(tx, ctx, taskId);
      const employees = await listEmployees(tx, ctx);
      const taskApprovals = (await listApprovals(tx, ctx)).filter((a) => a.taskId === taskId);
      const openObjectives = await listOpenObjectives(tx, ctx);
      return { task, msgs, runs, latestRun, steps, deps, allTasks, candidates, employees, taskApprovals, openObjectives };
    });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { task, msgs, runs, latestRun, steps, deps, allTasks, candidates, employees, taskApprovals, openObjectives } = data;
  // The canonical objective relationship (HUB-003). This header now reads the SAME tasks.objective_id
  // every other surface reads — it is no longer the one place that denies a real tie. The purpose line
  // states a cancelled/completed goal truthfully rather than implying it is still live.
  const objectivePurpose = task.objectiveTitle
    ? task.objectiveStatus === 'cancelled' || task.objectiveStatus === 'completed'
      ? `${task.objectiveTitle} (${task.objectiveStatus})`
      : task.objectiveTitle
    : null;
  // Did any run receive an objective as CONTEXT? That is not a durable link — it must never be shown as one.
  const hadObjectiveContext = runs.some(
    (r) =>
      Array.isArray(r.contextManifest) &&
      r.contextManifest.some((e) => e && (e.source === 'objective' || e.source === 'objective_progress')),
  );
  const linkClass = classifyTaskObjectiveLink({
    objectiveId: task.objectiveId,
    objectiveStatus: task.objectiveStatus,
    hadObjectiveContext,
  });
  // Authorization is a separate lifecycle from the task's own work. A completed task may still hold
  // an authorized action the Hub has NOT executed — the summary must not imply it did.
  const authorizedUnexecuted = taskApprovals.some((a) => a.status === 'approved');
  const refusedCount = taskApprovals.filter((a) => a.status === 'rejected').length;
  // "Execution unavailable" is only truthful once the backend has POSITIVELY determined that no
  // executor exists for the authorized actions (HUB-002, item 7) — never merely because execution
  // hasn't happened. Phase 3 executors are unbuilt, so noEligibleExecutor is true for a non-empty set.
  const authorizedActionTypes = taskApprovals
    .filter((a) => a.status === 'approved')
    .map((a) => a.actionType);
  const executionUnavailable = noEligibleExecutor(authorizedActionTypes);
  const ownerName = task.ownerAgentId
    ? (employees.find((e) => e.id === task.ownerAgentId)?.name ?? null)
    : null;
  const ownerOptions = employees.map((e) => ({ id: e.id, name: e.name, title: e.title }));
  // Candidates for a new prerequisite: any other task in the workspace not
  // already a direct prerequisite (the domain layer still rejects cycles).
  const existingPrereqIds = new Set(deps.prerequisites.map((p) => p.prerequisiteTaskId));
  // HUB-009 — a live task's dependency picker never offers non-live (demo/seed) candidates (shared pure
  // builder). The server-side addDependency guard is the real enforcement of a manually-submitted id.
  const depCandidates = selectableTaskCandidates(allTasks, { excludeId: taskId, excludeIds: existingPrereqIds }).map((t) => ({ id: t.id, title: t.title }));
  const isAdmin = ctx.projectRole === 'admin';
  const canRun = task.status === 'pending' || task.status === 'failed';
  // Recovery is for a task that is stale/obsolete but not already terminal or mid-run. A cancelled
  // task is done; a running one must finish first (the domain rejects both anyway).
  const canRecover = isAdmin && task.status !== 'cancelled' && task.status !== 'running';
  // A task can only be superseded by an existing, non-cancelled, different task. HUB-009 — demo/seed tasks are
  // kept out of the selectable candidate list (a live task is never superseded by non-live work).
  const nonCancelledIds = new Set(allTasks.filter((t) => t.status === 'cancelled').map((t) => t.id));
  const supersedeCandidates = selectableTaskCandidates(allTasks, { excludeId: taskId, excludeIds: nonCancelledIds }).map((t) => ({ id: t.id, title: t.title }));
  const reviewStep = steps.find((s) => s.kind === 'review' && s.verdictDetail != null);
  const reviewIssues = reviewStep?.verdictDetail?.issues ?? [];

  // Group the context manifest by source, in the canonical order, for the panel.
  const manifest = latestRun?.contextManifest ?? [];
  const contextGroups = CONTEXT_SOURCES.map((source) => ({
    source,
    entries: manifest.filter((e) => e.source === source),
  })).filter((g) => g.entries.length > 0);

  return (
    <div>
      <Breadcrumb leaf={task.title} />
      <PageHeader
        title={task.title}
        subtitle={`${task.providerSelection} · review ${task.reviewEnabled ? 'on' : 'off'} · created ${task.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`}
        action={<StatusBadge status={task.status} />}
      />

      <div className="mb-6 flex items-center gap-2 text-sm">
        <span className="text-[var(--muted)]">Owner:</span>
        {isAdmin ? (
          <OwnerPicker
            projectKey={projectKey}
            object="task"
            objectId={task.id}
            ownerAgentId={task.ownerAgentId}
            employees={ownerOptions}
            revalidate={`/p/${projectKey}/tasks/${task.id}`}
          />
        ) : (
          <span>{ownerName ?? 'Unassigned'}</span>
        )}
      </div>

      <WorkFrame
        kind="ai_task"
        purpose={objectivePurpose}
        assessment={assessTask({ status: task.status, ownerAgentId: task.ownerAgentId, authorizedUnexecuted })}
        accountable={ownerName ?? null}
        performer="the assigned agent"
        recent={null}
      />

      <Card title="Objective" className="mb-6">
        {task.objectiveId ? (
          <p className="text-sm">
            {linkClass === 'tied_to_closed' ? (
              <>
                Tied to{' '}
                <Link href={`/p/${projectKey}/objectives/${task.objectiveId}`} className="text-[var(--accent)]">
                  {task.objectiveTitle}
                </Link>{' '}
                <span className="text-[var(--muted)]">
                  — this objective is {task.objectiveStatus}. The task contributed to it; the tie is kept as
                  historical record.
                </span>
              </>
            ) : (
              <>
                Contributing to{' '}
                <Link href={`/p/${projectKey}/objectives/${task.objectiveId}`} className="text-[var(--accent)]">
                  {task.objectiveTitle}
                </Link>
                <span className="text-[var(--muted)]"> — a direct, durable relationship.</span>
              </>
            )}
          </p>
        ) : (
          <p className="text-sm text-[var(--muted)]">
            Not tied to an objective.
            {linkClass === 'context_only' ? (
              <span className="mt-1 block text-xs">
                A run for this task received an objective as <strong>context</strong>, but that is not a
                durable relationship — receiving an objective in a run never, on its own, ties the task to
                it. Attach it explicitly below if it truly contributes.
              </span>
            ) : null}
          </p>
        )}
        {isAdmin ? (
          <ObjectiveLinkControls
            projectKey={projectKey}
            taskId={task.id}
            currentObjectiveId={task.objectiveId}
            objectives={openObjectives.map((o) => ({ id: o.id, title: o.title }))}
            completed={task.status === 'completed'}
          />
        ) : null}
      </Card>

      {task.status === 'completed' && (authorizedUnexecuted || refusedCount > 0) ? (
        <p className="mb-6 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
          <span className="text-[var(--muted)]">AI work:</span> Finished ·{' '}
          <span className="text-[var(--muted)]">Proposed action:</span>{' '}
          {authorizedUnexecuted ? 'Authorized, not executed' : 'Refused'}
          <span className="mt-1 block text-xs text-[var(--muted)]">
            The task finished producing the action. The action itself has not executed.
            {authorizedUnexecuted && executionUnavailable ? (
              <>
                {' '}
                No executor is currently available to carry out this kind of action, so it will not
                execute on its own. If it is no longer wanted, withdraw the authorization or use a
                recovery action below.
              </>
            ) : null}
          </span>
        </p>
      ) : null}

      {task.status === 'cancelled' && task.cancelReason ? (
        <p className="mb-6 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--muted)]">
          Cancelled: {task.cancelReason}
        </p>
      ) : null}

      {canRun ? (
        <div className="mb-6 flex flex-wrap items-start gap-3">
          <RunButton
            projectKey={projectKey}
            taskId={task.id}
            autorun={autorun === '1' && task.status === 'pending'}
            label={task.status === 'failed' ? 'Retry run' : 'Start run'}
          />
          <CancelTaskButton projectKey={projectKey} taskId={task.id} />
        </div>
      ) : null}

      {canRecover ? (
        <Card title="Recovery" className="mb-6">
          <TaskRecoveryControls
            projectKey={projectKey}
            taskId={task.id}
            candidates={supersedeCandidates}
            showReconcile={task.status === 'awaiting_approval'}
          />
        </Card>
      ) : null}

      {latestRun?.consolidatedResult ? (
        <Card title="Consolidated result" className="mb-6 border-[var(--accent)]">
          <ModelText content={latestRun.consolidatedResult} />
        </Card>
      ) : null}

      {latestRun?.errorMessage ? (
        <Card title="Run error" className="mb-6 border-[var(--danger)]">
          <p className="text-sm text-[var(--danger)]">{latestRun.errorMessage}</p>
        </Card>
      ) : null}

      {contextGroups.length > 0 ? (
        <Card title="Context used" className="mb-6">
          <p className="mb-3 text-sm text-[var(--muted)]">
            The balanced context package assembled for this task, grouped by why each part was
            included.
          </p>
          <div className="space-y-4">
            {contextGroups.map((group) => (
              <div key={group.source}>
                <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--accent)]">
                  {CONTEXT_SOURCE_LABEL[group.source] ?? group.source}
                </h3>
                <ul className="space-y-1">
                  {group.entries.map((e, i) => (
                    <li key={i} className="flex flex-wrap items-center gap-3 text-sm">
                      <span className="font-mono text-xs">{e.label}</span>
                      {e.detail ? (
                        <span className="text-xs text-[var(--muted)]">{e.detail}</span>
                      ) : null}
                      {e.graph ? (
                        <span
                          className={`text-xs ${e.graph.cycle ? 'text-[var(--danger)]' : 'text-[var(--muted)]'}`}
                        >
                          {e.graph.nodeCount} nodes · {e.graph.edgeCount} edges · root “
                          {e.graph.rootTask}” · {e.graph.cycle ? 'cycle detected' : 'no cycle'}
                        </span>
                      ) : null}
                      {e.freshness ? (
                        <span className="text-xs text-[var(--muted)]">
                          {[
                            e.freshness.sourceUpdatedAt
                              ? `updated ${e.freshness.sourceUpdatedAt.slice(0, 10)}`
                              : null,
                            e.freshness.contentEffectiveAt
                              ? `effective ${e.freshness.contentEffectiveAt}`
                              : null,
                            `freshness ${e.freshness.confidence}`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      ) : latestRun?.retrievedDocuments && latestRun.retrievedDocuments.length > 0 ? (
        // Pre-O-14 runs: only the retrieval provenance was recorded.
        <Card title="Documents used" className="mb-6">
          <ul className="space-y-1">
            {latestRun.retrievedDocuments.map((d, i) => (
              <li key={i} className="flex items-center gap-3 text-sm">
                <span className="font-mono text-xs">{d.relativePath}</span>
                <span className="text-xs text-[var(--muted)]">
                  chunk {d.chunkIndex} · relevance {d.rank.toFixed(3)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {reviewStep?.verdictDetail ? (
        <Card title="Review" className="mb-6">
          <div className="mb-3 flex items-center gap-3 text-sm">
            <StatusBadge status={reviewStep.verdictDetail.verdict} />
            {reviewStep.provider ? <ProviderBadge provider={reviewStep.provider} /> : null}
            <span className="text-[var(--muted)]">
              {reviewIssues.length === 0
                ? 'No issues raised.'
                : `${reviewIssues.length} issue${reviewIssues.length === 1 ? '' : 's'} raised`}
            </span>
          </div>
          {reviewIssues.length > 0 ? (
            <ul className="space-y-2">
              {reviewIssues.map((issue, i) => (
                <li key={i} className="rounded-md border border-[var(--border)] p-3 text-sm">
                  <div className="mb-1 flex items-center gap-2">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${SEVERITY_STYLE[issue.severity] ?? ''}`}
                    >
                      {issue.severity}
                    </span>
                    <span className="font-medium">{issue.summary}</span>
                  </div>
                  {issue.detail ? (
                    <p className="text-[var(--muted)]">{issue.detail}</p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {steps.length > 0 ? (
        <Card title="Run steps" className="mb-6">
          <ol className="space-y-2">
            {steps.map((s) => (
              <li key={s.id} className="flex items-center gap-3 text-sm">
                <span className="w-6 text-right text-[var(--muted)]">{s.stepNumber}.</span>
                <span className="w-24 font-medium capitalize">{s.kind}</span>
                {s.provider ? <ProviderBadge provider={s.provider} /> : null}
                {s.model ? <span className="text-xs text-[var(--muted)]">{s.model}</span> : null}
                {s.verdict ? <StatusBadge status={s.verdict} /> : null}
                {s.latencyMs != null ? (
                  <span className="text-xs text-[var(--muted)]">{(s.latencyMs / 1000).toFixed(1)}s</span>
                ) : null}
                {!s.succeeded ? (
                  <span className="text-xs text-[var(--danger)]">{s.errorMessage}</span>
                ) : null}
              </li>
            ))}
          </ol>
        </Card>
      ) : null}

      {latestRun ? <PromptIdentity run={latestRun} steps={steps} /> : null}

      {candidates.length > 0 && isAdmin ? (
        <Card title="Suggested decisions" className="mb-6 border-[#6b5a3d]">
          <p className="mb-3 text-sm text-[var(--muted)]">
            The AI proposed these from this task&apos;s result. They are <strong>not</strong>{' '}
            organizational memory and do not influence future runs unless you accept them.
          </p>
          <ul className="space-y-3">
            {candidates.map((c) => (
              <CandidateReview
                key={c.id}
                projectKey={projectKey}
                taskId={task.id}
                candidate={{
                  id: c.id,
                  title: c.title,
                  summary: c.summary,
                  rationale: c.rationale,
                  decisionType: c.decisionType,
                  confidence: c.confidence,
                  evidence: c.evidence,
                  supersedesTitle: c.supersedesTitle,
                  originatingTaskId: c.originatingTaskId,
                  suggestedByRunId: c.suggestedByRunId,
                  reviewedAt: c.reviewedAt ? c.reviewedAt.toISOString() : null,
                }}
              />
            ))}
          </ul>
        </Card>
      ) : null}

      <Card title="Dependencies" className="mb-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Blocked by (prerequisites)
            </h3>
            {deps.prerequisites.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">None.</p>
            ) : (
              <ul className="space-y-1">
                {deps.prerequisites.map((p) => (
                  <li key={p.prerequisiteTaskId} className="flex items-center gap-2 text-sm">
                    <StatusBadge status={p.prerequisiteStatus} />
                    <span>{p.prerequisiteTitle}</span>
                    {isAdmin ? (
                      <RemoveDependencyButton
                        projectKey={projectKey}
                        taskId={task.id}
                        prerequisiteTaskId={p.prerequisiteTaskId}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">
              Unlocks (dependents)
            </h3>
            {deps.dependents.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">None.</p>
            ) : (
              <ul className="space-y-1">
                {deps.dependents.map((d) => (
                  <li key={d.dependentTaskId} className="flex items-center gap-2 text-sm">
                    <StatusBadge status={d.dependentStatus} />
                    <span>{d.dependentTitle}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        {isAdmin ? (
          <AddDependencyForm projectKey={projectKey} taskId={task.id} candidates={depCandidates} />
        ) : null}
      </Card>

      <Card title="Conversation">
        {msgs.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">
            No messages yet — start the run to send this task to the agents.
          </p>
        ) : (
          <ul className="space-y-4">
            {msgs.map((m) => (
              <li key={m.id}>
                <div className="mb-1 flex items-center gap-2 text-xs text-[var(--muted)]">
                  <span className="font-semibold text-[var(--foreground)]">
                    {ROLE_LABEL[m.role] ?? m.role}
                  </span>
                  {m.provider ? <ProviderBadge provider={m.provider} /> : null}
                  {m.model ? <span>{m.model}</span> : null}
                  <span>{m.createdAt.toISOString().slice(0, 19).replace('T', ' ')}</span>
                </div>
                <ModelText content={m.content} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
