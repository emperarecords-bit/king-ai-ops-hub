'use client';

import { useEffect, useRef, useState } from 'react';

interface Proposal {
  kind: 'answer_question';
  questionId: string;
  projectKey: string;
  workspaceName: string;
  question: string;
  answer: string;
}

interface Msg {
  id: string;
  role: 'owner' | 'assistant';
  content: string;
  proposal?: Proposal;
  proposalState?: 'pending' | 'confirming' | 'done' | 'error';
  proposalError?: string;
}

const SUGGESTIONS = [
  'What needs me?',
  'How is AccurateBids doing?',
  "What's been failing?",
  "What are StressProbe's success criteria?",
];

const TOOL_LABEL: Record<string, string> = {
  get_objective_criteria: 'checking the criteria & blockers',
  list_objectives: 'listing objectives',
  list_tasks: 'listing tasks',
  get_task_detail: 'reading the run detail',
  list_open_questions: 'finding open questions',
  propose_answer_question: 'preparing the answer',
};

let seq = 0;
const nextId = () => `m${Date.now()}-${seq++}`;

function Rich({ text }: { text: string }) {
  const parts = text.split(/\*\*/);
  return (
    <span className="whitespace-pre-wrap">
      {parts.map((p, i) => (i % 2 === 1 ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>))}
    </span>
  );
}

/**
 * Ops Chat surface (v2). Streams model replies over SSE (fetch), shows what it's
 * looking up as tools run, and renders a confirm card when it proposes answering
 * an owner-question — the write only happens on the owner's Confirm.
 */
export function OpsChatClient({ opening }: { opening: string }) {
  const [messages, setMessages] = useState<Msg[]>([{ id: 'opening', role: 'assistant', content: opening }]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [toolActivity, setToolActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming, toolActivity]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function patch(id: string, fields: Partial<Msg>) {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...fields } : m)));
  }

  async function confirmProposal(id: string) {
    const m = messages.find((x) => x.id === id);
    if (!m?.proposal) return;
    patch(id, { proposalState: 'confirming', proposalError: undefined });
    try {
      const res = await fetch('/api/ops-chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'answer_question',
          projectKey: m.proposal.projectKey,
          questionId: m.proposal.questionId,
          answer: m.proposal.answer,
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Could not record the answer.');
      }
      patch(id, { proposalState: 'done' });
    } catch (e) {
      patch(id, { proposalState: 'error', proposalError: e instanceof Error ? e.message : 'Could not record the answer.' });
    }
  }

  async function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    setError(null);
    setInput('');
    setToolActivity(null);

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
          /* non-JSON */
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
          let payload: Record<string, unknown>;
          try {
            payload = JSON.parse(data);
          } catch {
            continue;
          }
          if (event === 'delta' && typeof payload.text === 'string') {
            append(payload.text);
            setToolActivity(null);
          } else if (event === 'tool') {
            if (payload.phase === 'start' && typeof payload.name === 'string') {
              setToolActivity(TOOL_LABEL[payload.name] ?? 'looking that up');
            } else if (payload.phase === 'end') {
              setToolActivity(null);
            }
          } else if (event === 'proposal') {
            patch(replyId, { proposal: payload as unknown as Proposal, proposalState: 'pending' });
          } else if (event === 'error') {
            streamError = typeof payload.message === 'string' ? payload.message : 'The assistant hit an error.';
          }
        }
      }

      if (streamError) {
        setError(streamError);
        setMessages((prev) => prev.filter((m) => !(m.id === replyId && m.content.trim().length === 0 && !m.proposal)));
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setMessages((prev) => prev.filter((m) => !(m.id === replyId && m.content.trim().length === 0 && !m.proposal)));
    } finally {
      setStreaming(false);
      setToolActivity(null);
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
              ) : m.role === 'assistant' && !m.proposal ? (
                <span className="opacity-60">{toolActivity ? `🔍 ${toolActivity}…` : 'Thinking…'}</span>
              ) : null}

              {m.proposal ? (
                <div className="mt-3 rounded-md border border-[var(--accent)] bg-[var(--surface-raised,rgba(120,160,255,0.06))] p-3">
                  {m.proposalState === 'done' ? (
                    <p className="text-sm text-[var(--success,#6bbf73)]">
                      ✓ Recorded — the answer is saved and added to {m.proposal.workspaceName}&apos;s knowledge.
                    </p>
                  ) : (
                    <>
                      <p className="text-xs uppercase tracking-wide text-[var(--muted)]">
                        Confirm — record this answer in {m.proposal.workspaceName}
                      </p>
                      <p className="mt-1 text-xs text-[var(--muted)]">Q: {m.proposal.question}</p>
                      <p className="mt-2 whitespace-pre-wrap text-sm">{m.proposal.answer}</p>
                      {m.proposalState === 'error' ? (
                        <p className="mt-2 text-xs text-[var(--danger,#c37474)]">{m.proposalError}</p>
                      ) : null}
                      <div className="mt-3 flex items-center gap-2">
                        <button
                          type="button"
                          disabled={m.proposalState === 'confirming'}
                          onClick={() => confirmProposal(m.id)}
                          className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
                        >
                          {m.proposalState === 'confirming' ? 'Recording…' : 'Confirm & record'}
                        </button>
                        <button
                          type="button"
                          disabled={m.proposalState === 'confirming'}
                          onClick={() => patch(m.id, { proposal: undefined, proposalState: undefined })}
                          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </div>
                    </>
                  )}
                </div>
              ) : null}
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
          placeholder="Ask about your hub — status, a project, why something failed, or answer a question…"
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
