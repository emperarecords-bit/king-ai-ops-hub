'use client';

import { useActionState } from 'react';
import {
  changeCriterionStatus,
  changeMilestoneStatus,
  changeObjectiveStatus,
  submitMilestone,
  type MutationState,
} from '../actions';

const initialState: MutationState = { error: null };

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
