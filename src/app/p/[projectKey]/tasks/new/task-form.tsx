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

export function TaskForm({
  projectKey,
  objectives = [],
  preselectedObjectiveId = null,
}: {
  projectKey: string;
  objectives?: Array<{ id: string; title: string }>;
  preselectedObjectiveId?: string | null;
}) {
  const [state, formAction, pending] = useActionState(submitTask, initialState);
  const [flagship, setFlagship] = useState(false);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="projectKey" value={projectKey} />

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

      <fieldset>
        <legend className="mb-2 text-sm text-[var(--muted)]">Provider</legend>
        <div className="flex gap-4">
          {(
            [
              ['openai', 'OpenAI'],
              ['anthropic', 'Anthropic'],
              ['both', 'Both (cross-review)'],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="providerSelection"
                value={value}
                defaultChecked={value === 'both'}
                className="accent-[var(--accent)]"
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="reviewEnabled"
          defaultChecked
          className="accent-[var(--accent)]"
        />
        Enable cross-provider review (the other vendor reviews; one revision allowed)
      </label>

      <div className="rounded-md border border-[var(--border)] p-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="flagship"
            checked={flagship}
            onChange={(e) => setFlagship(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          Use flagship models (GPT-5.2 + Opus — reserved for complex work, ~5× cost)
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
        disabled={pending}
        className="rounded-md bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create task'}
      </button>
    </form>
  );
}
