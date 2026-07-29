'use client';

import { useActionState } from 'react';
import {
  cancelTaskRecoveryAction,
  reconcileTaskAction,
  supersedeTaskAction,
} from '../actions';

const inputClass =
  'w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--accent)]';
const btnClass =
  'self-start rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50';

/**
 * Cancel a stale task (recovery): stop it without deleting history. A reason is
 * required — recovery is deliberate, and the reason becomes the closure record.
 */
function CancelRecovery({ projectKey, taskId }: { projectKey: string; taskId: string }) {
  const [state, formAction, pending] = useActionState(cancelTaskRecoveryAction, { error: null });
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="taskId" value={taskId} />
      <p className="text-xs text-[var(--muted)]">
        <strong className="text-[var(--foreground)]">Cancel</strong> — stop this task without deleting
        its history. Costs, messages, and audit stay. Any actions it proposed but that were never
        authorized are withdrawn.
      </p>
      <textarea
        name="reason"
        rows={2}
        required
        placeholder="Why cancel? (required — kept as the closure reason)"
        className={inputClass}
      />
      <button type="submit" disabled={pending} className={btnClass}>
        {pending ? 'Cancelling…' : 'Cancel task'}
      </button>
      {state.error ? (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Supersede a task with an existing replacement: cancel the old one while
 * recording the link to the newer task, preserving the relationship.
 */
function Supersede({
  projectKey,
  taskId,
  candidates,
}: {
  projectKey: string;
  taskId: string;
  candidates: { id: string; title: string }[];
}) {
  const [state, formAction, pending] = useActionState(supersedeTaskAction, { error: null });
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="taskId" value={taskId} />
      <p className="text-xs text-[var(--muted)]">
        <strong className="text-[var(--foreground)]">Supersede</strong> — replace this task with a newer
        one. The old task closes, but the link to its replacement is kept so the history stays
        connected. This is not execution.
      </p>
      {candidates.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">
          No other task is available to supersede this with. Create the replacement first.
        </p>
      ) : (
        <>
          <select name="replacementTaskId" required defaultValue="" className={inputClass}>
            <option value="" disabled>
              Pick the replacement task…
            </option>
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <textarea
            name="reason"
            rows={2}
            required
            placeholder="Why is this task being replaced? (required)"
            className={inputClass}
          />
          <button type="submit" disabled={pending} className={btnClass}>
            {pending ? 'Superseding…' : 'Supersede with replacement'}
          </button>
        </>
      )}
      {state.error ? (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Manually reconcile a task's derived state from its authoritative approval
 * records. Repairs a task whose status drifted out of step (idempotent).
 */
function Reconcile({ projectKey, taskId }: { projectKey: string; taskId: string }) {
  const [state, formAction, pending] = useActionState(reconcileTaskAction, { error: null });
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="taskId" value={taskId} />
      <p className="text-xs text-[var(--muted)]">
        <strong className="text-[var(--foreground)]">Reconcile</strong> — repair this task&apos;s state
        from the authoritative approval records. Use it if the status looks out of step with the
        decisions already made. Safe to run more than once; it only changes state that is genuinely
        stale.
      </p>
      <textarea
        name="reason"
        rows={2}
        required
        placeholder="Why reconcile? (required — audited)"
        className={inputClass}
      />
      <button type="submit" disabled={pending} className={btnClass}>
        {pending ? 'Reconciling…' : 'Reconcile from approvals'}
      </button>
      {state.error ? (
        <p role="alert" className="text-xs text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Admin recovery controls for stale, obsolete, or unexecutable tasks (HUB-002).
 * Each action reuses an audited domain function — nothing here re-implements a
 * state transition — and each requires a written reason. The legend spells out
 * how the five recovery verbs differ so an operator picks the truthful one.
 */
export function TaskRecoveryControls({
  projectKey,
  taskId,
  candidates,
  showReconcile,
}: {
  projectKey: string;
  taskId: string;
  candidates: { id: string; title: string }[];
  /** Reconcile only makes sense while the task's derived state can be stale. */
  showReconcile: boolean;
}) {
  return (
    <details className="group">
      <summary className="cursor-pointer text-sm font-medium text-[var(--muted)] hover:text-[var(--foreground)]">
        Recovery actions
      </summary>
      <p className="mt-2 text-xs text-[var(--muted)]">
        These recover a task that is stale, obsolete, or can no longer be executed. None of them
        represent the proposed action as executed. To act on a single authorized-but-unexecuted
        action, use <strong>Withdraw</strong> on that action&apos;s approval; to deny an action still
        awaiting authorization, use <strong>Refuse</strong> there.
      </p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <div className="rounded-md border border-[var(--border)] p-3">
          <CancelRecovery projectKey={projectKey} taskId={taskId} />
        </div>
        <div className="rounded-md border border-[var(--border)] p-3">
          <Supersede projectKey={projectKey} taskId={taskId} candidates={candidates} />
        </div>
        {showReconcile ? (
          <div className="rounded-md border border-[var(--border)] p-3 sm:col-span-2">
            <Reconcile projectKey={projectKey} taskId={taskId} />
          </div>
        ) : null}
      </div>
    </details>
  );
}
