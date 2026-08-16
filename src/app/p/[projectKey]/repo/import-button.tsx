'use client';

import { useActionState } from 'react';
import { importRepoFile, setContextItemStatus, type RepoActionState } from './actions';

const INITIAL: RepoActionState = { error: null, ok: null };

/** One-click "give this file to the employees" (admin imports arrive approved). */
export function ImportFileButton({ projectKey, repoFullName, path }: { projectKey: string; repoFullName: string; path: string }) {
  const [state, formAction, pending] = useActionState(importRepoFile, INITIAL);
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="repoFullName" value={repoFullName} />
      <input type="hidden" name="path" value={path} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-[var(--accent)] px-2 py-0.5 text-xs text-[var(--accent)] hover:opacity-80 disabled:opacity-40"
      >
        {pending ? 'Importing…' : 'Share with employees'}
      </button>
      {state.ok ? <span className="text-xs text-[var(--success)]">{state.ok}</span> : null}
      {state.error ? <span className="text-xs text-[var(--danger)]">{state.error}</span> : null}
    </form>
  );
}

/** Approve / archive controls on the shared-files list. */
export function ContextStatusButton({ projectKey, itemId, op }: { projectKey: string; itemId: string; op: 'approve' | 'archive' }) {
  const [state, formAction, pending] = useActionState(setContextItemStatus, INITIAL);
  return (
    <form action={formAction} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="itemId" value={itemId} />
      <input type="hidden" name="op" value={op} />
      <button
        type="submit"
        disabled={pending}
        className={`rounded border px-2 py-0.5 text-xs hover:opacity-80 disabled:opacity-40 ${
          op === 'approve' ? 'border-[var(--success)] text-[var(--success)]' : 'border-[var(--border)] text-[var(--muted)]'
        }`}
      >
        {op === 'approve' ? 'Approve' : 'Archive'}
      </button>
      {state.error ? <span className="text-xs text-[var(--danger)]">{state.error}</span> : null}
    </form>
  );
}
