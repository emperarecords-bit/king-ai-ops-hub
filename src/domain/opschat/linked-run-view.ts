/**
 * P5a — what happened to the work an Ops Chat card started, read from the P4 provenance links
 * (run_jobs / runs .ops_chat_proposal_id → ops_chat_proposals.id), never from chat text.
 *
 * Evidence (Hub prod 2026-10-19/20): the owner had to ask "where will i get answers" — a confirmed dispatch
 * or re-run card said only that it was confirmed, and the result of the run it started never came back to
 * the conversation. Migration 0087 links each attempt and result to the card that caused it; this module
 * turns those stored rows into one plain line per card.
 *
 * Pure (no DB, no React) so the exact wording is unit-tested and the browser can import the types.
 */

/** The stored facts for ONE card's linked attempt (its newest job and newest run). */
export interface LinkedRunFacts {
  proposalId: string;
  taskId: string;
  job: { status: string; createdAt: Date; updatedAt: Date } | null;
  run: {
    id: string;
    status: string;
    reviewOutcome: string | null;
    startedAt: Date | null;
    finishedAt: Date | null;
    resultChars: number;
    errorMessage: string | null;
  } | null;
  /** Approvals still pending that THIS run proposed. */
  pendingApprovals: number;
}

export type LinkedRunState = 'queued' | 'running' | 'ready' | 'draft' | 'needs_approval' | 'failed' | 'no_run';

/** Serializable (no Date) — what the page sends to the browser for one card. */
export interface LinkedRunView {
  taskId: string;
  runId: string | null;
  state: LinkedRunState;
  /** ISO time the run finished, when it has. */
  finishedAt: string | null;
  /** One sentence for the owner, built only from the stored facts. */
  text: string;
}

const t = (d: Date): string => `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const short = (id: string) => id.slice(0, 8);

export function describeLinkedRun(f: LinkedRunFacts): LinkedRunView {
  const base = { taskId: f.taskId, runId: f.run?.id ?? null, finishedAt: f.run?.finishedAt?.toISOString() ?? null };
  const run = f.run;
  if (run) {
    if (run.status === 'running') {
      return { ...base, state: 'running', text: `Running now${run.startedAt ? ` (started ${t(run.startedAt)})` : ''}.` };
    }
    if (run.status === 'failed') {
      const why = run.errorMessage ? `: ${run.errorMessage.replace(/\s+/g, ' ').slice(0, 160)}` : '';
      return { ...base, state: 'failed', text: `The run failed${run.finishedAt ? ` (${t(run.finishedAt)})` : ''}${why}. No result was produced.` };
    }
    if (run.status === 'completed') {
      const when = run.finishedAt ? ` ${t(run.finishedAt)}` : '';
      const result = run.resultChars > 0 ? 'its result is ready to read' : 'it recorded no result text';
      const draft = run.reviewOutcome === 'required_unmet';
      const approvals =
        f.pendingApprovals > 0
          ? ` It proposed ${f.pendingApprovals === 1 ? 'an approval' : `${f.pendingApprovals} approvals`} that ${f.pendingApprovals === 1 ? 'is' : 'are'} waiting on the owner.`
          : '';
      const draftNote = draft ? ' It is an UNREVIEWED DRAFT: review was required but did not happen, so it is not final.' : '';
      const state: LinkedRunState = f.pendingApprovals > 0 ? 'needs_approval' : draft ? 'draft' : 'ready';
      return { ...base, state, text: `Finished${when}; ${result}.${draftNote}${approvals}` };
    }
    return { ...base, state: 'no_run', text: `Its run is in an unrecognized state (${run.status}).` };
  }
  const job = f.job;
  if (job && (job.status === 'queued' || job.status === 'running')) {
    return { ...base, state: job.status === 'running' ? 'running' : 'queued', text: job.status === 'running' ? 'Picked up by a worker; the run is starting.' : `Queued since ${t(job.createdAt)}, not started yet.` };
  }
  if (job) {
    return { ...base, state: 'no_run', text: `Its job ended (${job.status}, ${t(job.updatedAt)}) without a run on record — nothing was produced.` };
  }
  return { ...base, state: 'no_run', text: 'No job or run is on record for this card.' };
}

/** The prompt-history suffix for a card with a linked attempt (card-state.ts appends it). */
export function linkedRunLine(v: LinkedRunView): string {
  return `linked ${v.runId ? `run ${short(v.runId)}` : 'job'} (task ${short(v.taskId)}): ${v.text}`;
}

export interface CompletedSinceItem {
  proposalId: string;
  kind: string;
  label: string;
  view: LinkedRunView;
}

/**
 * Runs that FINISHED (ready / draft / needs approval / failed) after the newest message in the conversation —
 * the work the owner has not been told about in this thread yet. Newest last. Derived on every load, so it is
 * never stale and needs no "delivered" bookkeeping: once the owner sends another message it moves out.
 */
export function completedSince(
  cards: ReadonlyArray<{ proposalId: string; kind: string; label: string; view: LinkedRunView | null | undefined }>,
  newestMessageAt: Date | null,
): CompletedSinceItem[] {
  const out: CompletedSinceItem[] = [];
  for (const c of cards) {
    const v = c.view;
    if (!v || !v.finishedAt) continue;
    if (v.state === 'queued' || v.state === 'running' || v.state === 'no_run') continue;
    if (newestMessageAt && Date.parse(v.finishedAt) <= newestMessageAt.getTime()) continue;
    out.push({ proposalId: c.proposalId, kind: c.kind, label: c.label, view: v });
  }
  return out.sort((a, b) => Date.parse(a.view.finishedAt!) - Date.parse(b.view.finishedAt!));
}
