'use client';

import { useState, useTransition } from 'react';
import { resolveQuestionFromInbox, type QuestionAnswerState } from './actions';

const INITIAL: QuestionAnswerState = { error: null, resolved: false };

/**
 * "Answer all in this group": the SAME governed path as the single-question form —
 * `resolveQuestionFromInbox` is called once per question id, sequentially, after an explicit
 * confirmation. No batch write type exists; each call re-derives tenancy and admin authority
 * and records its own knowledge + audit entry. Stops at the first failure and says how far it got.
 */
export function GroupAnswerForm({ projectKey, questionIds }: { projectKey: string; questionIds: readonly string[] }) {
  const [answer, setAnswer] = useState('');
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const total = questionIds.length;

  if (done === total) {
    return <p className="text-sm text-[var(--success)]">Saved — all {total} questions answered; your answer is now workspace knowledge.</p>;
  }

  function submit() {
    if (answer.trim().length === 0) {
      setError('An answer is required.');
      return;
    }
    if (!window.confirm(`Save this same answer to all ${total} questions in this group? Each is recorded individually.`)) return;
    setError(null);
    startTransition(async () => {
      let answered = done;
      for (const questionId of questionIds.slice(done)) {
        const fd = new FormData();
        fd.set('projectKey', projectKey);
        fd.set('questionId', questionId);
        fd.set('intent', 'answer');
        fd.set('answer', answer);
        const res = await resolveQuestionFromInbox(INITIAL, fd);
        if (!res.resolved) {
          setError(`Answered ${answered} of ${total}. ${res.error ?? 'Something went wrong.'}`);
          setDone(answered);
          return;
        }
        answered += 1;
        setDone(answered);
      }
    });
  }

  return (
    <div className="space-y-2">
      <textarea
        value={answer}
        onChange={(e) => setAnswer(e.target.value)}
        rows={2}
        maxLength={8000}
        placeholder={`One answer for all ${total} — saved into this business's knowledge for each question…`}
        className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-60"
        >
          {pending ? `Saving… ${done}/${total}` : `Answer all ${total}`}
        </button>
        {error ? <span className="text-sm text-[var(--danger)]">{error}</span> : null}
      </div>
    </div>
  );
}
