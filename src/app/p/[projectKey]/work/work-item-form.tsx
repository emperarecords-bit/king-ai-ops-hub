'use client';

import { useActionState, useEffect, useRef } from 'react';
import { createWorkItemAction, type WorkItemState } from './actions';

const inputCls =
  'w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm';
const labelCls = 'block text-xs text-[var(--muted)] mb-1';

/**
 * Create a human work item. Minimal by design: title, an optional starting
 * stage, an optional objective to file it under, and opening notes.
 */
export function CreateWorkItemForm({
  projectKey,
  objectives,
  defaultObjectiveId,
}: {
  projectKey: string;
  objectives: { id: string; title: string }[];
  defaultObjectiveId?: string;
}) {
  const [state, action, pending] = useActionState<WorkItemState, FormData>(createWorkItemAction, {
    error: null,
  });
  const formRef = useRef<HTMLFormElement>(null);
  const wasPending = useRef(false);

  // Clear the form after a successful create (pending fell and no error).
  useEffect(() => {
    if (wasPending.current && !pending && !state.error) formRef.current?.reset();
    wasPending.current = pending;
  }, [pending, state.error]);

  return (
    <form ref={formRef} action={action} className="space-y-3">
      <input type="hidden" name="projectKey" value={projectKey} />
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={labelCls}>Title</label>
          <input name="title" required maxLength={200} className={inputCls} placeholder="e.g. L&N Mechanical – Nick" />
        </div>
        <div>
          <label className={labelCls}>Stage</label>
          <input name="stage" maxLength={60} defaultValue="Sourced" className={inputCls} list="work-stages" placeholder="Sourced" />
          <datalist id="work-stages">
            <option value="Sourced" />
            <option value="Contacted" />
            <option value="Demo booked" />
            <option value="Demo completed" />
            <option value="Activated" />
            <option value="Subscribed" />
          </datalist>
        </div>
      </div>
      <div>
        <label className={labelCls}>Objective (optional)</label>
        <select name="objectiveId" defaultValue={defaultObjectiveId ?? ''} className={inputCls}>
          <option value="">— None —</option>
          {objectives.map((o) => (
            <option key={o.id} value={o.id}>{o.title}</option>
          ))}
        </select>
      </div>
      <div>
        <label className={labelCls}>Notes</label>
        <textarea name="notes" rows={3} maxLength={8000} className={inputCls} placeholder="Qualification, their words, objections, next action…" />
      </div>
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-medium text-[var(--accent-contrast,#111)] disabled:opacity-60">
          {pending ? 'Adding…' : 'Add work item'}
        </button>
        {state.error ? <span className="text-sm text-[var(--danger)]">{state.error}</span> : null}
      </div>
    </form>
  );
}
