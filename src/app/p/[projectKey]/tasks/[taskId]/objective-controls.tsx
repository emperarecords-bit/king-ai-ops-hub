'use client';

import { useActionState } from 'react';
import {
  attachTaskObjectiveAction,
  detachTaskObjectiveAction,
  moveTaskObjectiveAction,
} from '../actions';

const inputClass =
  'w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]';
const btnClass =
  'self-start rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50';

interface Obj {
  id: string;
  title: string;
}

/** Attach an untied task to an objective. Reason optional (required by the domain only for closed work). */
function AttachForm({
  projectKey,
  taskId,
  objectives,
  completed,
}: {
  projectKey: string;
  taskId: string;
  objectives: Obj[];
  completed: boolean;
}) {
  const [state, formAction, pending] = useActionState(attachTaskObjectiveAction, { error: null });
  if (objectives.length === 0) {
    return (
      <p className="text-xs text-[var(--muted)]">No open objective is available to attach this to.</p>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="taskId" value={taskId} />
      <select name="objectiveId" required defaultValue="" className={inputClass}>
        <option value="" disabled>
          Attach to objective…
        </option>
        {objectives.map((o) => (
          <option key={o.id} value={o.id}>
            {o.title}
          </option>
        ))}
      </select>
      {completed ? (
        <textarea name="reason" rows={2} required placeholder="Why attach this completed task? (required)" className={inputClass} />
      ) : null}
      <button type="submit" disabled={pending} className={btnClass}>
        {pending ? 'Attaching…' : 'Attach to objective'}
      </button>
      {state.error ? <p role="alert" className="text-xs text-[var(--danger)]">{state.error}</p> : null}
    </form>
  );
}

/** Move a tied task to a different objective. Reason required for completed work. */
function MoveForm({
  projectKey,
  taskId,
  objectives,
  currentObjectiveId,
  completed,
}: {
  projectKey: string;
  taskId: string;
  objectives: Obj[];
  currentObjectiveId: string;
  completed: boolean;
}) {
  const [state, formAction, pending] = useActionState(moveTaskObjectiveAction, { error: null });
  const others = objectives.filter((o) => o.id !== currentObjectiveId);
  if (others.length === 0) return null;
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="taskId" value={taskId} />
      <select name="objectiveId" required defaultValue="" className={inputClass}>
        <option value="" disabled>
          Move to a different objective…
        </option>
        {others.map((o) => (
          <option key={o.id} value={o.id}>
            {o.title}
          </option>
        ))}
      </select>
      {completed ? (
        <textarea name="reason" rows={2} required placeholder="Why re-attribute this completed task? (required)" className={inputClass} />
      ) : null}
      <button type="submit" disabled={pending} className={btnClass}>
        {pending ? 'Moving…' : 'Move to objective'}
      </button>
      {state.error ? <p role="alert" className="text-xs text-[var(--danger)]">{state.error}</p> : null}
    </form>
  );
}

/** Detach a task from its objective. Reason required for completed work. */
function DetachForm({
  projectKey,
  taskId,
  completed,
}: {
  projectKey: string;
  taskId: string;
  completed: boolean;
}) {
  const [state, formAction, pending] = useActionState(detachTaskObjectiveAction, { error: null });
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="taskId" value={taskId} />
      {completed ? (
        <textarea name="reason" rows={2} required placeholder="Why detach this completed task? (required)" className={inputClass} />
      ) : null}
      <button type="submit" disabled={pending} className={`${btnClass} hover:border-[var(--danger)] hover:text-[var(--danger)]`}>
        {pending ? 'Detaching…' : 'Detach from objective'}
      </button>
      {state.error ? <p role="alert" className="text-xs text-[var(--danger)]">{state.error}</p> : null}
    </form>
  );
}

/**
 * Admin controls for a task's canonical objective relationship (HUB-003). Every change goes through an
 * audited domain function — attach, move, or detach — never a raw FK edit. Completed work needs a
 * reason to be re-attributed, because its attribution is already part of the record.
 */
export function ObjectiveLinkControls({
  projectKey,
  taskId,
  currentObjectiveId,
  objectives,
  completed,
}: {
  projectKey: string;
  taskId: string;
  currentObjectiveId: string | null;
  objectives: Obj[];
  completed: boolean;
}) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
        Change objective relationship
      </summary>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        {currentObjectiveId ? (
          <>
            <div className="rounded-md border border-[var(--border)] p-3">
              <MoveForm
                projectKey={projectKey}
                taskId={taskId}
                objectives={objectives}
                currentObjectiveId={currentObjectiveId}
                completed={completed}
              />
            </div>
            <div className="rounded-md border border-[var(--border)] p-3">
              <DetachForm projectKey={projectKey} taskId={taskId} completed={completed} />
            </div>
          </>
        ) : (
          <div className="rounded-md border border-[var(--border)] p-3 sm:col-span-2">
            <AttachForm
              projectKey={projectKey}
              taskId={taskId}
              objectives={objectives}
              completed={completed}
            />
          </div>
        )}
      </div>
    </details>
  );
}
