import { notFound } from 'next/navigation';
import { CONTEXT_SOURCES, type ContextSource } from '@/types/domain';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getTask, listMessages, listRuns, listRunSteps, listTasks } from '@/domain/tasks/tasks';
import { listDirectDependencies } from '@/domain/dependencies/dependencies';
import { listCandidatesForTask } from '@/domain/decisions/decisions';
import { NotFoundError } from '@/lib/errors';
import { Card, ModelText, PageHeader, ProviderBadge, StatusBadge } from '@/components/ui';
import { CancelTaskButton, RunButton } from './run-button';
import { AddDependencyForm, RemoveDependencyButton } from './dependency-forms';
import { CandidateReview } from './candidate-review';

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
      return { task, msgs, runs, latestRun, steps, deps, allTasks, candidates };
    });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { task, msgs, latestRun, steps, deps, allTasks, candidates } = data;
  // Candidates for a new prerequisite: any other task in the workspace not
  // already a direct prerequisite (the domain layer still rejects cycles).
  const existingPrereqIds = new Set(deps.prerequisites.map((p) => p.prerequisiteTaskId));
  const depCandidates = allTasks
    .filter((t) => t.id !== taskId && !existingPrereqIds.has(t.id))
    .map((t) => ({ id: t.id, title: t.title }));
  const isAdmin = ctx.projectRole === 'admin';
  const canRun = task.status === 'pending' || task.status === 'failed';
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
      <PageHeader
        title={task.title}
        subtitle={`${task.providerSelection} · review ${task.reviewEnabled ? 'on' : 'off'} · created ${task.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`}
        action={<StatusBadge status={task.status} />}
      />

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
