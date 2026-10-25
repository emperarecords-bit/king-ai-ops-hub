import { eq } from 'drizzle-orm';
import { type DbTx } from '@/db/client';
import { log } from '@/lib/log';
import { opsChatProposals, projects, runs, tasks } from '@/db/schema';
import { describeLinkedRun } from '@/domain/opschat/linked-run-view';
import { deliverablesNotFound } from '@/domain/opschat/deliverables';
import { type OpsChatRunLink } from '@/domain/notifications/ops-chat-link';

/**
 * P5b-1 — the notification text for a run started from an Ops Chat card, built at finalize from the run's own P4
 * link (runs.ops_chat_proposal_id). Returns null for any run without a link (the caller keeps today's text and
 * routing). The sentence is the same one the card shows (P5a); NO result text ever goes into a notification.
 *
 * The card's conversation is read under the finalizing context's own RLS (ops_chat_* = the card owner); when it
 * is not readable, `conversationId` is null and the notification links to the task instead.
 */
export interface OpsChatRunNotice {
  title: string;
  body: string;
  opsChat: OpsChatRunLink;
}

export interface RunFinish {
  runId: string;
  taskId: string;
  outcome: 'completed' | 'failed';
  reviewOutcome: string | null;
  resultChars: number;
  errorMessage: string | null;
  finishedAt: Date;
}

const quoted = (s: string) => `"${s.replace(/\s+/g, ' ').trim().slice(0, 120)}"`;

export async function buildOpsChatRunNotice(tx: DbTx, f: RunFinish): Promise<OpsChatRunNotice | null> {
  const run = (
    await tx.select({ proposalId: runs.opsChatProposalId, startedAt: runs.startedAt, result: runs.consolidatedResult }).from(runs).where(eq(runs.id, f.runId)).limit(1)
  )[0];
  if (!run?.proposalId) return null;
  const task = (
    await tx
      .select({ title: tasks.title, input: tasks.input, projectKey: projects.key })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(eq(tasks.id, f.taskId))
      .limit(1)
  )[0];
  if (!task) return null;
  const card = (
    await tx
      .select({ conversationId: opsChatProposals.conversationId, userId: opsChatProposals.userId })
      .from(opsChatProposals)
      .where(eq(opsChatProposals.id, run.proposalId))
      .limit(1)
  )[0];

  const view = describeLinkedRun({
    proposalId: run.proposalId,
    taskId: f.taskId,
    job: null,
    run: {
      id: f.runId,
      status: f.outcome,
      reviewOutcome: f.reviewOutcome,
      startedAt: run.startedAt,
      finishedAt: f.finishedAt,
      resultChars: f.resultChars,
      errorMessage: f.errorMessage,
      // Brief headings only (never result text) — "finished" is not "complete".
      ...(f.outcome === 'completed' ? { notFound: deliverablesNotFound(task.input, run.result) } : {}),
    },
    pendingApprovals: 0, // a run that proposed approvals ends awaiting_approval and is announced by approval_pending
  });
  const flags = [view.notFound && view.notFound.length > 0 ? 'may be incomplete' : null, view.state === 'draft' ? 'unreviewed draft' : null].filter(Boolean);
  const title =
    f.outcome === 'failed'
      ? `Ops Chat request failed: ${quoted(task.title)}`
      : `Ops Chat request finished${flags.length ? ` (${flags.join(', ')})` : ''}: ${quoted(task.title)}`;
  return {
    title,
    body: `${quoted(task.title)} — ${view.text}`,
    opsChat: {
      proposalId: run.proposalId,
      conversationId: card?.conversationId ?? null,
      cardOwnerUserId: card?.userId ?? null,
      taskPath: `/p/${encodeURIComponent(task.projectKey)}/tasks/${encodeURIComponent(f.taskId)}`,
    },
  };
}

/**
 * Savepoint-wrapped: a lookup error can never abort the finalize transaction (Postgres aborts a transaction on any
 * statement error, so a plain try/catch would not be enough). On failure the caller keeps today's notification.
 */
export async function buildOpsChatRunNoticeSafe(tx: DbTx, f: RunFinish): Promise<OpsChatRunNotice | null> {
  try {
    return await tx.transaction((sp) => buildOpsChatRunNotice(sp, f));
  } catch (err) {
    log.warn('ops-chat run notice lookup failed (default notification kept)', { runId: f.runId, errorClass: err instanceof Error ? err.name : 'unknown' });
    return null;
  }
}
