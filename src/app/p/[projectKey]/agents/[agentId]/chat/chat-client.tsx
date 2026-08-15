'use client';

import { useActionState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { sendChatMessageAction, type ChatFormState } from './actions';

interface Entry {
  id: string;
  role: 'owner' | 'employee';
  content: string;
  at: string;
}

const INITIAL: ChatFormState = { error: null, sentAt: null };

/**
 * The texting surface. Server components own the data; this client only
 * renders entries, submits the form, and refreshes while a reply is pending.
 */
export function ChatClient({
  projectKey,
  agentId,
  entries,
  awaitingReply,
}: {
  projectKey: string;
  agentId: string;
  entries: Entry[];
  awaitingReply: boolean;
}) {
  const [state, formAction, pending] = useActionState(sendChatMessageAction, INITIAL);
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Poll while the employee is composing (their run hasn't finished).
  useEffect(() => {
    if (!awaitingReply) return;
    const timer = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(timer);
  }, [awaitingReply, router]);

  // A successful send: clear the box and pull the fresh thread.
  useEffect(() => {
    if (state.sentAt) {
      formRef.current?.reset();
      router.refresh();
    }
  }, [state.sentAt, router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [entries.length, awaitingReply]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex max-h-[60vh] min-h-[200px] flex-col gap-3 overflow-y-auto pr-1">
        {entries.length === 0 && (
          <p className="text-sm opacity-60">
            No messages yet. Say hello — ask for a status, give an instruction, or just ask what they can do.
          </p>
        )}
        {entries.map((e) => (
          <div key={e.id} className={e.role === 'owner' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={
                'max-w-[85%] whitespace-pre-wrap rounded-lg border px-3 py-2 text-sm ' +
                (e.role === 'owner'
                  ? 'border-[var(--border)] bg-[var(--accent-soft,rgba(120,160,255,0.08))]'
                  : 'border-[var(--border)]')
              }
            >
              <div className="mb-1 text-xs opacity-50">{e.role === 'owner' ? 'You' : 'Employee'}</div>
              {e.content}
            </div>
          </div>
        ))}
        {awaitingReply && (
          <div className="flex justify-start">
            <div className="rounded-lg border border-dashed border-[var(--border)] px-3 py-2 text-sm opacity-60">
              Working on a reply…
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form ref={formRef} action={formAction} className="flex flex-col gap-2">
        <input type="hidden" name="projectKey" value={projectKey} />
        <input type="hidden" name="agentId" value={agentId} />
        <textarea
          name="content"
          rows={3}
          maxLength={8000}
          required
          placeholder="Type a message…"
          className="w-full rounded border border-[var(--border)] bg-transparent p-2 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              formRef.current?.requestSubmit();
            }
          }}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs opacity-50">Enter to send · Shift+Enter for a new line</span>
          <button
            type="submit"
            disabled={pending}
            className="rounded border border-[var(--border)] px-4 py-1.5 text-sm hover:opacity-80 disabled:opacity-40"
          >
            {pending ? 'Sending…' : 'Send'}
          </button>
        </div>
        {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      </form>
    </div>
  );
}
