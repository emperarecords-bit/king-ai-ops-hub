'use client';

import { useActionState } from 'react';
import { decideFromInbox, type InboxDecisionState } from './actions';

const INITIAL: InboxDecisionState = { error: null, executed: null };

/** Two buttons, one decision. The detail page (linked above) carries the full
 *  consequence record for anything that deserves a closer look first. */
export function InboxDecisionForm({ projectKey, approvalId }: { projectKey: string; approvalId: string }) {
  const [state, formAction, pending] = useActionState(decideFromInbox, INITIAL);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="approvalId" value={approvalId} />
      <button
        type="submit"
        name="decision"
        value="approved"
        disabled={pending}
        className="rounded border border-[var(--success,#3d6b58)] px-4 py-1 text-sm text-[var(--success,#74c3a4)] hover:opacity-80 disabled:opacity-40"
      >
        Okay
      </button>
      <button
        type="submit"
        name="decision"
        value="rejected"
        disabled={pending}
        className="rounded border border-[var(--danger,#6b3d3d)] px-4 py-1 text-sm text-[var(--danger,#c37474)] hover:opacity-80 disabled:opacity-40"
      >
        No
      </button>
      {state.error ? <span className="text-xs text-red-400">{state.error}</span> : null}
      {state.executed ? (
        <span className={`text-xs ${state.executed.outcome === 'succeeded' ? 'text-[var(--success,#74c3a4)]' : 'text-amber-400'}`}>
          {state.executed.message}
          {state.executed.prUrl ? (
            <>
              {' '}
              <a href={state.executed.prUrl} target="_blank" rel="noreferrer" className="underline">
                View PR
              </a>
            </>
          ) : null}
        </span>
      ) : null}
    </form>
  );
}
