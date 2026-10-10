'use client';

import { useEffect, useRef, useState } from 'react';
import { consumeOpsChatStream } from './ops-chat-stream';
import { OPS_CHAT_CLIENT_TIMEOUT_MS, OPS_CHAT_TIMEOUT_MESSAGE } from '@/domain/opschat/limits';

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
  | { kind: 'rerun_task'; projectKey: string; workspaceName: string; taskId: string; taskTitle: string }
  | {
      kind: 'github_pr';
      projectKey: string;
      workspaceName: string;
      repo: string;
      branch: string;
      baseBranch: string;
      title: string;
      body: string;
      riskClass: string;
      files: Array<{ path: string; content: string }>;
    }
  | {
      kind: 'github_merge';
      projectKey: string;
      workspaceName: string;
      repo: string;
      prNumber: number;
      expectedHeadSha: string;
      expectedBaseBranch: string;
      mergeMethod: 'squash' | 'merge' | 'rebase';
      riskClass: string;
    }
  | {
      kind: 'github_rerun';
      projectKey: string;
      workspaceName: string;
      repo: string;
      runId: number;
      expectedHeadSha: string;
      expectedRunAttempt: number;
      riskClass: string;
    }
  | {
      kind: 'supabase_deploy';
      projectKey: string;
      workspaceName: string;
      projectRef: string;
      functionSlug: string;
      sourceRepo: string;
      sourceSha: string;
      sourcePath: string;
      entrypointPath: string;
      importMapPath: string | null;
      verifyJwt: boolean;
      riskClass: string;
    };

interface ProposalItem {
  proposal: Proposal;
  state: 'pending' | 'confirming' | 'done' | 'error' | 'cancelled';
  error?: string;
  result?: {
    outcome?: string | null;
    message?: string | null;
    prUrl?: string | null;
    mergeCommitSha?: string | null;
    runId?: number | null;
    attempt?: number | null;
    runState?: string | null;
    runUrl?: string | null;
    version?: number | null;
    contentDigest?: string | null;
  };
}

type Confidence = 'low' | 'medium' | 'high';

interface CouncilReviewer {
  role: string;
  label: string;
  provider: string;
  ok: boolean;
  conclusion: string;
}

interface CouncilSynthesis {
  agreement: string[];
  disagreements: string[];
  recommendation: string;
  risks: string[];
  confidence: Confidence;
  ownerDecisionNeeded: string[];
}

interface CouncilResult {
  synthesis: CouncilSynthesis;
  reviewers: CouncilReviewer[];
  degraded: boolean;
}

interface CouncilState {
  status: 'running' | 'done' | 'error';
  result?: CouncilResult;
  error?: string;
  showReviewers?: boolean;
}

