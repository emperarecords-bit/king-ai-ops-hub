'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { consumeOpsChatStream } from './ops-chat-stream';
import {
  OPS_CHAT_CLIENT_TIMEOUT_MS,
  OPS_CHAT_EARLIER_TURN_PENDING_MESSAGE,
  OPS_CHAT_TIMEOUT_MESSAGE,
} from '@/domain/opschat/limits';
import type { ApprovalContentView } from '@/domain/opschat/approval-content';
import { createDeadlineWatchdog } from './ops-chat-watchdog';
import { ATTACHMENT_ACCEPT, ATTACHMENT_LIMITS } from '@/domain/opschat/attachment-limits';
import {
  ComposerAttachmentChips,
  precheckFile,
  SentAttachmentChips,
  uploadAttachment,
  type ComposerFile,
} from './ops-chat-attachments';
import {
  applySavedMapping,
  attachmentOnlyContent,
  buildTranscript,
  confirmOutcome,
  isActionable,
  pendingOutsideWindow,
  pendingTurnOf,
  RELOAD_TO_SEE_STATE,
  type PendingTurn,
  type PersistedMessage,
  type TranscriptCard,
  type TranscriptMsg,
} from './ops-chat-transcript';

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
      /** Server-rendered from the stored approval payload; absent on cards saved before it existed. */
      content?: ApprovalContentView;
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
      kind: 'github_revert';
      projectKey: string;
      workspaceName: string;
      repo: string;
      targetSha: string;
      expectedBaseBranch: string;
      expectedBaseHeadSha: string;
      revertBranch: string;
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
    }
  | {
      kind: 'vercel_mutation';
      projectKey: string;
      workspaceName: string;
      vercelProjectId: string;
      operation: 'redeploy' | 'promote' | 'rollback';
      sourceDeploymentId?: string;
      expectedSourceSha?: string;
      targetDeploymentId?: string;
      expectedTargetSha?: string;
      expectedCurrentProductionDeploymentId?: string;
      riskClass: string;
    };

/** The executed result of a confirmed card, as displayed (from the confirm response or the stored row). */
interface CardResult {
  outcome?: string | null;
  message?: string | null;
  prUrl?: string | null;
  mergeCommitSha?: string | null;
  revertCommitSha?: string | null;
  runId?: number | null;
  attempt?: number | null;
  runState?: string | null;
  runUrl?: string | null;
  version?: number | null;
  contentDigest?: string | null;
  newDeploymentId?: string | null;
  productionDeploymentId?: string | null;
  productionChanged?: boolean | null;
}

function resultOf(executed: Record<string, unknown> | null | undefined): CardResult | undefined {
  if (!executed) return undefined;
  const str = (k: string): string | null => (typeof executed[k] === 'string' ? (executed[k] as string) : null);
  const num = (k: string): number | null => (typeof executed[k] === 'number' ? (executed[k] as number) : null);
  return {
    outcome: str('outcome'),
    message: str('message'),
    prUrl: str('prUrl'),
    mergeCommitSha: str('mergeCommitSha'),
    revertCommitSha: str('revertCommitSha'),
    runId: num('runId'),
    attempt: num('attempt'),
    runState: str('state'),
    runUrl: str('runUrl'),
    version: num('version'),
    contentDigest: str('contentDigest'),
    newDeploymentId: str('newDeploymentId'),
    productionDeploymentId: str('productionDeploymentId'),
    productionChanged: typeof executed.productionChanged === 'boolean' ? executed.productionChanged : null,
  };
}

const GOVERNED_MUTATION_KINDS: ReadonlySet<string> = new Set([
  'github_pr',
  'github_merge',
  'github_rerun',
  'github_revert',
  'supabase_deploy',
  'vercel_mutation',
]);

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

/** A transcript row (see ops-chat-transcript.ts) plus client-only Council state. Owner rows use the
 *  owner message id — which IS the client-minted turnId — as their id. */
