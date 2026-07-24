'use client';

import { useActionState, useState } from 'react';
import {
  changeCriterionStatus,
  changeMilestoneStatus,
  changeObjectiveStatus,
  deleteCriterion,
  editCriterion,
  editObjectiveDetails,
  submitCriterion,
  submitMilestone,
  type MutationState,
} from '../actions';

const initialState: MutationState = { error: null };

const field =
  'rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-sm outline-none focus:border-[var(--accent)]';

const smallBtn =
  'rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50';

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-1 rounded bg-[#3a2026] px-2 py-1 text-xs text-[var(--danger)]">
      {error}
    </p>
  );
}

export function CriterionButtons({
  projectKey,
  objectiveId,
  index,
  status,
}: {
  projectKey: string;
  objectiveId: string;
  index: number;
  status: 'unmet' | 'met' | 'waived';
}) {
  const [state, formAction, pending] = useActionState(changeCriterionStatus, initialState);
  return (
    <form action={formAction} className="flex items-center gap-1">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="objectiveId" value={objectiveId} />
      <input type="hidden" name="index" value={index} />
      {status === 'unmet' ? (
        <>
          <button name="status" value="met" disabled={pending} className={smallBtn}>
            Mark met
          </button>
          <button name="status" value="waived" disabled={pending} className={smallBtn}>
            Waive
          </button>
        </>
      ) : (
        <button name="status" value="unmet" disabled={pending} className={smallBtn}>
          Reopen
        </button>
      )}
      <ErrorNote error={state.error} />
    </form>
  );
}

/**
 * Criterion row controls: status on the left, correction on the right.
 * Editing collapses by default — the common act is verifying a criterion, not
 * rewriting it, and a row of always-open inputs would bury that.
 */
export function CriterionEditor({
  projectKey,
  objectiveId,
  index,
  label,
  target,
  unit,
  canRemove,
}: {
  projectKey: string;
  objectiveId: string;
  index: number;
  label: string;
  target: number;
  unit: string;
  canRemove: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [editState, editAction, editPending] = useActionState(editCriterion, initialState);
  const [removeState, removeAction, removePending] = useActionState(deleteCriterion, initialState);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={smallBtn}>
        Edit
      </button>
    );
  }

  return (
    <div className="w-full space-y-2">
      <form action={editAction} className="flex flex-wrap items-center gap-2">
        <input type="hidden" name="projectKey" value={projectKey} />
        <input type="hidden" name="objectiveId" value={objectiveId} />
        <input type="hidden" name="index" value={index} />
        <input
          name="label"
          defaultValue={label}
          required
          maxLength={200}
          aria-label="Criterion"
          className={`${field} min-w-60 flex-1`}
        />
        <input
          name="target"
          type="number"
          step="any"
          min="0"
          defaultValue={target}
          required
          aria-label="Target"
          className={`${field} w-24`}
        />
        <input
          name="unit"
          defaultValue={unit}
          maxLength={50}
          aria-label="Unit"
          className={`${field} w-24`}
        />
        <button type="submit" disabled={editPending} className={smallBtn}>
          {editPending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={smallBtn}>
          Cancel
        </button>
      </form>

      <p className="text-xs text-[var(--muted)]">
        Changing the target or unit reopens this criterion — a check against the old measure
        says nothing about the new one.
      </p>

      {canRemove ? (
        <form action={removeAction}>
          <input type="hidden" name="projectKey" value={projectKey} />
          <input type="hidden" name="objectiveId" value={objectiveId} />
          <input type="hidden" name="index" value={index} />
          <button
            type="submit"
            disabled={removePending}
            className="rounded border border-[var(--danger)] px-2 py-1 text-xs text-[var(--danger)] hover:bg-[#3a2026] disabled:opacity-50"
          >
            {removePending ? 'Removing…' : 'Remove criterion'}
          </button>
        </form>
      ) : null}

      <ErrorNote error={editState.error ?? removeState.error} />
    </div>
  );
}