interface Msg {
  id: string;
  role: 'owner' | 'assistant';
  content: string;
  /** The owner question that produced this assistant answer (enables "Ask Council"). */
  question?: string;
  proposals?: ProposalItem[];
  council?: CouncilState;
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
  github_capabilities: 'checking GitHub capabilities',
  list_github_repos: 'listing linked repositories',
  list_pull_requests: 'reading pull requests',
  get_pull_request: 'reading the pull request & CI',
  get_workflow_run: 'reading the workflow run',
  propose_github_pr: 'preparing the pull request',
  propose_github_merge: 'preparing the merge',
  propose_github_rerun: 'preparing the re-run',
  supabase_capabilities: 'checking Supabase capabilities',
  list_supabase_projects: 'listing linked Supabase projects',
  inspect_supabase_project: 'reading the Supabase project',
  inspect_edge_functions: 'reading edge functions',
  inspect_migrations: 'reading Supabase migrations',
  propose_supabase_deploy: 'preparing the deploy',
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
    case 'github_pr':
      return `✓ Pull request requested in ${p.repo}.`;
    case 'github_merge':
      return `✓ Merge requested for PR #${p.prNumber} in ${p.repo}.`;
    case 'github_rerun':
      return `✓ Re-run requested for run ${p.runId} in ${p.repo}.`;
    case 'supabase_deploy':
      return `✓ Deploy requested for "${p.functionSlug}" in project ${p.projectRef}.`;
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
    case 'github_pr':
      return `Confirm — open a pull request in ${p.repo}`;
    case 'github_merge':
      return `Confirm — merge PR #${p.prNumber} in ${p.repo}`;
    case 'github_rerun':
      return `Confirm — re-run failed jobs of run ${p.runId} in ${p.repo}`;
    case 'supabase_deploy':
      return `Confirm — deploy "${p.functionSlug}" to project ${p.projectRef}`;
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
    case 'github_pr':
      return 'Confirm & open PR';
    case 'github_merge':
      return 'Confirm & merge';
    case 'github_rerun':
      return 'Confirm & re-run';
    case 'supabase_deploy':
      return 'Confirm & deploy';
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
    case 'github_pr':
      return {
        action: 'execute_github_pr',
        projectKey: p.projectKey,
        repo: p.repo,
        branch: p.branch,
        baseBranch: p.baseBranch,
        title: p.title,
        body: p.body || undefined,
        files: p.files,
      };
    case 'github_merge':
      return {
        action: 'execute_github_merge',
        projectKey: p.projectKey,
        repo: p.repo,
        prNumber: p.prNumber,
        expectedHeadSha: p.expectedHeadSha,
        expectedBaseBranch: p.expectedBaseBranch,
        mergeMethod: p.mergeMethod,
      };
    case 'github_rerun':
      return {
        action: 'execute_github_rerun',
        projectKey: p.projectKey,
        repo: p.repo,
        runId: p.runId,
        expectedHeadSha: p.expectedHeadSha,
        expectedRunAttempt: p.expectedRunAttempt,
      };
    case 'supabase_deploy':
      return {
        action: 'execute_supabase_deploy',
        projectKey: p.projectKey,
        projectRef: p.projectRef,
        functionSlug: p.functionSlug,
        sourceRepo: p.sourceRepo,
        sourceSha: p.sourceSha,
        sourcePath: p.sourcePath,
        entrypointPath: p.entrypointPath,
        importMapPath: p.importMapPath ?? undefined,
        verifyJwt: p.verifyJwt,
      };
  }
}

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: 'text-[var(--success,#6bbf73)] border-[var(--success,#6bbf73)]',
  medium: 'text-[var(--accent)] border-[var(--accent)]',
  low: 'text-[var(--danger,#c37474)] border-[var(--danger,#c37474)]',
};

