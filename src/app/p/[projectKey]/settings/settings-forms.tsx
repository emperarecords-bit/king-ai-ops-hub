'use client';

import { useActionState } from 'react';
import { archiveWorkspace, saveWorkspaceSettings, type SettingsFormState } from './actions';

const initial: SettingsFormState = { error: null, saved: false };

const field =
  'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]';

export function WorkspaceSettingsForm({
  projectKey,
  name,
  description,
  monthlyBudgetUsd,
}: {
  projectKey: string;
  name: string;
  description: string;
  monthlyBudgetUsd: string;
}) {
  const [state, formAction, pending] = useActionState(saveWorkspaceSettings, initial);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="projectKey" value={projectKey} />

      <div>
        <label htmlFor="name" className="mb-1 block text-sm text-[var(--muted)]">
          Workspace name
        </label>
        <input id="name" name="name" defaultValue={name} required maxLength={100} className={field} />
      </div>

      <div>
        <label htmlFor="description" className="mb-1 block text-sm text-[var(--muted)]">
          Description
        </label>
        <textarea
          id="description"
          name="description"
          defaultValue={description}
          rows={3}
          maxLength={1_000}
          className={field}
        />
      </div>

      <div>
        <label htmlFor="monthlyBudgetUsd" className="mb-1 block text-sm text-[var(--muted)]">
          Monthly budget (USD)
        </label>
        <input
          id="monthlyBudgetUsd"
          name="monthlyBudgetUsd"
          type="number"
          step="1"
          min="1"
          max="10000"
          defaultValue={monthlyBudgetUsd}
          required
          className={`${field} max-w-40`}
        />
        <p className="mt-1 text-xs text-[var(--muted)]">
          Work stops when the month&apos;s spend reaches this. Changes are recorded in the audit
          log.
        </p>
      </div>

      {state.error ? (
        <p role="alert" className="rounded-md bg-[#3a2026] px-3 py-2 text-sm text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
      {state.saved && !state.error ? (
        <p className="text-sm text-[var(--success)]">Saved.</p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save changes'}
      </button>
    </form>
  );
}

export function ArchiveWorkspaceButton({
  projectKey,
  archived,
}: {
  projectKey: string;
  archived: boolean;
}) {
  const [state, formAction, pending] = useActionState(archiveWorkspace, initial);

  return (
    <form action={formAction}>
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="archived" value={archived ? 'false' : 'true'} />
      {state.error ? (
        <p role="alert" className="mb-2 text-sm text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={pending}
        className={
          archived
            ? 'rounded-md border border-[var(--border)] px-4 py-2 text-sm hover:bg-[var(--surface-raised)] disabled:opacity-50'
            : 'rounded-md border border-[var(--danger)] px-4 py-2 text-sm text-[var(--danger)] hover:bg-[#3a2026] disabled:opacity-50'
        }
      >
        {pending ? 'Working…' : archived ? 'Restore workspace' : 'Archive workspace'}
      </button>
    </form>
  );
}
