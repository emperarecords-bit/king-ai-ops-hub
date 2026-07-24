'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { runTask, type RunActionState } from '../actions';

const initialState: RunActionState = { error: null };

export function RunButton({
  projectKey,
  taskId,
  autorun,
  label,
}: {
  projectKey: string;
  taskId: string;
  autorun: boolean;
  label: string;
}) {
  const [state, formAction, pending] = useActionState(runTask, initialState);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fired = useRef(false);

  // Auto-start immediately after task creation (?autorun=1) — one shot only.
  useEffect(() => {
    if (autorun && !fired.current) {
      fired.current = true;
      formRef.current?.requestSubmit();
    }
  }, [autorun]);

  useEffect(() => {
    if (!pending && fired.current) router.refresh();
  }, [pending, router]);

  return (
    <form ref={formRef} action={formAction} onSubmit={() => (fired.current = true)}>
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="taskId" value={taskId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-md bg-[var(--accent)] px-5 py-2 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
      >
        {pending ? 'Running… (this can take a minute)' : label}
      </button>
      {state.error ? (
        <p role="alert" className="mt-2 rounded-md bg-[#3a2026] px-3 py-2 text-sm text-[var(--danger)]">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
