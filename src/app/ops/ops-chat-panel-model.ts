import { cardLabelOf } from '@/domain/opschat/card-state';
import { type LinkedRunState } from '@/domain/opschat/linked-run-view';
import { type TranscriptCard } from './ops-chat-transcript';

/**
 * Ops Chat right panel, "This conversation" (owner request 2026-10-25). Derived ONLY from the cards already in the
 * transcript — whose linked-run views the client keeps live by polling — so the panel updates as jobs move, with no
 * extra reads. Pure; no IO.
 */

/** Kinds that start a Hub task/run. */
const JOB_KINDS = new Set(['dispatch_task', 'rerun_task']);
/** Kinds whose confirmation records an owner decision. */
const DECISION_KINDS = new Set(['answer_question', 'record_decision', 'record_batch', 'decide_approval', 'accept_decisions']);

export interface PanelJob {
  key: string;
  label: string;
  state: LinkedRunState | 'starting';
  stateLabel: string;
  /** Task page, when the task and its workspace are known. */
  href: string | null;
  /** Deliverables the finished result does not mention (same check the chat uses). */
  notFound: string[];
}

export interface PanelItem {
  key: string;
  label: string;
  /** In-page anchor of the card (`#card-<proposalId>`), when it has one. */
  anchor: string | null;
}

export interface ConversationPanel {
  jobs: PanelJob[];
  /** Jobs whose answer is ready to read (reviewed or an unreviewed draft). */
  results: PanelJob[];
  needsYou: PanelItem[];
  decisions: PanelItem[];
}

export const STATE_LABEL: Record<PanelJob['state'], string> = {
  starting: 'Starting',
  queued: 'Queued',
  running: 'Working',
  ready: 'Done',
  draft: 'Unreviewed draft',
  needs_approval: 'Needs your approval',
  failed: 'Failed',
  no_run: 'Not started',
};

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function labelOf(card: TranscriptCard): string {
  const kind = str(card.proposal.kind) ?? 'action';
  return cardLabelOf(kind, card.proposal);
}

export function conversationPanel(messages: ReadonlyArray<{ id: string; cards?: readonly TranscriptCard[] }>): ConversationPanel {
  const jobs: PanelJob[] = [];
  const needsYou: PanelItem[] = [];
  const decisions: PanelItem[] = [];

  for (const m of messages) {
    (m.cards ?? []).forEach((card, i) => {
      const kind = str(card.proposal.kind) ?? '';
      const key = card.proposalId ?? `${m.id}:${i}`;
      const anchor = card.proposalId ? `#card-${card.proposalId}` : null;

      if (card.state === 'pending' && card.proposalId) needsYou.push({ key, label: labelOf(card), anchor });

      if (JOB_KINDS.has(kind) && (card.state === 'done' || card.linkedRun)) {
        const run = card.linkedRun;
        const state: PanelJob['state'] = run ? run.state : 'starting';
        const projectKey = str(card.proposal.projectKey);
        const executed = (card.executed ?? {}) as Record<string, unknown>;
        const taskId = run?.taskId ?? str(executed.taskId) ?? str(card.proposal.taskId);
        jobs.push({
          key,
          label: str(card.proposal.title) ?? str(card.proposal.taskTitle) ?? labelOf(card),
          state,
          stateLabel: STATE_LABEL[state],
          href: projectKey && taskId ? `/p/${encodeURIComponent(projectKey)}/tasks/${encodeURIComponent(taskId)}` : null,
          notFound: run?.notFound ?? [],
        });
        if (state === 'needs_approval') needsYou.push({ key: `${key}:approval`, label: `Approve: ${str(card.proposal.title) ?? labelOf(card)}`, anchor });
      }

      if (DECISION_KINDS.has(kind) && card.state === 'done') decisions.push({ key, label: labelOf(card), anchor });
    });
  }

  // Newest first: the panel answers "what is happening now".
  jobs.reverse();
  decisions.reverse();
  return { jobs, results: jobs.filter((j) => j.state === 'ready' || j.state === 'draft'), needsYou, decisions };
}
