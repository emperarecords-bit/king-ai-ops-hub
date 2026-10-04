'use client';

import { useEffect, useRef, useState } from 'react';

type Proposal =
  | { kind: 'answer_question'; questionId: string; projectKey: string; workspaceName: string; question: string; answer: string }
  | {
      kind: 'decide_approval';
      approvalId: string;
      projectKey: string;
      workspaceName: string;
      summary: string;
      decision: 'approved' | 'rejected';
      note: string;
    }
  | {
      kind: 'dispatch_task';
      projectKey: string;
      workspaceName: string;
      title: string;
      instructions: string;
      agentId: string;
      agentName: string;
    }
  | { kind: 'rerun_task'; projectKey: string; workspaceName: string; taskId: string; taskTitle: string };

interface ProposalItem {
  proposal: Proposal;
  state: 'pending' | 'confirming' | 'done' | 'error' | 'cancelled';
  error?: string;
}

interface Msg {
  id: string;
  role: 'owner' | 'assistant';
  content: string;
  proposals?: ProposalItem[];
}

const SUGGESTIONS = [
  'What needs me?',
  'What approvals are waiting on me?',
  "What are StressProbe's success criteria?",
  'Why did StressProbe stall?',
];

const TOOL_LABEL: Record<string, string> = {
  get_objective_criteria: 'checking the criteria & blockers',
  list_objectives: 'listing objectives',
  list_tasks: 'listing tasks',
  get_task_detail: 'reading the run detail',
  list_open_questions: 'finding open questions',
  list_pending_approvals: 'finding pending approvals',
  get_approval_detail: 'reading the approval',
  list_agents: 'listing the agents',
  propose_answer_question: 'preparing the answer',
  propose_decide_approval: 'preparing the decision',
  propose_dispatch_task: 'preparing the task',
  propose_rerun_task: 'preparing the re-run',
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

function doneLabel(p: Proposal): string {
  switch (p.kind) {
    case 'answer_question':
      return `✓ Recorded — saved and added to ${p.workspaceName}'s knowledge.`;
    case 'decide_approval':
      return `✓ ${p.decision === 'approved' ? 'Approved' : 'Rejected'} in ${p.workspaceName}.`;
    case 'dispatch_task':
      return `✓ Started — task queued in ${p.workspaceName}.`;
    case 'rerun_task':
      return `✓ Re-run queued for "${p.taskTitle}".`;
  }
}
function headerLabel(p: Proposal): string {
  switch (p.kind) {
    case 'answer_question':
      return `Confirm — record this answer in ${p.workspaceName}`;
    case 'decide_approval':
      return `Confirm — ${p.decision === 'approved' ? 'approve' : 'reject'} in ${p.workspaceName}`;
    case 'dispatch_task':
      return `Confirm — start a task in ${p.workspaceName} (uses tokens)`;
    case 'rerun_task':
      return `Confirm — re-run in ${p.workspaceName} (uses tokens)`;
  }
}
function confirmLabel(p: Proposal): string {
  switch (p.kind) {
    case 'answer_question':
      return 'Confirm & record';
    case 'decide_approval':
      return p.decision === 'approved' ? 'Confirm & approve' : 'Confirm & reject';
    case 'dispatch_task':
      return 'Confirm & start';
    case 'rerun_task':
      return 'Confirm & re-run';
  }
}
function confirmBody(p: Proposal): Record<string, unknown> {
  switch (p.kind) {
    case 'answer_question':
      return { action: 'answer_question', projectKey: p.projectKey, questionId: p.questionId, answer: p.answer };
    case 'decide_approval':
      return {
        action: 'decide_approval',
        projectKey: p.projectKey,
        approvalId: p.approvalId,
        decision: p.decision,
        note: p.note || undefined,
      };
    case 'dispatch_task':
      return {
        action: 'dispatch_task',
        projectKey: p.projectKey,
        title: p.title,
        instructions: p.instructions,
        agentId: p.agentId,
      };
    case 'rerun_task':
      return { action: 'rerun_task', projectKey: p.projectKey, taskId: p.taskId };
  }
}

/**
 * Ops Chat surface (v2.2). Streams replies over SSE, shows what it's looking up,
 * and renders a confirm card per proposed action — answering a question,
 * approving/rejecting, or dispatching/re-running work. The write (or run) happens
 * only on Confirm.
 */
export function OpsChatClient({ opening }: { opening: string }) {
  const [messages, setMessages] = useState<Msg[]>([{ id: 'opening', role: 'assistant', content: opening }]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [toolActivity, setToolActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming, toolActivity]);

  // Auto-grow the composer so a long message is fully visible at a glance,
  // up to a cap (then it scrolls). Shrinks back to one line after send.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [input]);

  useEffect(() => () => abortRef.current?.abort(), []);

  function setItem(msgId: string, index: number, fields: Partial<ProposalItem>) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && m.proposals
          ? { ...m, proposals: m.proposals.map((it, i) => (i === index ? { ...it, ...fields } : it)) }
          : m,
      ),
    );
  }

  async function confirmProposal(msgId: string, index: number) {
    const m = messages.find((x) => x.id === msgId);
    const item = m?.proposals?.[index];
    if (!item) return;
    setItem(msgId, index, { state: 'confirming', error: undefined });
    try {
      const res = await fetch('/api/ops-chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(confirmBody(item.proposal)),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'That did not go through.');
      }
      setItem(msgId, index, { state: 'done' });
    } catch (e) {
      setItem(msgId, index, { state: 'error', error: e instanceof Error ? e.message : 'That did not go through.' });
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
            const proposal = payload as unknown as Proposal;
            setMessages((prev) =>
              prev.map((m) =>
                m.id === replyId
                  ? { ...m, proposals: [...(m.proposals ?? []), { proposal, state: 'pending' as const }] }
                  : m,
              ),
            );
          } else if (event === 'error') {
            streamError = typeof payload.message === 'string' ? payload.message : 'The assistant hit an error.';
          }
        }
      }

      if (streamError) {
        setError(streamError);
        setMessages((prev) => prev.filter((m) => !(m.id === replyId && m.content.trim().length === 0 && !m.proposals)));
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setMessages((prev) => prev.filter((m) => !(m.id === replyId && m.content.trim().length === 0 && !m.proposals)));
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
                'px-3.5 py-2.5 text-sm leading-relaxed shadow-sm ' +
                (m.role === 'owner'
                  ? 'max-w-[75%] rounded-2xl rounded-br-sm bg-[var(--accent)] text-[#0b0e14]'
                  : 'max-w-[85%] rounded-2xl rounded-bl-sm border border-[var(--border)] bg-[var(--surface)]')
              }
            >
              <div className={'mb-1 text-xs ' + (m.role === 'owner' ? 'text-[#0b0e14]/60' : 'opacity-50')}>
                {m.role === 'owner' ? 'You' : 'Ops Chat'}
              </div>
              {m.content.length > 0 ? (
                <Rich text={m.content} />
              ) : m.role === 'assistant' && !m.proposals ? (
                <span className="opacity-60">{toolActivity ? `🔍 ${toolActivity}…` : 'Thinking…'}</span>
              ) : null}

              {m.proposals?.map((item, i) => {
                const p = item.proposal;
                return (
                  <div
                    key={i}
                    className="mt-3 rounded-md border border-[var(--accent)] bg-[var(--surface-raised,rgba(120,160,255,0.06))] p-3"
                  >
                    {item.state === 'done' ? (
                      <p className="text-sm text-[var(--success,#6bbf73)]">{doneLabel(p)}</p>
                    ) : item.state === 'cancelled' ? (
                      <p className="text-sm text-[var(--muted)]">Cancelled — nothing was changed.</p>
                    ) : (
                      <>
                        <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{headerLabel(p)}</p>

                        {p.kind === 'answer_question' ? (
                          <>
                            <p className="mt-1 text-xs text-[var(--muted)]">Q: {p.question}</p>
                            <p className="mt-2 whitespace-pre-wrap text-sm">{p.answer}</p>
                          </>
                        ) : p.kind === 'decide_approval' ? (
                          <>
                            <p className="mt-1 whitespace-pre-wrap text-sm">{p.summary}</p>
                            {p.note ? <p className="mt-1 text-xs text-[var(--muted)]">Note: {p.note}</p> : null}
                            {p.decision === 'rejected' && !p.note ? (
                              <p className="mt-1 text-xs text-[var(--danger,#c37474)]">
                                A rejection needs a short rationale — ask Ops Chat to add one.
                              </p>
                            ) : null}
                          </>
                        ) : p.kind === 'dispatch_task' ? (
                          <>
                            <p className="mt-1 text-sm font-semibold">{p.title}</p>
                            <p className="mt-1 whitespace-pre-wrap text-sm text-[var(--muted)]">{p.instructions}</p>
                            <p className="mt-1 text-xs text-[var(--muted)]">
                              Run by {p.agentName}. Starts an AI run and uses tokens.
                            </p>
                          </>
                        ) : (
                          <p className="mt-1 text-sm">
                            Re-run <span className="font-semibold">{p.taskTitle}</span>. Starts an AI run and uses tokens.
                          </p>
                        )}

                        {item.state === 'error' ? (
                          <p className="mt-2 text-xs text-[var(--danger,#c37474)]">{item.error}</p>
                        ) : null}
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            type="button"
                            disabled={item.state === 'confirming'}
                            onClick={() => confirmProposal(m.id, i)}
                            className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
                          >
                            {item.state === 'confirming' ? 'Working…' : confirmLabel(p)}
                          </button>
                          <button
                            type="button"
                            disabled={item.state === 'confirming'}
                            onClick={() => setItem(m.id, i, { state: 'cancelled', error: undefined })}
                            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
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
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          maxLength={4000}
          placeholder="Ask, answer, approve, or start work — all from here…"
          className="max-h-80 min-h-[3.5rem] w-full resize-none overflow-y-auto rounded border border-[var(--border)] bg-transparent p-2.5 text-sm leading-relaxed"
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
