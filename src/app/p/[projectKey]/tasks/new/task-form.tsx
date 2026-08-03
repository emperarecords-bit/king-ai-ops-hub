'use client';

import { useActionState, useState } from 'react';
import { submitTask, type TaskFormState } from '../actions';

const initialState: TaskFormState = { error: null };

/** Mirrors FLAGSHIP_CATEGORIES in src/types/domain.ts (approved reserved list). */
const FLAGSHIP_CATEGORY_OPTIONS = [
  ['architecture', 'Architecture'],
  ['security', 'Security'],
  ['database_design', 'Database design'],
  ['major_refactoring', 'Major refactoring'],
  ['product_strategy', 'Product strategy'],
  ['complex_reasoning', 'Complex reasoning'],
  ['release_review', 'Final release review'],
] as const;

/**
 * P1a agent pinning — a picker choice is now the EXACT employee that will execute (provider + model shown),
 * not a vendor hint. Reviewers are pinned the same way when cross-check is on.
 */
export interface EmployeeChoice {
  id: string;
  name: string;
  departmentName: string | null;
  provider: string;
  model: string;
  title?: string | null;
}

export function TaskForm({
  projectKey,
  objectives = [],
  preselectedObjectiveId = null,
  employees = [],
  reviewers = [],
}: {
  projectKey: string;
  objectives?: Array<{ id: string; title: string }>;
  preselectedObjectiveId?: string | null;
  employees?: EmployeeChoice[];
  reviewers?: EmployeeChoice[];
}) {
  const [state, formAction, pending] = useActionState(submitTask, initialState);
  const [flagship, setFlagship] = useState(false);
  const [reviewEnabled, setReviewEnabled] = useState(true);
  const [primaryId, setPrimaryId] = useState<string>(employees[0]?.id ?? '');
  const [reviewerId, setReviewerId] = useState<string>('');

  // Client guard (server is authoritative): a reviewer must differ from the selected primary. Because
  // primary and reviewer are disjoint technical roles this practically never fires, but the check keeps the
  // UI honest if the data ever overlaps.
  const reviewerSameAsPrimary = reviewEnabled && reviewerId !== '' && reviewerId === primaryId;
  const noReviewersAvailable = reviewEnabled && reviewers.length === 0;

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="projectKey" value={projectKey} />

      <fieldset>
        <legend className="mb-2 text-sm text-[var(--muted)]">Who should perform this work?</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {employees.map((e, i) => (
            <label
              key={e.id}
              className="flex cursor-pointer items-center gap-2 rounded-md border border-[var(--border)] px-3 py-2 text-sm has-[:checked]:border-[var(--accent)]"
            >
              <input
                type="radio"
                name="assigneeAgentId"
                value={e.id}
                defaultChecked={i === 0}
                onChange={() => setPrimaryId(e.id)}
                required
                className="accent-[var(--accent)]"
              />
              <span>
                <span className="font-medium">{e.name}</span>
                {e.departmentName ? (
                  <span className="ml-1 text-xs text-[var(--muted)]">{e.departmentName}</span>
                ) : null}
                <span className="block text-xs text-[var(--muted)]">
                  {e.provider} · {e.model}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {objectives.length > 0 ? (
        <div>
          <label htmlFor="objectiveId" className="mb-1 block text-sm text-[var(--muted)]">
            Objective this work advances (optional)
          </label>
          <select
            id="objectiveId"
            name="objectiveId"
            defaultValue={preselectedObjectiveId ?? ''}
            className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
          >
            <option value="">— standalone task —</option>
            {objectives.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div>
        <label htmlFor="title" className="mb-1 block text-sm text-[var(--muted)]">
          Title
        </label>
        <input
          id="title"
          name="title"
          required
          maxLength={200}
          placeholder="Short label for the task list"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
        />
      </div>

      <div>
        <label htmlFor="input" className="mb-1 block text-sm text-[var(--muted)]">
          Task brief
        </label>
        <textarea
          id="input"
          name="input"
          required
          rows={10}
          maxLength={32_000}
          placeholder="What should the agent do? Only this project's approved context will be loaded alongside this brief."
          className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-sm outline-none focus:border-[var(--accent)]"
        />
      </div>

      {/* P1a agent pinning — cross-check is now an EXACT reviewer pick, not an automatic opposing-provider
          reviewer. When on, an explicit reviewer employee is required. */}
      <div className="rounded-md border border-[var(--border)] p-3">
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
          <div className="mt-3">
            <label htmlFor="reviewerAgentId" className="mb-1 block text-sm text-[var(--muted)]">
              Reviewer employee (required)
            </label>
            {reviewers.length > 0 ? (
              <select
                id="reviewerAgentId"
                name="reviewerAgentId"
                required
                value={reviewerId}
                onChange={(e) => setReviewerId(e.target.value)}
                className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
              >
                <option value="" disabled>
                  Select a reviewer…
                </option>
                {reviewers.map((r) => (
                  <option key={r.id} value={r.id} disabled={r.id === primaryId}>
                    {r.name}
                    {r.departmentName ? ` · ${r.departmentName}` : ''} · {r.provider} · {r.model}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-[var(--danger)]">
                No reviewer employees are configured. Add one, or turn off automated review.
              </p>
            )}
            {reviewerSameAsPrimary ? (
              <p className="mt-1 text-xs text-[var(--danger)]">
                The reviewer must be a different employee than the primary.
              </p>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="rounded-md border border-[var(--border)] p-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="flagship"
            checked={flagship}
            onChange={(e) => setFlagship(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Assign senior staff (reserved for complex work · ~5× cost)
        </label>
        {flagship ? (
          <div className="mt-3">
            <label htmlFor="flagshipCategory" className="mb-1 block text-sm text-[var(--muted)]">
              Reason (required — flagship spend is always attributable)
            </label>
            <select
              id="flagshipCategory"
              name="flagshipCategory"
              required
              defaultValue=""
              className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]"
            >
              <option value="" disabled>
                Select a category…
              </option>
              {FLAGSHIP_CATEGORY_OPTIONS.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      {state.error ? (
        <p role="alert" className="rounded-md bg-[#3a2026] px-3 py-2 text-sm text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending || reviewerSameAsPrimary || noReviewersAvailable}
        className="rounded-md bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create task'}
      </button>
    </form>
  );
}
