'use client';

import { useActionState } from 'react';
import {
  addDependencyAction,
  removeDependencyAction,
  type DependencyState,
} from './dependency-actions';

const initial: DependencyState = { error: null };
const smallBtn =
  'rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50';

export function AddDependencyForm({
  projectKey,
  taskId,
  candidates,
}: {
  projectKey: string;
  taskId: string;
  candidates: { id: string; title: string }[];
}) {
  const [state, action, pending] = useActionState(addDependencyAction, initial);
  if (candidates.length === 0) {
    return <p className="text-xs text-[var(--muted)]">No other tasks to depend on yet.</p>;
  }
  return (
    <form action={action} className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3 text-sm">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="taskId" value={taskId} />
      <span className="text-[var(--muted)]">This task is blocked by</span>
      <select
        name="prerequisiteTaskId"
        required
        aria-label="Prerequisite task"
        className="rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-sm"
      >
        <option value="">Select a task…</option>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>
            {c.title}
          </option>
        ))}
      </select>
      <button type="submit" disabled={pending} className={smallBtn}>
        {pending ? 'Adding…' : 'Add prerequisite'}
      </button>
      {state.error ? (
        <p role="alert" className="w-full text-xs text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function RemoveDependencyButton({
  projectKey,
  taskId,
  prerequisiteTaskId,
}: {
  projectKey: string;
  taskId: string;
  prerequisiteTaskId: string;
}) {
  const [state, action, pending] = useActionState(removeDependencyAction, initial);
  return (
    <form action={action} className="inline">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="prerequisiteTaskId" value={prerequisiteTaskId} />
      <button type="submit" disabled={pending} className={smallBtn} aria-label="Remove prerequisite">
        {pending ? '…' : 'remove'}
      </button>
      {state.error ? <span className="ml-2 text-xs text-[var(--danger)]">{state.error}</span> : null}
    </form>
  );
}
