'use client';

import { useActionState } from 'react';
import { withdrawAuthorization, type DecisionState } from './actions';

const initialState: DecisionState = { error: null };

/**
 * Withdraw an authorized-but-unexecuted action (HUB-002). Revokes a permission
 * already granted, before it executes — distinct from refusing a still-pending
 * action. Admin-only and reason-required (enforced in the domain). Kept quiet
 * behind a disclosure so it can't be mistaken for the primary decision path.
 */
export function WithdrawForm({
  projectKey,
  approvalId,
}: {
  projectKey: string;
  approvalId: string;
}) {
  const [state, formAction, pending] = useActionState(withdrawAuthorization, initialState);
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-sm text-[var(--muted)] hover:text-[var(--danger)]">
        Withdraw this authorization
      </summary>
      <p className="mt-2 text-xs text-[var(--muted)]">
        Use this only while the action has <strong>not</strong> executed. Withdrawing revokes the
        permission you granted; it does not undo an executed action and is never recorded as
        execution. The original authorization stays in the history — its state becomes “withdrawn.”
      </p>
      <form action={formAction} className="mt-2 flex flex-col gap-2">
        <input type="hidden" name="projectKey" value={projectKey} />
        <input type="hidden" name="approvalId" value={approvalId} />
        <textarea
          name="reason"
          rows={2}
          required
          maxLength={1000}
          placeholder="Why withdraw this authorization? (required — becomes operational memory)"
          className="w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm outline-none focus:border-[var(--danger)]"
        />
        <button
          type="submit"
          disabled={pending}
          className="self-start rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:border-[var(--danger)] hover:text-[var(--danger)] disabled:opacity-50"
        >
          {pending ? 'Withdrawing…' : 'Withdraw authorization'}
        </button>
        {state.error ? (
          <p role="alert" className="text-xs text-[var(--danger)]">
            {state.error}
          </p>
        ) : null}
      </form>
    </details>
  );
}
