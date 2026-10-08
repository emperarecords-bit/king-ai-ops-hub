'use client';

import { useActionState } from 'react';
import { markNotificationReadFromInbox, type NotificationReadState } from './actions';

const INITIAL: NotificationReadState = { error: null, read: false };

/** A small "Mark read" control for one in-app notification. RLS gates the write to the recipient. */
export function NotificationReadForm({ projectKey, notificationId }: { projectKey: string; notificationId: string }) {
  const [state, formAction, pending] = useActionState(markNotificationReadFromInbox, INITIAL);
  if (state.read) {
    return <span className="text-xs text-[var(--muted)]">Read</span>;
  }
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="notificationId" value={notificationId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-60"
      >
        {pending ? 'Marking…' : 'Mark read'}
      </button>
      {state.error ? <span className="text-xs text-[var(--danger)]">{state.error}</span> : null}
    </form>
  );
}