interface Msg extends TranscriptMsg {
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
  read_attachment: 'reading your attachment',
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
  get_commit: 'reading the commit',
  propose_github_pr: 'preparing the pull request',
  propose_github_merge: 'preparing the merge',
  propose_github_rerun: 'preparing the re-run',
  propose_github_revert: 'preparing the revert',
  supabase_capabilities: 'checking Supabase capabilities',
  list_supabase_projects: 'listing linked Supabase projects',
  inspect_supabase_project: 'reading the Supabase project',
  inspect_edge_functions: 'reading edge functions',
  inspect_migrations: 'reading Supabase migrations',
  propose_supabase_deploy: 'preparing the deploy',
  validate_supabase_sql: 'validating the SQL',
  vercel_capabilities: 'checking Vercel capabilities',
  list_vercel_projects: 'listing linked Vercel projects',
  inspect_vercel_project: 'reading the Vercel project',
  inspect_vercel_deployments: 'reading Vercel deployments',
  propose_vercel_redeploy: 'preparing the redeploy',
  propose_vercel_promote: 'preparing the promote',
  propose_vercel_rollback: 'preparing the rollback',
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

/** The proposed content of an approval (rendered + redacted server-side) — what the owner is deciding. */
function ApprovalContentBlock({ content }: { content: ApprovalContentView }) {
  return (
    <div className="mt-2 rounded-md border border-[var(--border)] p-2">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted)]">{content.title}</p>
      {content.fields.length ? (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
          {content.fields.map((f, i) => (
            <div key={i} className="contents">
              <dt className="text-[var(--muted)]">{f.label}</dt>
              <dd className="break-all">{f.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {content.body ? (
        <pre
          className={`mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm ${content.format === 'json' || content.format === 'http' ? 'font-mono text-xs' : 'font-sans'}`}
        >
          {content.body}
        </pre>
      ) : null}
      {content.truncated || content.redacted ? (
        <p className="mt-1 text-[11px] text-[var(--muted)]">
          {[content.truncated ? 'Long content was shortened.' : null, content.redacted ? 'Credentials were hidden.' : null]
            .filter(Boolean)
            .join(' ')}
        </p>
      ) : null}
    </div>
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
    case 'github_revert':
      return `✓ Revert pull request requested for ${p.targetSha.slice(0, 7)} in ${p.repo}.`;
    case 'supabase_deploy':
      return `✓ Deploy requested for "${p.functionSlug}" in project ${p.projectRef}.`;
    case 'vercel_mutation':
      return `✓ ${p.operation} requested for ${p.vercelProjectId}.`;
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
    case 'github_revert':
      return `Confirm — revert merged change ${p.targetSha.slice(0, 7)} in ${p.repo}`;
    case 'supabase_deploy':
      return `Confirm — deploy "${p.functionSlug}" to project ${p.projectRef}`;
    case 'vercel_mutation':
      return p.operation === 'redeploy'
        ? `Confirm — redeploy in ${p.vercelProjectId} (no traffic change)`
        : `Confirm — ${p.operation} PRODUCTION in ${p.vercelProjectId}`;
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
    case 'github_revert':
      return 'Confirm & open revert PR';
    case 'supabase_deploy':
      return 'Confirm & deploy';
    case 'vercel_mutation':
      return p.operation === 'redeploy' ? 'Confirm & redeploy' : p.operation === 'promote' ? 'Confirm & promote' : 'Confirm & roll back';
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

/** Display state for a card: a governed action can be RECORDED `done` while its executor reported a
 *  non-success outcome (blocked / precondition failed) — show that honestly, never as a false "done". */
function effectiveCard(card: TranscriptCard): TranscriptCard {
  const ex = card.executed;
  if (card.state === 'done' && ex && GOVERNED_MUTATION_KINDS.has(String(card.proposal.kind)) && ex.outcome !== 'succeeded') {
    const outcome = typeof ex.outcome === 'string' ? ex.outcome : 'did not run';
    return { ...card, state: 'error', error: typeof ex.message === 'string' && ex.message ? ex.message : `The action ${outcome}.` };
  }
  return card;
}

/**
 * Ops Chat surface (v2.2 + Council + persistence). Streams replies over SSE, shows what it's
 * looking up, and renders a confirm card per proposed action — answering a question,
 * approving/rejecting, or dispatching/re-running work. The write (or run) happens only on Confirm.
 * Each completed answer also offers an optional, owner-triggered Council review.
 *
 * PERSISTENCE: the transcript comes from the server store (see page.tsx), so it survives refresh and
 * resumes on any device. Every send carries a client-minted `conversationId` (minted once, on the
 * first send of a new conversation) and a fresh `turnId`; a card becomes actionable only when the
 * `saved` event supplies its persisted proposalId, and Confirm/Cancel send ONLY that id — the server
 * reloads the immutable stored proposal.
 *
 * RECOVERY: an owner turn with no saved reply (whatever the cause) is the conversation's pending turn.
 * It pauses new sends (the server runs turns in order) and is offered as an explicit "Resume message"
 * that re-sends the exact (conversationId, turnId, content) — never a new turnId, and never automatic,
 * because a resume can spend a model call.
 */
export function OpsChatClient({
  opening,
  conversationId: initialConversationId,
  persisted,
  pendingTurn: serverPending,
  conversations,
}: {
  opening: string;
  conversationId: string | null;
  persisted: PersistedMessage[];
  pendingTurn: PendingTurn | null;
  conversations: Array<{ id: string; title: string | null }>;
}) {
  const [initialTranscript] = useState(() => buildTranscript(persisted));
  const [messages, setMessages] = useState<Msg[]>(() => [
    { id: 'opening', role: 'assistant', content: opening },
    ...initialTranscript,
  ]);
  // The server's earliest unanswered turn when it is NOT in the loaded window (a very long thread):
  // the page-supplied copy is then the only handle on it. Cleared once it gets a saved reply.
  const [outsidePending, setOutsidePending] = useState<PendingTurn | null>(() =>
    pendingOutsideWindow(initialTranscript, serverPending),
  );
  // Minted on the first send of a NEW conversation and then stable, so a first-turn retry can never
  // fork a second conversation.
  const [currentId, setCurrentId] = useState<string | null>(initialConversationId);
  const [input, setInput] = useState('');
  // Files uploaded into this conversation for the NEXT send (uploaded immediately, sent with the message).
  const [composerFiles, setComposerFiles] = useState<ComposerFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [streaming, setStreaming] = useState(false);
  const [toolActivity, setToolActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  const pending = useMemo(() => pendingTurnOf(messages, outsidePending), [messages, outsidePending]);

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

  function setCard(msgId: string, index: number, fields: Partial<TranscriptCard>) {
    setMessages((prev) =>
      prev.map((m) =>
        m.id === msgId && m.cards ? { ...m, cards: m.cards.map((c, i) => (i === index ? { ...c, ...fields } : c)) } : m,
      ),
    );
  }

  /** Confirm or cancel a persisted proposal by id. The server reloads the immutable stored payload. */
  async function act(msgId: string, index: number, intent: 'confirm' | 'cancel') {
    const card = messages.find((x) => x.id === msgId)?.cards?.[index];
    if (!card || !isActionable(card)) return;
    setCard(msgId, index, { state: 'confirming', error: undefined });
    let status: number;
    let json: unknown;
    try {
      const res = await fetch('/api/ops-chat/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ proposalId: card.proposalId, intent }),
      });
      status = res.status;
      json = await res.json().catch(() => null);
    } catch {
      // The request may or may not have reached the server — never confirm again blind.
      setCard(msgId, index, { state: 'unrecorded', error: RELOAD_TO_SEE_STATE });
      return;
    }
    setCard(msgId, index, confirmOutcome(status, json));
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

  function openConversation(id: string | null) {
    if (streaming) return;
    window.location.assign(id ? `/ops?c=${encodeURIComponent(id)}` : '/ops?new=1');
  }

  /** The conversation id, minted once (on the first send OR the first upload) and then stable. */
  function ensureConversationId(): string {
    const conversationId = currentId ?? crypto.randomUUID();
    if (!currentId) setCurrentId(conversationId);
    // Keep the URL on this conversation so a refresh (or the same link on another device) resumes it.
    window.history.replaceState(null, '', `/ops?c=${conversationId}`);
    return conversationId;
  }

  const uploading = composerFiles.some((f) => f.state === 'uploading');
  const readyFiles = composerFiles.filter((f) => f.state === 'ready' && f.chip);

  /** Upload picked files into this conversation, one at a time. Nothing is sent until the owner sends. */
  async function addFiles(list: FileList | null) {
    if (!list || list.length === 0 || streaming || pending) return;
    setError(null);
    const room = ATTACHMENT_LIMITS.maxPerMessage - composerFiles.filter((f) => f.state !== 'error').length;
    const picked = Array.from(list).slice(0, Math.max(0, room));
    if (list.length > picked.length) setError(`A message can carry at most ${ATTACHMENT_LIMITS.maxPerMessage} attachments.`);
    if (picked.length === 0) return;
    const conversationId = ensureConversationId();
    for (const file of picked) {
      const localId = nextId();
      const refusal = precheckFile(file);
      if (refusal) {
        setComposerFiles((prev) => [...prev, { localId, filename: file.name, sizeBytes: file.size, state: 'error', error: refusal }]);
        continue;
      }
      setComposerFiles((prev) => [...prev, { localId, filename: file.name, sizeBytes: file.size, state: 'uploading' }]);
      const r = await uploadAttachment(file, conversationId);
      setComposerFiles((prev) =>
        prev.map((f) => (f.localId !== localId ? f : r.ok ? { ...f, state: 'ready', chip: r.chip } : { ...f, state: 'error', error: r.error })),
      );
    }
  }

  async function send(text: string) {
    const trimmed = text.trim();
    const files = readyFiles.map((f) => f.chip!);
    // A pending turn pauses new sends: the server answers owner turns strictly in order.
    if ((!trimmed && files.length === 0) || streaming || pending || uploading) return;
    setError(null);
    setInput('');
    setComposerFiles([]);
    const conversationId = ensureConversationId();
    const turnId = crypto.randomUUID();
    // Attachment-only: the same deterministic text the server derives (so a resume re-sends it exactly).
    const content = trimmed || attachmentOnlyContent(files.map((f) => f.filename));
    setMessages((prev) => [
      ...prev,
      { id: turnId, role: 'owner', content, awaitingReply: true, ...(files.length > 0 ? { attachments: files } : {}) },
    ]);
    await runTurn({ conversationId, turnId, content, fresh: true, attachmentIds: files.map((f) => f.id) });
  }

  /** Explicit, owner-clicked recovery: re-send the EXACT pending turn (same ids, same content). The
   *  idempotent route replays a reply that was saved meanwhile, or runs the turn now. */
  async function resume() {
    const turn = pending;
    const conversationId = currentId;
    if (!turn || !conversationId || streaming) return;
    setError(null);
    await runTurn({ conversationId, turnId: turn.turnId, content: turn.content, fresh: false });
  }

  async function runTurn(t: { conversationId: string; turnId: string; content: string; fresh: boolean; attachmentIds?: string[] }) {
    setToolActivity(null);
    const replyId = nextId();
    // The reply sits directly after its own owner turn (turn-aware), or at the end when that turn is
    // outside the loaded window.
    setMessages((prev) => {
      const reply: Msg = { id: replyId, role: 'assistant', content: '', question: t.content, replyTo: t.turnId };
      const at = prev.findIndex((m) => m.role === 'owner' && m.id === t.turnId);
      return at < 0 ? [...prev, reply] : [...prev.slice(0, at + 1), reply, ...prev.slice(at + 1)];
    });
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;
    // Browser watchdog: no Send may leave the UI stuck on "Thinking…". At the deadline we abort the fetch; the
    // server enforces its own (slightly shorter) deadline, so normally a clean timeout error arrives first and
    // this is the backstop. A timed-out request wrote nothing — the only write path is an explicit Confirm.
    // A hidden tab THROTTLES the timer, so we also re-check the wall-clock deadline on `visibilitychange`: the
    // instant the tab is foregrounded again, an overrun fires immediately rather than hanging on "Thinking…".
    let timedOut = false;
    const watchdog = createDeadlineWatchdog(OPS_CHAT_CLIENT_TIMEOUT_MS, () => {
      timedOut = true;
      controller.abort();
    });
    watchdog.start();
    const onVisible = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') watchdog.checkNow();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);

    const patchReply = (fn: (m: Msg) => Msg) => setMessages((prev) => prev.map((m) => (m.id === replyId ? fn(m) : m)));
    const append = (delta: string) => patchReply((m) => ({ ...m, content: m.content + delta }));
    // No `saved` ⇒ no terminal reply was recorded. Drop the local bubble so the transcript matches the
    // store; the owner turn stays awaiting and becomes the recovery state (Resume message).
    let saved = false;
    const dropUnsavedReply = () => {
      if (!saved) setMessages((prev) => prev.filter((m) => m.id !== replyId));
    };
    const showError = (message: string) =>
      setError(message === OPS_CHAT_EARLIER_TURN_PENDING_MESSAGE ? `${message} Reload to see it.` : message);

    try {
      const res = await fetch('/api/ops-chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // A resume re-sends no attachment ids: the files were linked when the turn was first persisted.
        body: JSON.stringify({ message: t.content, conversationId: t.conversationId, turnId: t.turnId, attachmentIds: t.attachmentIds ?? [] }),
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
        // A 4xx is rejected BEFORE the owner turn is persisted (invalid / not found / id conflict), so a
        // fresh send leaves nothing to resume — remove it. A 5xx may or may not have persisted it: keep
        // it as pending; Resume is idempotent either way.
        if (t.fresh && res.status >= 400 && res.status < 500) {
          setMessages((prev) => prev.filter((m) => !(m.role === 'owner' && m.id === t.turnId)));
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
          // Shown as proposed, but NOT actionable until `saved` supplies its persisted proposalId.
          const proposal: Record<string, unknown> = { ...payload };
          const correlationKey = typeof proposal.correlationKey === 'string' ? proposal.correlationKey : undefined;
          delete proposal.correlationKey;
          patchReply((m) => ({ ...m, cards: [...(m.cards ?? []), { proposal, correlationKey, state: 'pending' as const }] }));
        },
        onSaved: (s) => {
          // The commit point that makes cards actionable — only accept it for THIS request's conversation.
          // (The server never emits another; if it did, ignore it: the turn stays pending, cards stay inert.)
          if (s.conversationId !== t.conversationId) return;
          saved = true;
          patchReply((m) => ({ ...m, status: s.status, cards: applySavedMapping(m.cards, s.proposals) }));
          // The owner turn now has a terminal reply (complete OR interrupted) — it no longer blocks sending.
          setMessages((prev) => prev.map((m) => (m.role === 'owner' && m.id === t.turnId ? { ...m, awaitingReply: false } : m)));
          setOutsidePending((p) => (p?.turnId === t.turnId ? null : p));
        },
      });

      if (result.status === 'error') {
        showError(result.message);
        dropUnsavedReply();
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        // Watchdog fired → bounded timeout with a clear, retryable message.
        // Any other abort (component unmount / navigation) stays silent.
        if (timedOut) {
          setError(OPS_CHAT_TIMEOUT_MESSAGE);
          dropUnsavedReply();
        }
        return;
      }
      showError(err instanceof Error ? err.message : 'Something went wrong.');
      dropUnsavedReply();
    } finally {
      // Always clear the pending state and the watchdog, on every exit path.
      watchdog.clear();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
      setStreaming(false);
      setToolActivity(null);
      abortRef.current = null;
    }
  }

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="ops-chat-conversation">Conversation</label>
        <select
          id="ops-chat-conversation"
          value={currentId ?? ''}
          disabled={streaming}
          onChange={(e) => openConversation(e.target.value || null)}
          className="min-w-0 flex-1 rounded border border-[var(--border)] bg-transparent px-2 py-1.5 text-xs text-[var(--muted)]"
        >
          {currentId && !conversations.some((c) => c.id === currentId) ? <option value={currentId}>This conversation</option> : null}
          {!currentId ? <option value="">New conversation</option> : null}
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title ?? 'Untitled conversation'}
            </option>
          ))}
        </select>
        <button
          type="button"
          disabled={streaming}
          onClick={() => openConversation(null)}
          className="rounded border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-40"
        >
          New conversation
        </button>
      </div>

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
              ) : m.role === 'assistant' && !m.cards ? (
                <span className="opacity-60">{toolActivity ? `🔍 ${toolActivity}…` : 'Thinking…'}</span>
              ) : null}
              {m.role === 'owner' && m.attachments ? <SentAttachmentChips chips={m.attachments} /> : null}
              {m.role === 'assistant' && m.status === 'interrupted' ? (
                <p className="mt-1 text-[11px] text-[var(--muted)]">Interrupted — partial reply, kept for history only.</p>
              ) : null}

              {m.cards?.map((raw, i) => {
                const card = effectiveCard(raw);
                const actionable = isActionable(card) && !streaming;
                const p = card.proposal as unknown as Proposal;
                const result = resultOf(card.executed);
                return (
                  <div
                    key={i}
                    className="mt-3 rounded-md border border-[var(--accent)] bg-[var(--surface-raised,rgba(120,160,255,0.06))] p-3"
                  >
                    {card.state === 'done' ? (
                      <div className="flex flex-col gap-1">
                        <p className="text-sm text-[var(--success,#6bbf73)]">{doneLabel(p)}</p>
                        {p.kind === 'github_pr' && result?.prUrl ? (
                          <a
                            href={result.prUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-[var(--accent)] underline underline-offset-2 break-all"
                          >
                            {result.prUrl}
                          </a>
                        ) : p.kind === 'github_merge' ? (
                          <div className="flex flex-col gap-0.5 text-xs text-[var(--muted)]">
                            {result?.prUrl ? (
                              <a href={result.prUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline underline-offset-2 break-all">
                                {result.prUrl}
                              </a>
                            ) : null}
                            {result?.mergeCommitSha ? (
                              <span>Merge commit: <span className="font-mono">{result.mergeCommitSha.slice(0, 10)}</span></span>
                            ) : null}
                          </div>
                        ) : p.kind === 'github_rerun' ? (
                          <div className="flex flex-col gap-0.5 text-xs text-[var(--muted)]">
                            {result?.runUrl ? (
                              <a href={result.runUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline underline-offset-2 break-all">
                                {result.runUrl}
                              </a>
                            ) : null}
                            <span>
                              Run {result?.runId ?? p.runId}
                              {result?.attempt ? ` · attempt ${result.attempt}` : ''}
                              {result?.runState ? ` · ${result.runState}` : ''}
                            </span>
                          </div>
                        ) : p.kind === 'github_revert' ? (
                          <div className="flex flex-col gap-0.5 text-xs text-[var(--muted)]">
                            {result?.prUrl ? (
                              <a href={result.prUrl} target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline underline-offset-2 break-all">
                                {result.prUrl}
                              </a>
                            ) : null}
                            <span>Reverts <span className="font-mono">{p.targetSha.slice(0, 10)}</span> → <span className="font-mono">{p.expectedBaseBranch}</span></span>
                            {result?.revertCommitSha ? (
                              <span>Revert commit: <span className="font-mono">{result.revertCommitSha.slice(0, 10)}</span></span>
                            ) : null}
                          </div>
                        ) : p.kind === 'supabase_deploy' ? (
                          <div className="flex flex-col gap-0.5 text-xs text-[var(--muted)]">
                            <span>
                              {p.functionSlug} → project {p.projectRef}
                              {result?.version != null ? ` · version ${result.version}` : ''}
                            </span>
                            <span>
                              from <span className="font-mono">{p.sourceRepo}@{p.sourceSha.slice(0, 7)}</span>
                            </span>
                            {result?.contentDigest ? (
                              <span>Source digest: <span className="font-mono">{result.contentDigest.slice(0, 12)}</span></span>
                            ) : null}
                          </div>
                        ) : p.kind === 'vercel_mutation' ? (
                          <div className="flex flex-col gap-0.5 text-xs text-[var(--muted)]">
                            <span>{p.operation} · {p.vercelProjectId}</span>
                            {result?.newDeploymentId ? (
                              <span>New deployment: <span className="font-mono">{result.newDeploymentId}</span> (production unchanged)</span>
                            ) : null}
                            {result?.productionDeploymentId ? (
                              <span>Production now: <span className="font-mono">{result.productionDeploymentId}</span></span>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : card.state === 'cancelled' ? (
                      <p className="text-sm text-[var(--muted)]">Cancelled — nothing was changed.</p>
                    ) : card.state === 'stale' ? (
                      <p className="text-sm text-[var(--muted)]">
                        No longer valid — {card.error ?? 'things changed since this was proposed'}. Ask Ops Chat for a fresh proposal.
                      </p>
                    ) : card.state === 'unrecorded' || card.state === 'conflict' ? (
                      <div className="flex flex-col gap-1">
                        <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{headerLabel(p)}</p>
                        <p className="text-sm text-[var(--danger,#c37474)]">{card.error ?? RELOAD_TO_SEE_STATE}</p>
                        <button
                          type="button"
                          onClick={() => window.location.reload()}
                          className="self-start rounded-md border border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)] hover:text-[var(--foreground)]"
                        >
                          Reload
                        </button>
                      </div>
                    ) : (
                      <>
                        {card.fromHistory && card.state === 'pending' ? (
                          <p className="mb-1 text-[11px] font-semibold text-[var(--muted)]">Proposed earlier</p>
                        ) : null}
                        <p className="text-xs uppercase tracking-wide text-[var(--muted)]">{headerLabel(p)}</p>

                        {p.kind === 'answer_question' ? (
                          <>
                            <p className="mt-1 text-xs text-[var(--muted)]">Q: {p.question}</p>
                            <p className="mt-2 whitespace-pre-wrap text-sm">{p.answer}</p>
                          </>
                        ) : p.kind === 'decide_approval' ? (
                          <>
                            <p className="mt-1 whitespace-pre-wrap text-sm">{p.summary}</p>
                            {p.content ? <ApprovalContentBlock content={p.content} /> : null}
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
                        ) : p.kind === 'github_revert' ? (
                          <div className="mt-1 flex flex-col gap-0.5 text-sm">
                            <p className="font-semibold">Revert merged change {p.targetSha.slice(0, 7)}</p>
                            <p className="text-xs text-[var(--muted)]">
                              {p.repo} · reverts <span className="font-mono">{p.targetSha.slice(0, 7)}</span> · new branch <span className="font-mono">{p.revertBranch}</span> → <span className="font-mono">{p.expectedBaseBranch}</span> @ <span className="font-mono">{p.expectedBaseHeadSha.slice(0, 7)}</span>
                            </p>
                            <p className="mt-1 text-xs text-[var(--muted)]">
                              Risk: {p.riskClass.replace(/_/g, ' ')} · Side effect: opens a pull request that applies the exact inverse of {p.targetSha.slice(0, 7)} on a NEW branch — the default branch is never written (no merge). Refused if the base head moved, the target is unreachable, the change conflicts with later edits (no 3-way merge), it is already reverted, or it touches non-file entries. Rollback: close the PR / delete the branch. Recovery: a branch-created-but-PR-failed outcome is marked ambiguous for reconciliation, never auto-retried.
                            </p>
                          </div>
                        ) : p.kind === 'supabase_deploy' ? (
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
                        ) : (
                          <div className="mt-1 flex flex-col gap-0.5 text-sm">
                            <p className="font-semibold">
                              Vercel {p.operation} — {p.vercelProjectId}
                            </p>
                            {p.operation === 'redeploy' ? (
                              <p className="text-xs text-[var(--muted)]">
                                from deployment <span className="font-mono">{p.sourceDeploymentId}</span> @ <span className="font-mono">{(p.expectedSourceSha ?? '').slice(0, 7)}</span> · creates a NEW non-production deployment
                              </p>
                            ) : (
                              <p className="text-xs text-[var(--muted)]">
                                to deployment <span className="font-mono">{p.targetDeploymentId}</span> @ <span className="font-mono">{(p.expectedTargetSha ?? '').slice(0, 7)}</span> · replacing production <span className="font-mono">{p.expectedCurrentProductionDeploymentId}</span>
                              </p>
                            )}
                            <p className="mt-1 text-xs text-[var(--muted)]">
                              Risk: {p.riskClass.replace(/_/g, ' ')} · Side effect:{' '}
                              {p.operation === 'redeploy'
                                ? 'creates a new deployment from the exact source (refused unless the source is READY and the SHA matches); production traffic is NOT changed.'
                                : `moves PRODUCTION traffic to the exact target (refused unless it is READY, the SHA matches, and production has not moved since review). Rollback: ${p.operation === 'promote' ? 'promote/rollback the previous deployment back' : 'roll forward to the prior deployment'}.`}{' '}
                              Recovery: a server error mid-operation is marked ambiguous for reconciliation, never auto-retried.
                            </p>
                          </div>
                        )}

                        {card.error ? (
                          <p className="mt-2 text-xs text-[var(--danger,#c37474)]">{card.error}</p>
                        ) : null}
                        {card.state === 'pending' || card.state === 'confirming' ? (
                          <>
                            <div className="mt-3 flex items-center gap-2">
                              <button
                                type="button"
                                disabled={!actionable}
                                onClick={() => void act(m.id, i, 'confirm')}
                                className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
                              >
                                {card.state === 'confirming' ? 'Working…' : confirmLabel(p)}
                              </button>
                              <button
                                type="button"
                                disabled={!actionable}
                                onClick={() => void act(m.id, i, 'cancel')}
                                className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50"
                              >
                                Cancel
                              </button>
                            </div>
                            {card.state === 'pending' && !card.proposalId ? (
                              <p className="mt-1 text-[11px] text-[var(--muted)]">
                                {streaming ? 'Saving…' : 'This card was not saved and cannot be confirmed — ask again for a fresh one.'}
                              </p>
                            ) : null}
                          </>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              })}

              {m.role === 'assistant' && m.id !== 'opening' && m.status === 'complete' && m.question && m.content.trim().length > 0 ? (
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

      {pending ? (
        <div role="status" className="rounded-md border border-[var(--accent)] bg-[var(--surface-raised,rgba(120,160,255,0.06))] p-3">
          <p className="text-sm font-semibold">This conversation has an unfinished message.</p>
          <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-[var(--muted)]">“{pending.content}”</p>
          <p className="mt-1 text-xs text-[var(--muted)]">
            It never got a saved reply. Resume re-sends exactly this message — it shows the reply if one was saved
            meanwhile, otherwise it runs now (uses Anthropic). New messages are paused until it finishes.
          </p>
          <button
            type="button"
            disabled={streaming}
            onClick={() => void resume()}
            className="mt-2 rounded-md bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14] hover:bg-[var(--accent-strong)] disabled:opacity-50"
          >
            {streaming ? 'Resuming…' : 'Resume message'}
          </button>
        </div>
      ) : null}

      {messages.length <= 1 && !pending ? (
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
        <ComposerAttachmentChips
          files={composerFiles}
          disabled={streaming}
          onRemove={(localId) => setComposerFiles((prev) => prev.filter((f) => f.localId !== localId))}
        />
        <textarea
          ref={taRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={2}
          maxLength={4000}
          placeholder={pending ? 'Resume the unfinished message above to continue…' : 'Ask, answer, approve, or start work — all from here…'}
          className="max-h-80 min-h-[3.5rem] w-full resize-none overflow-y-auto rounded border border-[var(--border)] bg-transparent p-2.5 text-sm leading-relaxed"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ATTACHMENT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                void addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            <button
              type="button"
              aria-label="Attach files"
              title="Attach PDF, Word, Excel, CSV, text, Markdown, or an image"
              disabled={streaming || !!pending || uploading}
              onClick={() => fileInputRef.current?.click()}
              className="rounded border border-[var(--border)] px-2 py-1 text-sm hover:opacity-80 disabled:opacity-40"
            >
              📎
            </button>
            <span className="text-xs opacity-50">Enter to send · Shift+Enter for a new line</span>
          </div>
          <button
            type="submit"
            disabled={streaming || !!pending || uploading || (input.trim().length === 0 && readyFiles.length === 0)}
            className="rounded border border-[var(--border)] px-4 py-1.5 text-sm hover:opacity-80 disabled:opacity-40"
          >
            {streaming ? 'Answering…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
