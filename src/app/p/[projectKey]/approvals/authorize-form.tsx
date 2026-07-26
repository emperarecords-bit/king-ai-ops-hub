'use client';

import { useActionState, useState } from 'react';
import { decide, type DecisionState } from './actions';

const initialState: DecisionState = { error: null };

/**
 * The detail decision surface (approval §6). Authorization records narrow authority only — stated
 * immediately before submission. Consequential actions require an explicit, consequence-specific
 * confirmation (not a generic "are you sure?"). Refusal always requires a rationale.
 */
export function AuthorizeForm({
  projectKey,
  approvalId,
  requireConfirmation,
  confirmLabel,
}: {
  projectKey: string;
  approvalId: string;
  requireConfirmation: boolean;
  confirmLabel: string;
}) {
  const [state, formAction, pending] = useActionState(decide, initialState);
  const [confirmed, setConfirmed] = useState(false);
  const [note, setNote] = useState('');

  const canAuthorize = !pending && (!requireConfirmation || confirmed);
  const canRefuse = !pending && note.trim().length > 0;

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="approvalId" value={approvalId} />

      <div>
        <label className="mb-1 block text-xs text-[var(--muted)]">
          Rationale <span className="text-[var(--foreground)]">(required to refuse)</span>
        </label>
        <textarea
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={1000}
          placeholder="Why you are refusing — or context for authorizing. Becomes operational memory."
          className="w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
        />
      </div>

      {requireConfirmation ? (
        <label className="flex items-start gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="mt-0.5" />
          <span>{confirmLabel}</span>
        </label>
      ) : null}

      <p className="text-xs text-[var(--muted)]">
        Authorizing records narrow authorization for the action shown. This version does not execute it
        automatically.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          name="decision"
          value="approved"
          disabled={!canAuthorize}
          className="rounded-md bg-[var(--success)] px-4 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-50"
        >
          Authorize
        </button>
        <button
          type="submit"
          name="decision"
          value="rejected"
          disabled={!canRefuse}
          className="rounded-md bg-[var(--danger)] px-4 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-50"
        >
          Refuse
        </button>
        {requireConfirmation && !confirmed ? (
          <span className="text-xs text-[var(--muted)]">Confirm above to authorize.</span>
        ) : null}
      </div>
      {state.error ? (
        <p role="alert" className="text-sm text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
