'use client';

import { useActionState } from 'react';
import { removeSecret, saveSecret, type SecretFormState } from './actions';

const initialState: SecretFormState = { error: null, saved: false };

export function AddSecretForm({ projectKey }: { projectKey: string }) {
  const [state, formAction, pending] = useActionState(saveSecret, initialState);

  return (
    <form action={formAction} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="projectKey" value={projectKey} />
      <label className="block text-sm">
        <span className="mb-1 block text-[var(--muted)]">Name</span>
        <input
          name="name"
          required
          pattern="[A-Za-z0-9_\-]{2,64}"
          placeholder="github_token"
          className="rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm"
        />
      </label>
      <label className="block flex-1 text-sm">
        <span className="mb-1 block text-[var(--muted)]">Value (encrypted at rest)</span>
        <input
          name="value"
          type="password"
          required
          minLength={4}
          maxLength={4096}
          autoComplete="off"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm"
        />
      </label>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[var(--accent)] px-4 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save secret'}
      </button>
      {state.saved ? <span className="text-xs text-[var(--success)]">Saved.</span> : null}
      {state.error ? <span className="text-xs text-[var(--danger)]">{state.error}</span> : null}
    </form>
  );
}

export function DeleteSecretButton({
  projectKey,
  secretId,
}: {
  projectKey: string;
  secretId: string;
}) {
  const [state, formAction, pending] = useActionState(removeSecret, initialState);

  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="secretId" value={secretId} />
      <button
        type="submit"
        disabled={pending}
        className="text-xs text-[var(--danger)] hover:underline disabled:opacity-50"
      >
        {pending ? '…' : 'Delete'}
      </button>
      {state.error ? <span className="ml-2 text-xs text-[var(--danger)]">{state.error}</span> : null}
    </form>
  );
}
