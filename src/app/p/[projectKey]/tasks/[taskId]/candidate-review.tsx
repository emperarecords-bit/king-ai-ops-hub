'use client';

import { useActionState, useState } from 'react';
import { reviewCandidateAction, type CandidateState } from './candidate-actions';

const initial: CandidateState = { error: null };
const smallBtn =
  'rounded border border-[var(--border)] px-2 py-1 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-50';
const field =
  'w-full rounded-md border border-[var(--border)] bg-[var(--background)] px-2 py-1 text-sm outline-none focus:border-[var(--accent)]';

export interface Candidate {
  id: string;
  title: string;
  summary: string;
  rationale: string;
  decisionType: string;
  confidence: string | null;
  evidence: string | null;
  supersedesTitle: string | null;
  originatingTaskId: string | null;
  suggestedByRunId: string | null;
  reviewedAt: string | null;
}

export function CandidateReview({
  projectKey,
  taskId,
  candidate,
}: {
  projectKey: string;
  taskId: string;
  candidate: Candidate;
}) {
  const [state, action, pending] = useActionState(reviewCandidateAction, initial);
  const [editing, setEditing] = useState(false);

  return (
    <li className="rounded-md border border-[var(--border)] p-3">
      <div className="mb-1 flex flex-wrap items-center gap-2">
        <span className="rounded bg-[#3a3220] px-2 py-0.5 text-xs font-semibold uppercase text-[#e5c07b]">
          AI suggestion — not an accepted decision
        </span>
        <span className="text-xs text-[var(--muted)]">{candidate.decisionType}</span>
        {candidate.confidence ? (
          <span className="text-xs text-[var(--muted)]">confidence: {candidate.confidence}</span>
        ) : null}
        {candidate.reviewedAt ? (
          <span className="text-xs text-[var(--muted)]">· deferred</span>
        ) : null}
      </div>

      {editing ? (
        <form action={action} className="space-y-2">
          <input type="hidden" name="projectKey" value={projectKey} />
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="decisionId" value={candidate.id} />
          <input type="hidden" name="verb" value="edit_accept" />
          <input name="title" defaultValue={candidate.title} required maxLength={200} className={field} />
          <textarea name="summary" defaultValue={candidate.summary} required rows={2} className={field} />
          <textarea name="rationale" defaultValue={candidate.rationale} rows={2} className={field} />
          <div className="flex gap-2">
            <button type="submit" disabled={pending} className={smallBtn}>
              {pending ? 'Saving…' : 'Save & accept'}
            </button>
            <button type="button" onClick={() => setEditing(false)} className={smallBtn}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="text-sm font-medium">{candidate.title}</div>
          <div className="text-sm text-[var(--muted)]">{candidate.summary}</div>
          {candidate.rationale ? (
            <div className="mt-1 text-xs text-[var(--muted)]">Rationale: {candidate.rationale}</div>
          ) : null}
          {candidate.evidence ? (
            <div className="mt-1 text-xs text-[var(--muted)]">Evidence: {candidate.evidence}</div>
          ) : null}
          {candidate.supersedesTitle ? (
            <div className="mt-1 text-xs text-[var(--danger)]">
              Proposed supersession of: “{candidate.supersedesTitle}” — requires your confirmation.
            </div>
          ) : null}
          <form action={action} className="mt-2 flex flex-wrap items-center gap-2">
            <input type="hidden" name="projectKey" value={projectKey} />
            <input type="hidden" name="taskId" value={taskId} />
            <input type="hidden" name="decisionId" value={candidate.id} />
            <button name="verb" value="accept" disabled={pending} className={smallBtn}>
              Accept
            </button>
            <button type="button" onClick={() => setEditing(true)} className={smallBtn}>
              Edit & accept
            </button>
            <button name="verb" value="reject" disabled={pending} className={smallBtn}>
              Reject
            </button>
            <button name="verb" value="defer" disabled={pending} className={smallBtn}>
              Defer
            </button>
          </form>
        </>
      )}
      {state.error ? <p className="mt-1 text-xs text-[var(--danger)]">{state.error}</p> : null}
    </li>
  );
}
