'use client';

import { useActionState } from 'react';
import { resolveQuestionFromInbox, type QuestionAnswerState } from './actions';

const INITIAL: QuestionAnswerState = { error: null, resolved: false };

/** Answer box for one owner question. The answer becomes that workspace's knowledge. */
export function QuestionAnswerForm({ projectKey, questionId }: { projectKey: string; questionId: string }) {
  const [state, formAction, pending] = useActionState(resolveQuestionFromInbox, INITIAL);
  if (state.resolved) {
    return <p className="text-sm text-[var(--success)]">Saved — your answer is now workspace knowledge.</p>;
  }
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="questionId" value={questionId} />
      <textarea
        name="answer"
        rows={2}
        maxLength={8000}
        placeholder="Type your answer — it will be saved into this business's knowledge…"
        className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          name="intent"
          value="answer"
          disabled={pending}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-60"
        >
          {pending ? 'Saving…' : 'Answer'}
        </button>
        <button
          type="submit"
          name="intent"
          value="dismiss"
          disabled={pending}
          className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] disabled:opacity-60"
        >
          Dismiss
        </button>
        {state.error ? <span className="text-sm text-[var(--danger)]">{state.error}</span> : null}
      </div>
    </form>
  );
}