export function AddCriterionForm({
  projectKey,
  objectiveId,
}: {
  projectKey: string;
  objectiveId: string;
}) {
  const [state, formAction, pending] = useActionState(submitCriterion, initialState);
  return (
    <form action={formAction} className="mt-3 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-3">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="objectiveId" value={objectiveId} />
      <input
        name="label"
        required
        maxLength={200}
        placeholder="Add a criterion — how will you know?"
        aria-label="New criterion"
        className={`${field} min-w-60 flex-1`}
      />
      <input
        name="target"
        type="number"
        step="any"
        min="0"
        required
        placeholder="Target"
        aria-label="New criterion target"
        className={`${field} w-24`}
      />
      <input
        name="unit"
        maxLength={50}
        placeholder="Unit"
        aria-label="New criterion unit"
        className={`${field} w-24`}
      />
      <button type="submit" disabled={pending} className={smallBtn}>
        {pending ? 'Adding…' : 'Add'}
      </button>
      <ErrorNote error={state.error} />
    </form>
  );
}

export function ObjectiveDetailsEditor({
  projectKey,
  objectiveId,
  title,
  description,
}: {
  projectKey: string;
  objectiveId: string;
  title: string;
  description: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(editObjectiveDetails, initialState);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={smallBtn}>
        Edit
      </button>
    );
  }

  return (
    <form action={formAction} className="w-full space-y-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="objectiveId" value={objectiveId} />
      <input
        name="title"
        defaultValue={title}
        required
        maxLength={200}
        aria-label="Objective title"
        className={`${field} w-full`}
      />
      <textarea
        name="description"
        defaultValue={description}
        rows={3}
        maxLength={4_000}
        aria-label="Objective description"
        className={`${field} w-full`}
      />
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={smallBtn}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={smallBtn}>
          Cancel
        </button>
      </div>
      <ErrorNote error={state.error} />
    </form>
  );
}

export function ObjectiveStatusButtons({
  projectKey,
  objectiveId,
  status,
}: {
  projectKey: string;
  objectiveId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(changeObjectiveStatus, initialState);
  if (status === 'completed' || status === 'cancelled') return null;
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="objectiveId" value={objectiveId} />
      {status === 'draft' ? (
        <button
          name="next"
          value="active"
          disabled={pending}
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
        >
          Activate
        </button>
      ) : (
        <button
          name="next"
          value="completed"
          disabled={pending}
          className="rounded-md bg-[var(--success)] px-4 py-2 text-sm font-semibold text-[#0b0e14] disabled:opacity-50"
        >
          Mark completed
        </button>
      )}
      <button name="next" value="cancelled" disabled={pending} className={smallBtn}>
        Cancel objective
      </button>
      <ErrorNote error={state.error} />
    </form>
  );
}

export function AddMilestoneForm({
  projectKey,
  objectiveId,
}: {
  projectKey: string;
  objectiveId: string;
}) {
  const [state, formAction, pending] = useActionState(submitMilestone, initialState);
  return (
    <form action={formAction} className="mt-3 flex items-start gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="objectiveId" value={objectiveId} />
      <input
        name="title"
        required
        maxLength={200}
        placeholder="Add a milestone…"
        className="flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
      />
      <button type="submit" disabled={pending} className={smallBtn}>
        Add
      </button>
      <ErrorNote error={state.error} />
    </form>
  );
}

export function MilestoneStatusButton({
  projectKey,
  objectiveId,
  milestoneId,
  status,
}: {
  projectKey: string;
  objectiveId: string;
  milestoneId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(changeMilestoneStatus, initialState);
  const next =
    status === 'planned' ? 'active' : status === 'active' ? 'completed' : null;
  if (!next) return null;
  return (
    <form action={formAction} className="flex items-center gap-1">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="objectiveId" value={objectiveId} />
      <input type="hidden" name="milestoneId" value={milestoneId} />
      <button name="status" value={next} disabled={pending} className={smallBtn}>
        {next === 'active' ? 'Start' : 'Complete'}
      </button>
      <ErrorNote error={state.error} />
    </form>
  );
}
