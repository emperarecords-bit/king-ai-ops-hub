'use client';

import { useActionState, useState } from 'react';
import { submitSchedule, toggleSchedule, type MutationState } from '../actions';

const initialState: MutationState = { error: null };

const inputCls =
  'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]';
const smallBtn =
  'rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function AddStandingWorkForm({
  projectKey,
  objectiveId,
  employees,
  reviewers = [],
}: {
  projectKey: string;
  objectiveId: string;
  employees: Array<{ id: string; name: string }>;
  reviewers?: Array<{ id: string; name: string }>;
}) {
  const [open, setOpen] = useState(false);
  const [cadence, setCadence] = useState<'daily' | 'weekly' | 'monthly'>('weekly');
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [state, formAction, pending] = useActionState(submitSchedule, initialState);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={smallBtn}>
        + Add standing work
      </button>
    );
  }

  return (
    <form action={formAction} className="mt-3 space-y-3 rounded-md border border-[var(--border)] p-3">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="objectiveId" value={objectiveId} />

      <input name="title" required maxLength={200} placeholder='e.g. "Weekly competitive summary"' className={inputCls} />
      <textarea
        name="input"
        required
        rows={3}
        maxLength={32_000}
        placeholder="The recurring brief — what should be produced each time?"
        className={inputCls}
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <select name="assigneeAgentId" required className={inputCls}>
          {employees.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select
          name="cadence"
          value={cadence}
          onChange={(e) => setCadence(e.target.value as typeof cadence)}
          className={inputCls}
        >
          <option value="daily">Every day</option>
          <option value="weekly">Every week</option>
          <option value="monthly">Every month</option>
        </select>
        {cadence === 'weekly' ? (
          <select name="weekday" defaultValue="1" className={inputCls}>
            {WEEKDAYS.map((day, i) => (
              <option key={day} value={i}>
                {day}s
              </option>
            ))}
          </select>
        ) : null}
        {cadence === 'monthly' ? (
          <input
            name="monthday"
            type="number"
            min={1}
            max={28}
            defaultValue={1}
            className={inputCls}
            aria-label="Day of month (1–28)"
          />
        ) : null}
        <select name="atHour" defaultValue="6" className={inputCls} aria-label="Hour (UTC)">
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {String(h).padStart(2, '0')}:00 UTC
            </option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="reviewEnabled"
          checked={reviewEnabled}
          onChange={(e) => setReviewEnabled(e.target.checked)}
          className="accent-[var(--accent)]"
        />
        {reviewEnabled ? 'Cross-check with an exact reviewer' : 'No automated review'}
      </label>
      {reviewEnabled ? (
        reviewers.length > 0 ? (
          <select name="reviewerAgentId" required defaultValue="" className={inputCls} aria-label="Reviewer employee">
            <option value="" disabled>
              Select a reviewer…
            </option>
            {reviewers.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        ) : (
          <p className="text-xs text-[var(--danger)]">
            No reviewer employees are configured. Add one, or turn off automated review.
          </p>
        )
      ) : null}
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Create standing work'}
        </button>
        <button type="button" onClick={() => setOpen(false)} className={smallBtn}>
          Cancel
        </button>
      </div>
      {state.error ? (
        <p role="alert" className="rounded-md bg-[#3a2026] px-3 py-2 text-sm text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function ToggleScheduleButton({
  projectKey,
  objectiveId,
  scheduleId,
  enabled,
}: {
  projectKey: string;
  objectiveId: string;
  scheduleId: string;
  enabled: boolean;
}) {
  const [state, formAction, pending] = useActionState(toggleSchedule, initialState);
  return (
    <form action={formAction} className="flex items-center gap-1">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="objectiveId" value={objectiveId} />
      <input type="hidden" name="scheduleId" value={scheduleId} />
      <button name="enabled" value={enabled ? 'false' : 'true'} disabled={pending} className={smallBtn}>
        {enabled ? 'Pause' : 'Resume'}
      </button>
      {state.error ? <span className="text-xs text-[var(--danger)]">{state.error}</span> : null}
    </form>
  );
}
