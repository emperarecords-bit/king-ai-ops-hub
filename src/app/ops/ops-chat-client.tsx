'use client';

import { useEffect, useRef, useState } from 'react';

interface Msg {
  id: string;
  role: 'owner' | 'assistant';
  content: string;
}

const SUGGESTIONS = [
  'What needs me?',
  'How is AccurateBids doing?',
  "What's been failing?",
  "What has StressProbe been doing?",
];

let seq = 0;
const nextId = () => `m${Date.now()}-${seq++}`;

/** Minimal inline renderer: **bold** + preserved line breaks. No markdown lib. */
function Rich({ text }: { text: string }) {
  const parts = text.split(/\*\*/);
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>))}
    </span>
  );
}

/**
 * The Ops Chat surface. Renders the opening pulse, streams model replies from
 * /api/ops-chat word-by-word (SSE over fetch — EventSource can't POST), and
 * keeps a short history for follow-up context. Read-only in v1.
 */
export function OpsChatClient({ opening }: { opening: string }) {
  const [messages, setMessages] = useState<Msg[]>([{ id: 'opening', role: 'assistant', content: opening }]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    setError(null);
    setInput('');

    const history = messages
      .filter((m) => m.content.trim().length > 0)
      .slice(-10)
      .map((m) => ({ role: m.role === 'owner' ? ('user' as const) : ('assistant' as const), content: m.content }));

    const ownerMsg: Msg = { id: nextId(), role: 'owner', content: trimmed };
    const replyId = nextId();
    setMessages((prev) => [...prev, ownerMsg, { id: replyId, role: 'assistant', content: '' }]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const append = (delta: string) =>
      setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, content: m.content + delta } : m)));

    try {
      const res = await fetch('/api/ops-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: trimmed, history }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        let msg = 'Something went wrong.';
        try {
          const j = await res.json();
          if (j?.error) msg = String(j.error);
        } catch {
          /* non-JSON body */
        }
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let streamError: string | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          let event = 'message';
          let data = '';
          for (const line of chunk.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (!data) continue;
          let payload: { text?: string; message?: string };
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (event === 'delta' && payload.text) append(payload.text);
          else if (event === 'error') streamError = payload.message ?? 'The assistant hit an error.';
        }
      }

      if (streamError) {
        setError(streamError);
        // Drop the empty/partial reply bubble if nothing came back.
        setMessages((prev) => prev.filter((m) => !(m.id === replyId && m.content.trim().length === 0)));
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setMessages((prev) => prev.filter((m) => !(m.id === replyId && m.content.trim().length === 0)));
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto pr-1">
        {messages.map((m) => (
          <div key={m.id} className={m.role === 'owner' ? 'flex justify-end' : 'flex justify-start'}>
            <div
              className={
                'max-w-[88%] rounded-lg border px-3 py-2 text-sm leading-relaxed ' +
                (m.role === 'owner'
                  ? 'border-[var(--border)] bg-[var(--accent-soft,rgba(120,160,255,0.10))]'
                  : 'border-[var(--border)] bg-[var(--surface)]')
              }
            >
              <div className="mb-1 text-xs opacity-50">{m.role === 'owner' ? 'You' : 'Ops Chat'}</div>
              {m.content.length > 0 ? (
                <Rich text={m.content} />
              ) : (
                <span className="opacity-60">Thinking…</span>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {messages.length <= 1 ? (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => send(s)}
              disabled={streaming}
              className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40"
            >
              {s}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <p className="text-sm text-[var(--danger,#c37474)]">{error}</p> : null}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
        className="flex flex-col gap-2"
      >
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          maxLength={4000}
          placeholder="Ask about your hub — status, a project, a failure, what needs you…"
          className="w-full rounded border border-[var(--border)] bg-transparent p-2 text-sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs opacity-50">Enter to send · Shift+Enter for a new line</span>
          <button
            type="submit"
            disabled={streaming || input.trim().length === 0}
            className="rounded border border-[var(--border)] px-4 py-1.5 text-sm hover:opacity-80 disabled:opacity-40"
          >
            {streaming ? 'Answering…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
