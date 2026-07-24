import { notFound } from 'next/navigation';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { getTask, listMessages, listRuns, listRunSteps } from '@/domain/tasks/tasks';
import { NotFoundError } from '@/lib/errors';
import { Card, ModelText, PageHeader, ProviderBadge, StatusBadge } from '@/components/ui';
import { RunButton } from './run-button';

const ROLE_LABEL: Record<string, string> = {
  user: 'You',
  assistant: 'Primary',
  reviewer: 'Reviewer',
  system: 'System',
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
      return { task, msgs, runs, latestRun, steps };
    });
  } catch (err) {
    if (err instanceof NotFoundError) notFound();
    throw err;
  }

  const { task, msgs, latestRun, steps } = data;
  const canRun = task.status === 'pending' || task.status === 'failed';

  return (
    <div>
      <PageHeader
        title={task.title}
        subtitle={`${task.providerSelection} · review ${task.reviewEnabled ? 'on' : 'off'} · created ${task.createdAt.toISOString().slice(0, 16).replace('T', ' ')}`}
        action={<StatusBadge status={task.status} />}
      />

      {canRun ? (
        <div className="mb-6">
          <RunButton
            projectKey={projectKey}
            taskId={task.id}
            autorun={autorun === '1' && task.status === 'pending'}
            label={task.status === 'failed' ? 'Retry run' : 'Start run'}
          />
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
