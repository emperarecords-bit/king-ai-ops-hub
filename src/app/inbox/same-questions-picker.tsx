'use client';

import { useMemo, useState, useTransition } from 'react';
import { validateSameSelection, type SameSelectionWorkspace } from '@/domain/questions/same-selection';
import { resolveMany } from './resolve-many';

export interface PickerQuestion {
  readonly questionId: string;
  readonly question: string;
  readonly askedBy: string | null;
  /** ISO timestamp (plain data across the server→client boundary). */
  readonly createdAt: string;
}

/**
 * Owner-confirmed "these are the same": the owner ticks questions in ONE workspace that they judge
 * to be the same and resolves them with one answer or one dismissal. Nothing is merged automatically
 * and nothing is stored as a group: after an explicit confirmation each selected question is resolved
 * on its own id through the existing governed path (`resolveMany` → `resolveQuestionFromInbox`).
 */
export function SameQuestionsPicker({
  projectKey,
  workspaceName,
  questions,
}: {
  projectKey: string;
  workspaceName: string;
  questions: readonly PickerQuestion[];
}) {
  const workspace: SameSelectionWorkspace = useMemo(
    () => ({
      projectKey,
      workspaceName,
      questions: questions.map((q) => ({ ...q, projectKey, workspaceName, createdAt: new Date(q.createdAt) })),
    }),
    [projectKey, workspaceName, questions],
  );
  const [selected, setSelected] = useState<string[]>([]);
  const [answer, setAnswer] = useState('');
  const [progress, setProgress] = useState<{ ids: readonly string[]; done: number } | null>(null);
  const [message, setMessage] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(id: string) {
    setMessage(null);
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function run(intent: 'answer' | 'dismiss') {
    const v = validateSameSelection(workspace, selected);
    if (!v.ok) {
      setMessage({ kind: 'error', text: v.error });
      return;
    }
    if (intent === 'answer' && answer.trim().length === 0) {
      setMessage({ kind: 'error', text: 'An answer is required.' });
      return;
    }
    const n = v.questionIds.length;
    const prompt =
      intent === 'answer'
        ? `Treat these ${n} questions as the same and save this one answer to each? Each is recorded individually.`
        : `Treat these ${n} questions as the same and dismiss each of them?`;
    if (!window.confirm(prompt)) return;
    setMessage(null);
    const ids = v.questionIds;
    setProgress({ ids, done: 0 });
    startTransition(async () => {
      const res = await resolveMany(projectKey, ids, intent, answer, 0, (done) => setProgress({ ids, done }));
      const verb = intent === 'answer' ? 'Answered' : 'Dismissed';
      if (res.error) {
        setMessage({ kind: 'error', text: `${verb} ${res.resolved} of ${n}. ${res.error}` });
      } else {
        setMessage({ kind: 'success', text: `${verb} ${n} questions.` });
        setSelected([]);
        setAnswer('');
      }
    });
  }

  const count = new Set(selected).size;
  return (
    <details className="text-sm">
      <summary className="cursor-pointer text-xs text-[var(--muted)]">
        Are several of the {questions.length} questions from {workspaceName} the same? Select them and answer once
      </summary>
      <div className="mt-2 space-y-2">
        <ul className="max-h-80 space-y-1.5 overflow-y-auto border-l border-[var(--border)] pl-3">
          {questions.map((q) => (
            <li key={q.questionId}>
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.includes(q.questionId)}
                  onChange={() => toggle(q.questionId)}
                  disabled={pending}
                />
                <span>
                  <span className="block text-xs text-[var(--muted)]">
                    {q.askedBy ? `asked by ${q.askedBy} · ` : ''}
                    {q.createdAt.slice(0, 16).replace('T', ' ')} UTC
                  </span>
                  {q.question}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <textarea
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          rows={2}
          maxLength={8000}
          disabled={pending}
          placeholder="One answer for every selected question — saved into this business's knowledge for each…"
          className="w-full rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm"
        />
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => run('answer')}
            disabled={pending || count < 2}
            className="rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-60"
          >
            {pending && progress ? `Saving… ${progress.done}/${progress.ids.length}` : `Answer ${count} selected as the same`}
          </button>
          <button
            type="button"
            onClick={() => run('dismiss')}
            disabled={pending || count < 2}
            className="rounded border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] disabled:opacity-60"
          >
            Dismiss {count} selected
          </button>
          {message ? (
            <span className={`text-sm ${message.kind === 'error' ? 'text-[var(--danger)]' : 'text-[var(--success)]'}`}>
              {message.text}
            </span>
          ) : null}
        </div>
      </div>
    </details>
  );
}
