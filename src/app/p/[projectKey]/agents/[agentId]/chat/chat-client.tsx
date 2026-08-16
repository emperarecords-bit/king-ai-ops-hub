'use client';

import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { sendChatMessageAction, type ChatFormState } from './actions';
import { speak, speechOutputSupported, stopSpeaking, useSpeechInput } from './use-speech';

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Voice input: final transcripts append into the (uncontrolled) textarea; the owner edits and sends.
  const speech = useSpeechInput((text) => {
    const box = textareaRef.current;
    if (!box) return;
    box.value = box.value ? `${box.value.replace(/\s+$/, '')} ${text}` : text;
  });
  // Voice replies: when on, each NEW employee message is read aloud as it arrives.
  const [autoSpeak, setAutoSpeak] = useState(false);
  const lastSpokenRef = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSpeak) return;
    const last = [...entries].reverse().find((e) => e.role === 'employee');
    if (!last) return;
    if (lastSpokenRef.current === null) {
      lastSpokenRef.current = last.id; // arm on the current tail; only messages after this are spoken
      return;
    }
    if (last.id !== lastSpokenRef.current) {
      lastSpokenRef.current = last.id;
      speak(last.content);
    }
  }, [autoSpeak, entries]);

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
              <div className="mb-1 flex items-center gap-2 text-xs opacity-50">
                {e.role === 'owner' ? 'You' : 'Employee'}
                {e.role === 'employee' && speechOutputSupported() ? (
                  <button
                    type="button"
                    onClick={() => speak(e.content)}
                    title="Read aloud"
                    aria-label="Read this message aloud"
                    className="rounded px-1 hover:opacity-100"
                  >
                    🔊
                  </button>
                ) : null}
              </div>
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
          ref={textareaRef}
          name="content"
          rows={3}
          maxLength={8000}
          required
          placeholder={speech.listening ? 'Listening… speak now' : 'Type a message, or tap the mic and talk…'}
          className="w-full rounded border border-[var(--border)] bg-transparent p-2 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              speech.stop();
              formRef.current?.requestSubmit();
            }
          }}
        />
        {speech.listening && speech.interim ? (
          <p className="text-xs italic opacity-60">{speech.interim}…</p>
        ) : null}
        {speech.error ? <p className="text-xs text-amber-400">{speech.error}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-3 text-xs opacity-50">
            Enter to send · Shift+Enter for a new line
            {speechOutputSupported() ? (
              <label className="flex cursor-pointer items-center gap-1">
                <input
                  type="checkbox"
                  checked={autoSpeak}
                  onChange={(e) => {
                    setAutoSpeak(e.target.checked);
                    if (!e.target.checked) stopSpeaking();
                  }}
                />
                Read replies aloud
              </label>
            ) : null}
          </span>
          <span className="flex items-center gap-2">
            {speech.supported ? (
              <button
                type="button"
                onClick={speech.toggle}
                title={speech.listening ? 'Stop listening' : 'Speak your message'}
                aria-label={speech.listening ? 'Stop listening' : 'Speak your message'}
                className={`rounded border px-3 py-1.5 text-sm hover:opacity-80 ${
                  speech.listening
                    ? 'animate-pulse border-[var(--danger,#c37474)] text-[var(--danger,#c37474)]'
                    : 'border-[var(--border)]'
                }`}
              >
                {speech.listening ? '● Listening' : '🎤 Speak'}
              </button>
            ) : (
              <span
                className="cursor-not-allowed rounded border border-[var(--border)] px-3 py-1.5 text-sm opacity-40"
                title="Voice input is not available in this browser — use Chrome, Edge, or Safari."
              >
                🎤 Speak
              </span>
            )}
            <button
              type="submit"
              disabled={pending}
              onClick={() => speech.stop()}
              className="rounded border border-[var(--border)] px-4 py-1.5 text-sm hover:opacity-80 disabled:opacity-40"
            >
              {pending ? 'Sending…' : 'Send'}
            </button>
          </span>
        </div>
        {state.error && <p className="text-sm text-red-400">{state.error}</p>}
      </form>
    </div>
  );
}
