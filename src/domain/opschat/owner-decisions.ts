import { and, desc, eq, inArray, isNotNull } from 'drizzle-orm';
import { type DbTx } from '@/db/client';
import { decisions, tasks } from '@/db/schema';
import { AppError } from '@/lib/errors';
import { type TenantContext } from '@/types/domain';
import { acceptDecision, createDecision } from '@/domain/decisions/decisions';

/**
 * Ops Chat — owner decisions that runs actually USE.
 *
 * Evidence (Hub prod, server-cooling, read-only 2026-10-22):
 *   - the owner said the cabinet load is 20 kW twice in chat (msgs 451fed25, 3fab4915) and chose the shared duct, yet
 *     the update run's brief carried neither — chat text is not stored anywhere a run reads;
 *   - the Empera Air Conditioning and Heating workspace held 72 run-extracted decisions, ALL still `proposed` (0
 *     accepted). Runs inject only ACCEPTED guidance, so none of them ever reached a run, and Ops Chat had no way to
 *     accept them.
 *
 * Both paths below are owner-confirmed cards (the confirm route calls these); a tool only proposes. A decision is
 * recorded as ACCEPTED, TASK-SCOPED GUIDANCE on the job's task: decision memory injects it into every later run of
 * that task, and the job's update card carries it into the update task (recordedJobDecisions / loadUpdateBasis).
 */

/** At most this many candidates on one accept card. */
export const MAX_ACCEPT_PER_CARD = 10;
const MAX_LIST = 25;

/** The label recorded as the decision's author (the owner confirmed it in Ops Chat). */
export const OWNER_DECISION_AUTHOR = 'Owner (Ops Chat)';

export interface DecisionCandidate {
  decisionId: string;
  title: string;
  summary: string;
  taskId: string;
  taskTitle: string;
  createdAt: Date;
}

/**
 * Proposed decisions extracted from runs, newest first — optionally only those from these tasks. A candidate without
 * an originating task cannot be scoped to a job, so it is not offered here. Tenant tx (RLS: own workspace only).
 */
export async function listDecisionCandidates(tx: DbTx, ctx: TenantContext, taskIds: readonly string[] | null): Promise<DecisionCandidate[]> {
  if (taskIds && taskIds.length === 0) return [];
  const rows = await tx
    .select({
      decisionId: decisions.id,
      title: decisions.title,
      summary: decisions.summary,
      taskId: decisions.originatingTaskId,
      taskTitle: tasks.title,
      createdAt: decisions.createdAt,
    })
    .from(decisions)
    .innerJoin(tasks, eq(tasks.id, decisions.originatingTaskId))
    .where(
      and(
        eq(decisions.projectId, ctx.projectId),
        eq(decisions.status, 'proposed'),
        isNotNull(decisions.originatingTaskId),
        ...(taskIds ? [inArray(decisions.originatingTaskId, [...taskIds])] : []),
      ),
    )
    .orderBy(desc(decisions.createdAt), desc(decisions.id))
    .limit(MAX_LIST);
  return rows.map((r) => ({ ...r, taskId: r.taskId! }));
}

/** The candidates with these ids that are still proposed and job-scopable (others are simply absent). */
export async function loadDecisionCandidates(tx: DbTx, ctx: TenantContext, ids: readonly string[]): Promise<DecisionCandidate[]> {
  if (ids.length === 0) return [];
  const rows = await tx
    .select({
      decisionId: decisions.id,
      title: decisions.title,
      summary: decisions.summary,
      taskId: decisions.originatingTaskId,
      taskTitle: tasks.title,
      createdAt: decisions.createdAt,
    })
    .from(decisions)
    .innerJoin(tasks, eq(tasks.id, decisions.originatingTaskId))
    .where(and(eq(decisions.projectId, ctx.projectId), eq(decisions.status, 'proposed'), inArray(decisions.id, [...ids])));
  return rows.map((r) => ({ ...r, taskId: r.taskId! }));
}

const taskGuidance = (taskId: string) => ({ applicability: 'guidance' as const, scope: 'task' as const, scopeTaskId: taskId, scopeObjectiveId: null, effectiveUntil: null });

/** Confirm path: record the owner's decision on the task as accepted, task-scoped guidance. Admin only (acceptDecision). */
export async function recordOwnerDecision(
  tx: DbTx,
  ctx: TenantContext,
  input: { taskId: string; title: string; statement: string },
): Promise<{ decisionId: string }> {
  const decisionId = await createDecision(tx, ctx, OWNER_DECISION_AUTHOR, {
    title: input.title,
    summary: input.statement,
    rationale: 'Stated by the owner in Ops Chat and confirmed on a card.',
    ...taskGuidance(input.taskId),
    originatingTaskId: input.taskId,
  });
  await acceptDecision(tx, ctx, decisionId, taskGuidance(input.taskId));
  return { decisionId };
}

/**
 * Confirm path: accept each candidate as guidance for the task it came from. The card froze (decisionId, taskId);
 * a candidate that is no longer proposed, or no longer from that task, fails the whole card (nothing is accepted).
 */
export async function acceptOwnerCandidates(
  tx: DbTx,
  ctx: TenantContext,
  items: readonly { decisionId: string; taskId: string }[],
): Promise<{ decisionIds: string[] }> {
  const now = await loadDecisionCandidates(tx, ctx, items.map((i) => i.decisionId));
  const byId = new Map(now.map((c) => [c.decisionId, c]));
  for (const i of items) {
    const c = byId.get(i.decisionId);
    if (!c || c.taskId !== i.taskId) {
      throw new AppError('conflict', 'A decision on this card is no longer waiting for the owner (it was accepted, rejected or changed). Ask Ops Chat for a fresh card. Nothing was recorded.');
    }
  }
  for (const i of items) await acceptDecision(tx, ctx, i.decisionId, taskGuidance(i.taskId));
  return { decisionIds: items.map((i) => i.decisionId) };
}
