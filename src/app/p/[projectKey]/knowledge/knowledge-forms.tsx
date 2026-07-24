'use client';

import { useActionState, useState } from 'react';
import {
  submitKnowledge,
  submitKnowledgeRevision,
  submitKnowledgeStatus,
  type KnowledgeMutationState,
} from './actions';

const initialState: KnowledgeMutationState = { error: null };

const inputCls =
  'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]';
const smallBtn =
  'rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50';

function ErrorNote({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-2 rounded-md bg-[#3a2026] px-3 py-2 text-sm text-[var(--danger)]">
      {error}
    </p>
  );
}

const KIND_OPTIONS = [
  ['fact', 'Fact'],
  ['standard', 'Standard'],
  ['policy', 'Policy'],
  ['decision', 'Decision'],
  ['playbook', 'Playbook'],
  ['persona', 'Customer persona'],
  ['template', 'Template'],
  ['brand', 'Brand'],
] as const;

export function NewKnowledgeForm({ projectKey }: { projectKey: string }) {
  const [state, formAction, pending] = useActionState(submitKnowledge, initialState);
  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="projectKey" value={projectKey} />
      <div className="grid gap-3 sm:grid-cols-[1fr_180px]">
        <input name="title" required maxLength={200} placeholder="Title" className={inputCls} />
        <select name="kind" defaultValue="fact" className={inputCls}>
          {KIND_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </div>
      <textarea
        name="body"
        required
        rows={4}
        maxLength={20_000}
        placeholder="What should your team know? This is consulted before every piece of work in this workspace."
        className={inputCls}
      />
      <div className="flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="activate" defaultChecked className="accent-[var(--accent)]" />
          Activate immediately (you are the approver)
        </label>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
        >
          {pending ? 'Saving…' : 'Add knowledge'}
        </button>
      </div>
      <ErrorNote error={state.error} />
    </form>
  );
}

export function KnowledgeStatusButtons({
  projectKey,
  itemId,
  status,
}: {
  projectKey: string;
  itemId: string;
  status: string;
}) {
  const [state, formAction, pending] = useActionState(submitKnowledgeStatus, initialState);
  if (status === 'archived') return null;
  return (
    <form action={formAction} className="flex items-center gap-1">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="itemId" value={itemId} />
      {status === 'draft' ? (
        <button name="op" value="activate" disabled={pending} className={smallBtn}>
          Approve &amp; activate
        </button>
      ) : null}
      <button name="op" value="archive" disabled={pending} className={smallBtn}>
        {status === 'draft' ? 'Discard' : 'Retire'}
      </button>
      <ErrorNote error={state.error} />
    </form>
  );
}

export function ReviseKnowledgeForm({
  projectKey,
  itemId,
  currentBody,
}: {
  projectKey: string;
  itemId: string;
  currentBody: string;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, pending] = useActionState(submitKnowledgeRevision, initialState);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={smallBtn}>
        New version
      </button>
    );
  }
  return (
    <form action={formAction} className="mt-2 w-full space-y-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="itemId" value={itemId} />
      <textarea
        name="body"
        required
        rows={4}
        maxLength={20_000}
        defaultValue={currentBody}
        className={inputCls}
      />
      <div className="flex items-center gap-3">
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" name="activate" defaultChecked className="accent-[var(--accent)]" />
          Activate (archives the current version)
        </label>
        <button type="submit" disabled={pending} className={smallBtn}>
          Save version
        </button>
        <button type="button" onClick={() => setOpen(false)} className={smallBtn}>
          Cancel
        </button>
      </div>
      <ErrorNote error={state.error} />
    </form>
  );
}
