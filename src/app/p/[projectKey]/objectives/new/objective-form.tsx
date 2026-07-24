'use client';

import { useActionState, useRef, useState } from 'react';
import {
  submitObjective,
  suggestCriteria,
  type ObjectiveFormState,
  type SuggestionState,
} from '../actions';

const initialState: ObjectiveFormState = { error: null };
const initialSuggestions: SuggestionState = { suggestions: [], error: null };

interface Option {
  id: string;
  name: string;
}

const inputCls =
  'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]';

export function ObjectiveForm({
  projectKey,
  departments,
  employees,
}: {
  projectKey: string;
  departments: Option[];
  employees: Option[];
}) {
  const [state, formAction, pending] = useActionState(submitObjective, initialState);
  const [suggestState, suggestAction, suggesting] = useActionState(
    suggestCriteria,
    initialSuggestions,
  );
  const [criteriaRows, setCriteriaRows] = useState(1);
  const titleRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);

  // Suggestions are defaults in editable fields, never committed values.
  const suggested = suggestState.suggestions;
  const rowCount = Math.max(criteriaRows, suggested.length);

  return (
    <form action={formAction} className="space-y-5">
      <input type="hidden" name="projectKey" value={projectKey} />

      <div>
        <label htmlFor="title" className="mb-1 block text-sm text-[var(--muted)]">
          What are you trying to achieve?
        </label>
        <input
          ref={titleRef}
          id="title"
          name="title"
          required
          maxLength={200}
          placeholder='e.g. "Ship the AccurateBids beta"'
          className={inputCls}
        />
      </div>

      <div>
        <label htmlFor="description" className="mb-1 block text-sm text-[var(--muted)]">
          Description (optional)
        </label>
        <textarea
          ref={descriptionRef}
          id="description"
          name="description"
          rows={3}
          maxLength={4000}
          className={inputCls}
        />
      </div>

      <fieldset>
        <legend className="mb-1 text-sm text-[var(--muted)]">
          Success criteria — at least one is required to activate; the objective cannot complete
          until each is met or explicitly waived
        </legend>
        <div className="space-y-2">
          {Array.from({ length: rowCount }, (_, i) => {
            const s = suggested[i];
            return (
              <div key={`${i}-${s?.label ?? ''}`} className="grid grid-cols-[1fr_110px_90px] gap-2">
                <input
                  name="criterionLabel"
                  maxLength={200}
                  defaultValue={s?.label ?? ''}
                  placeholder={i === 0 ? 'e.g. "100 beta users signed up"' : 'Another criterion…'}
                  className={inputCls}
                />
                <input
                  name="criterionTarget"
                  type="number"
                  step="any"
                  defaultValue={s?.target ?? ''}
                  placeholder="Target"
                  className={inputCls}
                />
                <input
                  name="criterionUnit"
                  maxLength={50}
                  defaultValue={s?.unit ?? ''}
                  placeholder="Unit"
                  className={inputCls}
                />
                <input type="hidden" name="criterionMetric" value="" />
              </div>
            );
          })}
        </div>
        <div className="mt-2 flex items-center gap-4">
          <button
            type="button"
            onClick={() => setCriteriaRows((n) => Math.min(n + 1, 20))}
            className="text-xs text-[var(--accent)] hover:underline"
          >
            + Add criterion
          </button>
          <button
            type="button"
            disabled={suggesting}
            onClick={() => {
              const data = new FormData();
              data.set('projectKey', projectKey);
              data.set('title', titleRef.current?.value ?? '');
              data.set('description', descriptionRef.current?.value ?? '');
              suggestAction(data);
            }}
            className="text-xs text-[var(--accent)] hover:underline disabled:opacity-50"
          >
            {suggesting ? 'Thinking…' : 'Suggest criteria'}
          </button>
          {suggested.length > 0 ? (
            <span className="text-xs text-[var(--muted)]">
              Suggested — edit freely; nothing is saved until you create.
            </span>
          ) : null}
        </div>
        {suggestState.error ? (
          <p className="mt-1 text-xs text-[var(--danger)]">{suggestState.error}</p>
        ) : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="sponsoringDepartmentId" className="mb-1 block text-sm text-[var(--muted)]">
            Sponsoring department (optional)
          </label>
          <select id="sponsoringDepartmentId" name="sponsoringDepartmentId" defaultValue="" className={inputCls}>
            <option value="">—</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="accountableAgentId" className="mb-1 block text-sm text-[var(--muted)]">
            Accountable employee (optional)
          </label>
          <select id="accountableAgentId" name="accountableAgentId" defaultValue="" className={inputCls}>
            <option value="">—</option>
            {employees.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </div>
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
        {pending ? 'Creating…' : 'Create objective'}
      </button>
    </form>
  );
}
