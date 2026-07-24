'use client';

import { useActionState } from 'react';
import { submitWorkspace, type WorkspaceFormState } from './actions';

const initialState: WorkspaceFormState = { error: null };

const inputCls =
  'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]';

export function WorkspaceForm() {
  const [state, formAction, pending] = useActionState(submitWorkspace, initialState);

  return (
    <form action={formAction} className="space-y-5">
      <div>
        <label htmlFor="name" className="mb-1 block text-sm text-[var(--muted)]">
          Workspace name
        </label>
        <input
          id="name"
          name="name"
          required
          minLength={2}
          maxLength={80}
          placeholder='e.g. "AccurateBids" or "Summer Campaign"'
          className={inputCls}
        />
      </div>
      <div>
        <label htmlFor="description" className="mb-1 block text-sm text-[var(--muted)]">
          What is this workspace for? (optional — becomes your team&apos;s first context)
        </label>
        <textarea id="description" name="description" rows={3} maxLength={500} className={inputCls} />
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
        {pending ? 'Setting up your team…' : 'Create workspace'}
      </button>
    </form>
  );
}
