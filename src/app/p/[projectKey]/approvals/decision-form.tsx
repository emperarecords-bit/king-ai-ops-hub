'use client';

import { useActionState } from 'react';
import { decide, type DecisionState } from './actions';

const initialState: DecisionState = { error: null };

export function DecisionForm({
  projectKey,
  approvalId,
}: {
  projectKey: string;
  approvalId: string;
}) {
  const [state, formAction, pending] = useActionState(decide, initialState);

  return (
    <form action={formAction} className="mt-3 flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="approvalId" value={approvalId} />
      <input
        name="note"
        placeholder="Decision note (optional)"
        maxLength={1000}
        className="min-w-48 flex-1 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-1.5 text-sm outline-none focus:border-[var(--accent)]"
      />
      <button
        type="submit"
        name="decision"
        value="approved"
        disabled={pending}
        className="rounded-md bg-[var(--success)] px-4 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-50"
      >
        Approve
      </button>
      <button
        type="submit"
        name="decision"
        value="rejected"
        disabled={pending}
        className="rounded-md bg-[var(--danger)] px-4 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-50"
      >
        Reject
      </button>
      {state.error ? (
        <p role="alert" className="w-full text-sm text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
