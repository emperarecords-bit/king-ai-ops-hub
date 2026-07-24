'use client';

import { useActionState } from 'react';
import { linkFolderAction, refreshIndexAction, type DocumentsState } from './actions';

const initial: DocumentsState = { error: null, message: null };

const btn =
  'rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50';
const field =
  'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]';

function Note({ state }: { state: DocumentsState }) {
  if (state.error) {
    return (
      <p role="alert" className="mt-2 rounded bg-[#3a2026] px-3 py-2 text-sm text-[var(--danger)]">
        {state.error}
      </p>
    );
  }
  if (state.message) {
    return (
      <p className="mt-2 rounded bg-[#1f3a2a] px-3 py-2 text-sm text-[var(--success)]">
        {state.message}
      </p>
    );
  }
  return null;
}

export function LinkFolderForm({
  projectKey,
  currentPath,
}: {
  projectKey: string;
  currentPath: string | null;
}) {
  const [state, action, pending] = useActionState(linkFolderAction, initial);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <label htmlFor="folderPath" className="block text-sm text-[var(--muted)]">
        Local folder path
      </label>
      <input
        id="folderPath"
        name="folderPath"
        defaultValue={currentPath ?? ''}
        placeholder="C:\\Users\\you\\Documents\\my-business"
        className={field}
      />
      <button type="submit" disabled={pending} className={btn}>
        {pending ? 'Linking…' : currentPath ? 'Update folder' : 'Link folder'}
      </button>
      <Note state={state} />
    </form>
  );
}

export function RefreshIndexButton({ projectKey }: { projectKey: string }) {
  const [state, action, pending] = useActionState(refreshIndexAction, initial);
  return (
    <form action={action}>
      <input type="hidden" name="projectKey" value={projectKey} />
      <button type="submit" disabled={pending} className={btn}>
        {pending ? 'Reading folder…' : 'Refresh index'}
      </button>
      <Note state={state} />
    </form>
  );
}
