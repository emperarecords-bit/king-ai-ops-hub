'use client';

import { useActionState } from 'react';
import { DECISION_TYPES } from '@/types/domain';
import { createDecisionAction, decideDecisionAction, type DecisionState } from './actions';

const initial: DecisionState = { error: null };
const field =
  'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm outline-none focus:border-[var(--accent)]';
const smallBtn =
  'rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50';

export function CreateDecisionForm({
  projectKey,
  supersedable,
}: {
  projectKey: string;
  supersedable: { id: string; title: string }[];
}) {
  const [state, action, pending] = useActionState(createDecisionAction, initial);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input name="title" required maxLength={200} placeholder="Decision title (e.g. Episode runtime fixed at 22:00)" className={field} />
      <textarea name="summary" required maxLength={2_000} rows={2} placeholder="Summary — the conclusion itself" className={field} />
      <textarea name="rationale" maxLength={4_000} rows={2} placeholder="Rationale — why (optional)" className={field} />
      <div className="flex flex-wrap gap-3">
        <select name="decisionType" className={field + ' max-w-xs'} aria-label="Decision type" defaultValue="operational">
          {DECISION_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {supersedable.length > 0 ? (
          <select name="supersedesId" className={field + ' max-w-xs'} aria-label="Supersedes" defaultValue="">
            <option value="">Supersedes nothing</option>
            {supersedable.map((d) => (
              <option key={d.id} value={d.id}>
                Supersedes: {d.title}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
      >
        {pending ? 'Filing…' : 'Propose decision'}
      </button>
      {state.error ? (
        <p role="alert" className="rounded bg-[#3a2026] px-3 py-2 text-sm text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

export function DecisionButtons({
  projectKey,
  decisionId,
}: {
  projectKey: string;
  decisionId: string;
}) {
  const [state, action, pending] = useActionState(decideDecisionAction, initial);
  return (
    <form action={action} className="inline-flex items-center gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="decisionId" value={decisionId} />
      <button name="verb" value="accept" disabled={pending} className={smallBtn}>
        Accept
      </button>
      <button name="verb" value="reject" disabled={pending} className={smallBtn}>
        Reject
      </button>
      {state.error ? <span className="text-xs text-[var(--danger)]">{state.error}</span> : null}
    </form>
  );
}