function CouncilList({ title, items }: { title: string; items: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">{title}</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-sm">
        {items.map((it, i) => (
          <li key={i} className="whitespace-pre-wrap">{it}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The owner-triggered Council review surface for one assistant answer. It shows
 * an "Ask Council" button (Council never runs on its own), a running state while
 * the independent reviewers work, and one compact synthesis card with optional
 * drill-down into each reviewer's concise conclusion. Stacks vertically for
 * mobile — no fixed widths.
 */
function CouncilBlock({
  state,
  disabled,
  onAsk,
  onToggleReviewers,
}: {
  state: CouncilState | undefined;
  disabled: boolean;
  onAsk: () => void;
  onToggleReviewers: () => void;
}) {
  if (!state) {
    return (
      <div className="mt-3">
        <button
          type="button"
          disabled={disabled}
          onClick={onAsk}
          className="rounded-full border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          ⚖️ Ask Council
        </button>
        <p className="mt-1 text-[11px] text-[var(--muted)]">
          Gets several independent model reviews (accuracy · risk · alternative) — uses extra model calls.
        </p>
      </div>
    );
  }

  if (state.status === 'running') {
    return (
      <div className="mt-3 rounded-md border border-[var(--border)] bg-[var(--surface-raised,rgba(120,160,255,0.06))] p-3">
        <p className="text-sm">⚖️ Council is reviewing…</p>
        <p className="mt-1 text-xs text-[var(--muted)]">
          Accuracy · Risk · Alternative reviewers running independently. This uses several model calls.
        </p>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="mt-3 rounded-md border border-[var(--border)] p-3">
        <p className="text-sm text-[var(--danger,#c37474)]">⚖️ {state.error ?? 'Council is unavailable right now.'}</p>
        <button
          type="button"
          disabled={disabled}
          onClick={onAsk}
          className="mt-2 rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          Try again
        </button>
      </div>
    );
  }

  const r = state.result;
  if (!r) return null;
  const s = r.synthesis;
  return (
    <div className="mt-3 flex flex-col gap-1 rounded-md border border-[var(--accent)] bg-[var(--surface-raised,rgba(120,160,255,0.06))] p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">⚖️ Council review</p>
        <span className={'rounded-full border px-2 py-0.5 text-[11px] font-semibold ' + CONFIDENCE_STYLE[s.confidence]}>
          {s.confidence} confidence
        </span>
        {r.degraded ? (
          <span className="text-[11px] text-[var(--muted)]">· some reviewers unavailable</span>
        ) : null}
      </div>

      {s.recommendation ? (
        <div className="mt-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-[var(--muted)]">Strongest recommendation</p>
          <p className="mt-0.5 whitespace-pre-wrap text-sm">{s.recommendation}</p>
        </div>
      ) : null}

      <CouncilList title="Agreement" items={s.agreement} />
      <CouncilList title="Disagreements" items={s.disagreements} />
      <CouncilList title="Risks & caveats" items={s.risks} />
      <CouncilList title="Still needs your judgement" items={s.ownerDecisionNeeded} />

      <div className="mt-2">
        <button
          type="button"
          onClick={onToggleReviewers}
          className="text-xs text-[var(--muted)] underline underline-offset-2 hover:text-[var(--foreground)]"
        >
          {state.showReviewers ? 'Hide reviewer notes' : `Show reviewer notes (${r.reviewers.length})`}
        </button>
        {state.showReviewers ? (
          <div className="mt-2 flex flex-col gap-2">
            {r.reviewers.map((rev, i) => (
              <div key={i} className="rounded border border-[var(--border)] p-2">
                <p className="text-xs font-semibold">{rev.label}</p>
                {rev.ok ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm">{rev.conclusion}</p>
                ) : (
                  <p className="mt-1 text-xs text-[var(--muted)]">Unavailable for this review.</p>
                )}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <p className="mt-2 text-[11px] text-[var(--muted)]">
        Council is review-only and changes nothing. To act on this, ask Ops Chat to prepare it — actions still go through confirm.
      </p>
    </div>
  );
}

/**
 * Ops Chat surface (v2.2 + Council). Streams replies over SSE, shows what it's
 * looking up, and renders a confirm card per proposed action — answering a
 * question, approving/rejecting, or dispatching/re-running work. The write (or
 * run) happens only on Confirm. Each completed answer also offers an optional,
 * owner-triggered Council review (multiple independent model reviews → synthesis).
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
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || 'That did not go through.');
      const executed = j?.executed as
        | {
            outcome?: string | null;
            message?: string | null;
            prUrl?: string | null;
            mergeCommitSha?: string | null;
            runId?: number | null;
            attempt?: number | null;
            state?: string | null;
            runUrl?: string | null;
            version?: number | null;
            contentDigest?: string | null;
          }
        | undefined;
      // A governed action can reach the confirm path but still be blocked/failed by dispatch (e.g. the
      // executor is disabled, or a merge precondition failed). Surface that honestly rather than a false "done".
      const isGovernedMutation =
        item.proposal.kind === 'github_pr' ||
        item.proposal.kind === 'github_merge' ||
        item.proposal.kind === 'github_rerun' ||
        item.proposal.kind === 'supabase_deploy';
      if (isGovernedMutation && executed && executed.outcome !== 'succeeded') {
        setItem(msgId, index, { state: 'error', error: executed.message || `The action ${executed.outcome ?? 'did not run'}.` });
        return;
      }
      setItem(msgId, index, {
        state: 'done',
        result: executed
          ? {
              outcome: executed.outcome,
              message: executed.message,
              prUrl: executed.prUrl ?? null,
              mergeCommitSha: executed.mergeCommitSha ?? null,
              runId: executed.runId ?? null,
              attempt: executed.attempt ?? null,
              runState: executed.state ?? null,
              runUrl: executed.runUrl ?? null,
              version: executed.version ?? null,
              contentDigest: executed.contentDigest ?? null,
            }
          : undefined,
      });
    } catch (e) {
      setItem(msgId, index, { state: 'error', error: e instanceof Error ? e.message : 'That did not go through.' });
    }
  }

  function setCouncil(msgId: string, fields: Partial<CouncilState>) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId ? { ...m, council: { ...(m.council ?? { status: 'running' }), ...fields } } : m,
      ),
    );
  }

  function toggleReviewers(msgId: string) {
    setMessages((prev) =>
      prev.map((m) => (m.id === msgId && m.council ? { ...m, council: { ...m.council, showReviewers: !m.council.showReviewers } } : m)),
    );
  }

  async function askCouncil(msgId: string) {
    const m = messages.find((x) => x.id === msgId);
    if (!m || m.role !== 'assistant' || !m.question || m.content.trim().length === 0) return;
    if (m.council?.status === 'running') return;
    setCouncil(msgId, { status: 'running', result: undefined, error: undefined, showReviewers: false });
    try {
      const res = await fetch('/api/ops-chat/council', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: m.question, answer: m.content }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Council is unavailable right now.');
      }
      const result = (await res.json()) as CouncilResult;
      setCouncil(msgId, { status: 'done', result });
    } catch (e) {
      setCouncil(msgId, { status: 'error', error: e instanceof Error ? e.message : 'Council is unavailable right now.' });
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
    setMessages((prev) => [...prev, ownerMsg, { id: replyId, role: 'assistant', content: '', question: trimmed }]);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    // Browser watchdog: no Send may leave the UI stuck on "Thinking…". At the
    // deadline we abort the fetch; the server enforces its own (slightly shorter)
    // deadline, so normally a clean timeout error arrives first and this is the
    // backstop. A timed-out request wrote nothing — the only write path is an
    // explicit Confirm through /api/ops-chat/confirm.
    let timedOut = false;
    const watchdog = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, OPS_CHAT_CLIENT_TIMEOUT_MS);

    const append = (delta: string) =>
      setMessages((prev) => prev.map((m) => (m.id === replyId ? { ...m, content: m.content + delta } : m)));
    const dropEmptyReply = () =>
      setMessages((prev) => prev.filter((m) => !(m.id === replyId && m.content.trim().length === 0 && !m.proposals)));

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

      // Resolves the instant the server sends `done` (or `error`) — never waits
      // for the connection to close.
      const result = await consumeOpsChatStream(res.body, {
        onDelta: (text) => {
          append(text);
          setToolActivity(null);
        },
        onToolStart: (name) => setToolActivity(TOOL_LABEL[name] ?? 'looking that up'),
        onToolEnd: () => setToolActivity(null),
        onProposal: (payload) => {
          const proposal = payload as unknown as Proposal;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === replyId
                ? { ...m, proposals: [...(m.proposals ?? []), { proposal, state: 'pending' as const }] }
                : m,
            ),
          );
        },
      });

      if (result.status === 'error') {
        setError(result.message);
        dropEmptyReply();
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        // Watchdog fired → bounded timeout with a clear, retryable message.
        // Any other abort (component unmount / navigation) stays silent.
        if (timedOut) {
          setError(OPS_CHAT_TIMEOUT_MESSAGE);
          dropEmptyReply();
        }
        return;
      }
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      dropEmptyReply();
    } finally {
      // Always clear the pending state and the watchdog, on every exit path.
      clearTimeout(watchdog);
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
                      <div className="flex flex-col gap-1">
                        <p className="text-sm text-[var(--success,#6bbf73)]">{doneLabel(p)}</p>
                        {p.kind === 'github_pr' && item.result?.prUrl ? (
                          <a
                            href={item.result.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-[var(--accent)] underline underline-offset-2 break-all"
                          >
                            {item.result.prUrl}
                          </a>
                        ) : p.kind === 'github_merge' ? (
                          <div className="flex flex-col gap-0.5 text-xs text-[var(--muted)]">
                            {item.result?.prUrl ? (
                              <a href={item.result.prUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline underline-offset-2 break-all">
                                {item.result.prUrl}
                              </a>
                            ) : null}
                            {item.result?.mergeCommitSha ? (
                              <span>Merge commit: <span className="font-mono">{item.result.mergeCommitSha.slice(0, 10)}</span></span>
                            ) : null}
                          </div>
                        ) : p.kind === 'github_rerun' ? (
                          <div className="flex flex-col gap-0.5 text-xs text-[var(--muted)]">
                            {item.result?.runUrl ? (
                              <a href={item.result.runUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline underline-offset-2 break-all">
                                {item.result.runUrl}
                              </a>
                            ) : null}
                            <span>
                              Run {item.result?.runId ?? p.runId}
                              {item.result?.attempt ? ` · attempt ${item.result.attempt}` : ''}
                              {item.result?.runState ? ` · ${item.result.runState}` : ''}
                            </span>
                          </div>
                        ) : p.kind === 'supabase_deploy' ? (
                          <div className="flex flex-col gap-0.5 text-xs text-[var(--muted)]">
                            <span>
                              {p.functionSlug} → project {p.projectRef}
                              {item.result?.version != null ? ` · version ${item.result.version}` : ''}
                            </span>
                            <span>
                              from <span className="font-mono">{p.sourceRepo}@{p.sourceSha.slice(0, 7)}</span>
                            </span>
                            {item.result?.contentDigest ? (
                              <span>Source digest: <span className="font-mono">{item.result.contentDigest.slice(0, 12)}</span></span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
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
                        ) : p.kind === 'rerun_task' ? (
                          <p className="mt-1 text-sm">
                            Re-run <span className="font-semibold">{p.taskTitle}</span>. Starts an AI run and uses tokens.
                          </p>
                        ) : p.kind === 'github_pr' ? (
                          <div className="mt-1 flex flex-col gap-0.5 text-sm">
                            <p className="font-semibold">{p.title}</p>
                            <p className="text-xs text-[var(--muted)]">
                              {p.repo} · <span className="font-mono">{p.branch}</span> → <span className="font-mono">{p.baseBranch}</span>
                            </p>
                            <p className="text-xs text-[var(--muted)]">
                              {p.files.length} file{p.files.length === 1 ? '' : 's'}: <span className="font-mono">{p.files.map((f) => f.path).join(', ')}</span>
                            </p>
                            <p className="mt-1 text-xs text-[var(--muted)]">
                              Risk: {p.riskClass.replace(/_/g, ' ')} · Side effect: opens a pull request (no merge). Rollback: close the PR / delete the branch — the default branch is never written.
                            </p>
                          </div>
                        ) : p.kind === 'github_merge' ? (
                          <div className="mt-1 flex flex-col gap-0.5 text-sm">
                            <p className="font-semibold">Merge pull request #{p.prNumber}</p>
                            <p className="text-xs text-[var(--muted)]">
                              {p.repo} · PR #{p.prNumber} @ <span className="font-mono">{p.expectedHeadSha.slice(0, 7)}</span> → <span className="font-mono">{p.expectedBaseBranch}</span> · {p.mergeMethod}
                            </p>
                            <p className="mt-1 text-xs text-[var(--muted)]">
                              Risk: {p.riskClass.replace(/_/g, ' ')} · Side effect: lands PR #{p.prNumber} into {p.expectedBaseBranch} (refused unless open, non-draft, exact head, green CI). Rollback: revert the merge commit. Recovery: a server error mid-merge is marked ambiguous for reconciliation — never auto-retried.
                            </p>
                          </div>
                        ) : p.kind === 'github_rerun' ? (
                          <div className="mt-1 flex flex-col gap-0.5 text-sm">
                            <p className="font-semibold">Re-run failed jobs — run {p.runId}</p>
                            <p className="text-xs text-[var(--muted)]">
                              {p.repo} · run {p.runId} · attempt {p.expectedRunAttempt} @ <span className="font-mono">{p.expectedHeadSha.slice(0, 7)}</span>
                            </p>
                            <p className="mt-1 text-xs text-[var(--muted)]">
                              Risk: {p.riskClass.replace(/_/g, ' ')} · Side effect: starts a fresh CI attempt of the run&apos;s failed jobs (no repo-content change; refused unless the run is completed + failed). Rollback: re-running is idempotent — nothing to undo. Recovery: a server error mid-request is marked ambiguous for reconciliation, never auto-retried.
                            </p>
                          </div>
                        ) : (
                          <div className="mt-1 flex flex-col gap-0.5 text-sm">
                            <p className="font-semibold">Deploy edge function “{p.functionSlug}”</p>
                            <p className="text-xs text-[var(--muted)]">
                              project {p.projectRef} · from <span className="font-mono">{p.sourceRepo}@{p.sourceSha.slice(0, 7)}</span> · <span className="font-mono">{p.sourcePath}</span>
                            </p>
                            <p className="text-xs text-[var(--muted)]">
                              entrypoint <span className="font-mono">{p.entrypointPath}</span>
                              {p.importMapPath ? <> · import map <span className="font-mono">{p.importMapPath}</span></> : null} · verify_jwt {p.verifyJwt ? 'on' : 'off'}
                            </p>
                            <p className="mt-1 text-xs text-[var(--muted)]">
                              Risk: {p.riskClass.replace(/_/g, ' ')} · Side effect: deploys the function&apos;s exact bytes at that commit SHA to the live project (refused unless the project + repo are linked, the source path has files, and the entrypoint is present). Rollback: redeploy the prior source SHA. Recovery: a server error mid-deploy is marked ambiguous for reconciliation, never auto-retried.
                            </p>
                          </div>
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

              {m.role === 'assistant' && m.id !== 'opening' && m.question && m.content.trim().length > 0 ? (
                <CouncilBlock
                  state={m.council}
                  disabled={streaming}
                  onAsk={() => void askCouncil(m.id)}
                  onToggleReviewers={() => toggleReviewers(m.id)}
                />
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
