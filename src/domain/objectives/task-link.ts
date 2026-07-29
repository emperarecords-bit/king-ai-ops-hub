import { and, eq } from 'drizzle-orm';
import { type ContextManifestEntry, type TenantContext } from '@/types/domain';
import { AppError, ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { objectives, runs, tasks } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * The canonical objective↔task relationship (HUB-003).
 *
 * There is exactly ONE association: the direct FK `tasks.objective_id`. Every surface — the task
 * header, the objective's contributing-work list, progress, the Work list, approvals, briefing —
 * reads this same column. Nothing derives a durable contribution from run context, decisions,
 * dependencies, or generated work; receiving an objective as run *context* must never silently
 * become a durable link.
 *
 * This module owns changing that relationship (so UI code never writes the FK directly) and a
 * read-only detector that reports records where sources disagree.
 */

// ---------------------------------------------------------------------------
// Relationship classification (req #2) — four mutually exclusive classes.
// ---------------------------------------------------------------------------
export type ObjectiveLinkClass =
  | 'directly_tied' // tasks.objective_id set → a live, in-workspace objective
  | 'context_only' // no FK, but a run received an objective as context (NOT a durable link)
  | 'none' // no FK and no objective context
  | 'tied_to_closed'; // FK set but the objective is cancelled/completed (a contradiction to surface)

interface TaskLinkState {
  status: string;
  objectiveId: string | null;
}

async function loadTaskLinkState(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
): Promise<TaskLinkState> {
  const rows = await tx
    .select({ status: tasks.status, objectiveId: tasks.objectiveId })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('Task');
  return row;
}

/** Resolve an objective scoped to this workspace; throws NotFound for cross-workspace/absent. */
async function resolveObjective(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string,
): Promise<{ id: string; title: string; status: string }> {
  const rows = await tx
    .select({ id: objectives.id, title: objectives.title, status: objectives.status })
    .from(objectives)
    .where(
      and(
        eq(objectives.id, objectiveId),
        eq(objectives.projectId, ctx.projectId),
        eq(objectives.orgId, ctx.orgId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('Objective');
  return row;
}

function requireAdmin(ctx: TenantContext): void {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only a project admin can change an objective relationship.');
  }
}

/** Moving or detaching COMPLETED work rewrites an attribution people already relied on — it needs a reason. */
function reasonForClosed(status: string, reason: string | undefined, verb: string): string | null {
  const terminal = status === 'completed' || status === 'cancelled' || status === 'failed';
  const r = (reason ?? '').trim();
  if (terminal && !r) {
    throw new ValidationError([
      `This task is ${status}. A reason is required to ${verb} its objective — the attribution is already part of the record.`,
    ]);
  }
  return r || null;
}

async function setTaskObjective(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  objectiveId: string | null,
): Promise<void> {
  await tx
    .update(tasks)
    .set({ objectiveId, updatedAt: new Date() })
    .where(and(eq(tasks.id, taskId), eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)));
}

/**
 * Attach an UNTIED task to an objective (req #6). Idempotent: attaching to the objective it already
 * has is a no-op. Refuses to attach a task that is already tied to a different objective (use move),
 * and refuses to tie work to a closed objective. Admin + same-workspace enforced; audited.
 */
export async function attachTaskToObjective(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  objectiveId: string,
  reason?: string,
): Promise<boolean> {
  requireAdmin(ctx);
  const task = await loadTaskLinkState(tx, ctx, taskId);
  if (task.objectiveId === objectiveId) return false; // idempotent
  if (task.objectiveId) {
    throw new ConflictError('This task is already tied to another objective — move it instead.');
  }
  const objective = await resolveObjective(tx, ctx, objectiveId);
  if (objective.status === 'cancelled' || objective.status === 'completed') {
    throw new ConflictError(`Cannot attach work to a ${objective.status} objective.`);
  }
  const r = reasonForClosed(task.status, reason, 'attach');
  await setTaskObjective(tx, ctx, taskId, objectiveId);
  await writeAudit(tx, ctx, {
    action: 'task.objective_attached',
    entityType: 'task',
    entityId: taskId,
    detail: { objectiveId, objectiveTitle: objective.title, reason: r },
  });
  return true;
}

/**
 * Move a tied task to a DIFFERENT objective (req #6). Idempotent when already there. Refuses an
 * untied task (use attach) and a closed target. A reason is required for completed work (req #7).
 */
export async function moveTaskToObjective(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  objectiveId: string,
  reason: string,
): Promise<boolean> {
  requireAdmin(ctx);
  const task = await loadTaskLinkState(tx, ctx, taskId);
  if (!task.objectiveId) {
    throw new ConflictError('This task is not tied to an objective yet — attach it instead.');
  }
  if (task.objectiveId === objectiveId) return false; // idempotent
  const objective = await resolveObjective(tx, ctx, objectiveId);
  if (objective.status === 'cancelled' || objective.status === 'completed') {
    throw new ConflictError(`Cannot move work onto a ${objective.status} objective.`);
  }
  const r = reasonForClosed(task.status, reason, 'move');
  await setTaskObjective(tx, ctx, taskId, objectiveId);
  await writeAudit(tx, ctx, {
    action: 'task.objective_moved',
    entityType: 'task',
    entityId: taskId,
    detail: { from: task.objectiveId, to: objectiveId, objectiveTitle: objective.title, reason: r },
  });
  return true;
}

/**
 * Detach a task from its objective (req #6). Idempotent when already untied. A reason is required for
 * completed work (req #7). Preserves all history — only the FK is cleared, with an audit event.
 */
export async function detachTaskFromObjective(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  reason: string,
): Promise<boolean> {
  requireAdmin(ctx);
  const task = await loadTaskLinkState(tx, ctx, taskId);
  if (!task.objectiveId) return false; // idempotent no-op
  const r = reasonForClosed(task.status, reason, 'detach');
  await setTaskObjective(tx, ctx, taskId, null);
  await writeAudit(tx, ctx, {
    action: 'task.objective_detached',
    entityType: 'task',
    entityId: taskId,
    detail: { from: task.objectiveId, reason: r },
  });
  return true;
}

/**
 * Apply a historical repair to a task's objective link (req #8/#10). Distinct from a user-initiated
 * attach/move/detach: this is the deliberate correction of a contradictory record the detector found,
 * and it is audited as `task.objective_reconciled` with the reason. Admin + reason required; the target
 * objective (when non-null) must be in this workspace. Idempotent when the link already matches.
 */
export async function reconcileTaskObjective(
  tx: DbTx,
  ctx: TenantContext,
  taskId: string,
  targetObjectiveId: string | null,
  reason: string,
): Promise<boolean> {
  requireAdmin(ctx);
  const r = (reason ?? '').trim();
  if (!r) throw new ValidationError(['A reason is required to reconcile an objective relationship.']);
  const task = await loadTaskLinkState(tx, ctx, taskId);
  if (task.objectiveId === targetObjectiveId) return false; // idempotent
  let objectiveTitle: string | null = null;
  if (targetObjectiveId) {
    // A repair may deliberately point at any in-workspace objective (including a closed one, when the
    // truthful historical attribution is to a since-closed goal). Cross-workspace is still rejected.
    objectiveTitle = (await resolveObjective(tx, ctx, targetObjectiveId)).title;
  }
  await setTaskObjective(tx, ctx, taskId, targetObjectiveId);
  await writeAudit(tx, ctx, {
    action: 'task.objective_reconciled',
    entityType: 'task',
    entityId: taskId,
    detail: { from: task.objectiveId, to: targetObjectiveId, objectiveTitle, reason: r },
  });
  return true;
}

// ---------------------------------------------------------------------------
// Read-only link detector (req #8). Never mutates.
// ---------------------------------------------------------------------------
export type LinkFindingCategory =
  | 'fk_closed_objective' // FK → a cancelled/completed objective
  | 'fk_foreign_or_missing' // FK set but the objective is not in this workspace
  | 'context_only_no_link' // no FK, but a run received an objective as context
  | 'context_fk_mismatch'; // FK objective ≠ the objective named in run context

/**
 * Finding severity (owner terminology, HUB-003 close-out). Not every finding is a defect:
 *  - historical_valid — a COMPLETED/terminal task tied to a since-closed objective; the attribution is
 *    true history and must remain unchanged.
 *  - warning — an OPEN/in-flight task tied to a closed objective (working toward a dead goal), or a run
 *    that named a different objective as context than the durable FK.
 *  - error — a missing/cross-workspace objective, or genuinely conflicting DURABLE sources.
 *  - context_only — a run named an objective while the FK is null; context is NOT, on its own, a link.
 */
export type LinkFindingSeverity = 'historical_valid' | 'warning' | 'error' | 'context_only';

const TERMINAL_TASK_STATUSES = new Set(['completed', 'cancelled', 'failed']);

export interface LinkFinding {
  taskId: string;
  taskTitle: string;
  taskStatus: string;
  category: LinkFindingCategory;
  severity: LinkFindingSeverity;
  objectiveId: string | null;
  objectiveTitle: string | null;
  objectiveStatus: string | null;
  contextObjectiveTitles: string[];
  detail: string;
  recommendation: string;
}

export interface LinkAuditReport {
  scanned: { tasks: number; runs: number };
  /** Tasks with no finding at all (cleanly tied to an open objective, or cleanly unrelated). */
  clean: number;
  findings: LinkFinding[];
  /** Count of findings per severity, so a caller can gate on error/warning while ignoring history. */
  bySeverity: Record<LinkFindingSeverity, number>;
  /** Structural guarantee note: with a single FK, "objective lists task but task has no FK", its inverse,
   *  and "two DURABLE sources disagree" are impossible by construction — reported, not silently assumed. */
  structurallyConsistent: string[];
}

/** Objective titles a run named as CONTEXT (source objective/objective_progress) — a display label, not a link. */
function objectiveTitlesFromManifest(manifest: ContextManifestEntry[] | null): string[] {
  if (!Array.isArray(manifest)) return [];
  const titles = manifest
    .filter((e) => e && (e.source === 'objective' || e.source === 'objective_progress') && !!e.label)
    .map((e) => e.label);
  return [...new Set(titles)];
}

export async function detectObjectiveLinkContradictions(
  tx: DbTx,
  ctx: TenantContext,
): Promise<LinkAuditReport> {
  const taskRows = await tx
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      objectiveId: tasks.objectiveId,
      objectiveTitle: objectives.title,
      objectiveStatus: objectives.status,
    })
    .from(tasks)
    .leftJoin(
      objectives,
      // Join ONLY within the workspace — so an FK pointing at a cross-workspace objective yields a
      // null join and is caught as a contradiction rather than silently resolved.
      and(
        eq(tasks.objectiveId, objectives.id),
        eq(objectives.projectId, ctx.projectId),
        eq(objectives.orgId, ctx.orgId),
      ),
    )
    .where(and(eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)));

  const runRows = await tx
    .select({ taskId: runs.taskId, contextManifest: runs.contextManifest })
    .from(runs)
    .where(and(eq(runs.projectId, ctx.projectId), eq(runs.orgId, ctx.orgId)));

  // Fold run-context objective titles per task (a task may have several runs).
  const contextByTask = new Map<string, Set<string>>();
  for (const run of runRows) {
    const titles = objectiveTitlesFromManifest(run.contextManifest);
    if (titles.length === 0) continue;
    const set = contextByTask.get(run.taskId) ?? new Set<string>();
    titles.forEach((t) => set.add(t));
    contextByTask.set(run.taskId, set);
  }

  const findings: LinkFinding[] = [];
  let clean = 0;

  for (const t of taskRows) {
    const contextTitles = [...(contextByTask.get(t.id) ?? [])];
    const base = {
      taskId: t.id,
      taskTitle: t.title,
      taskStatus: t.status,
      objectiveId: t.objectiveId,
      objectiveTitle: t.objectiveTitle,
      objectiveStatus: t.objectiveStatus,
      contextObjectiveTitles: contextTitles,
    };

    if (t.objectiveId && t.objectiveTitle === null) {
      // FK set but no in-workspace objective joined → cross-workspace or otherwise unresolvable.
      findings.push({
        ...base,
        category: 'fk_foreign_or_missing',
        severity: 'error',
        detail: 'The task points to an objective that is not in this workspace.',
        recommendation: 'Detach — a task cannot contribute to a cross-workspace or missing objective.',
      });
      continue;
    }

    if (t.objectiveId && (t.objectiveStatus === 'cancelled' || t.objectiveStatus === 'completed')) {
      // A finished task tied to a since-closed objective is TRUE HISTORY — keep it. An open/in-flight
      // task tied to a closed objective is working toward a dead goal — flag it.
      const terminal = TERMINAL_TASK_STATUSES.has(t.status);
      findings.push({
        ...base,
        category: 'fk_closed_objective',
        severity: terminal ? 'historical_valid' : 'warning',
        detail: terminal
          ? `Completed work tied to a ${t.objectiveStatus} objective ("${t.objectiveTitle}") — a true historical contribution.`
          : `This ${t.status} task is tied to a ${t.objectiveStatus} objective ("${t.objectiveTitle}") — it is working toward a closed goal.`,
        recommendation: terminal
          ? 'Historical-valid — leave unchanged. The attribution truthfully records work done before the objective closed.'
          : 'Re-attribute to a live objective, or detach — the goal it points to is no longer open.',
      });
      continue;
    }

    if (t.objectiveId && contextTitles.length > 0 && !contextTitles.includes(t.objectiveTitle ?? '')) {
      findings.push({
        ...base,
        category: 'context_fk_mismatch',
        severity: 'warning',
        detail: `The task is durably tied to "${t.objectiveTitle}", but a run named a different objective as context (${contextTitles.join(', ')}). The FK is authoritative; context is only a label.`,
        recommendation: 'Verify which objective is correct; move the task if the durable FK is wrong.',
      });
      continue;
    }

    if (!t.objectiveId && contextTitles.length > 0) {
      findings.push({
        ...base,
        category: 'context_only_no_link',
        severity: 'context_only',
        detail: `The task has no objective link, but a run received an objective as context (${contextTitles.join(', ')}). Context is not, on its own, a relationship.`,
        recommendation:
          'Leave detached unless the work truly belongs to that objective — then attach explicitly (an audited decision, never an inference from context).',
      });
      continue;
    }

    clean += 1;
  }

  const bySeverity: Record<LinkFindingSeverity, number> = {
    historical_valid: 0,
    warning: 0,
    error: 0,
    context_only: 0,
  };
  for (const f of findings) bySeverity[f.severity] += 1;

  return {
    scanned: { tasks: taskRows.length, runs: runRows.length },
    clean,
    findings,
    bySeverity,
    structurallyConsistent: [
      'Objective contributing-work list and progress both read tasks.objective_id — a listed task always has the FK.',
      'The approval and Work surfaces read the same FK, so none can list a task the objective omits.',
      'Only one DURABLE objective source exists (tasks.objective_id); two durable sources cannot disagree.',
    ],
  };
}

export interface AttachableObjective {
  id: string;
  title: string;
  status: string;
}

/** Open objectives (draft/active) a task may be attached to or moved onto, for the relationship picker. */
export async function listOpenObjectives(
  tx: DbTx,
  ctx: TenantContext,
): Promise<AttachableObjective[]> {
  const rows = await tx
    .select({ id: objectives.id, title: objectives.title, status: objectives.status })
    .from(objectives)
    .where(and(eq(objectives.projectId, ctx.projectId), eq(objectives.orgId, ctx.orgId)));
  return rows
    .filter((o) => o.status === 'draft' || o.status === 'active')
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** Classify a single task's objective relationship for truthful display (req #2). */
export function classifyTaskObjectiveLink(input: {
  objectiveId: string | null;
  objectiveStatus: string | null;
  hadObjectiveContext: boolean;
}): ObjectiveLinkClass {
  if (input.objectiveId) {
    return input.objectiveStatus === 'cancelled' || input.objectiveStatus === 'completed'
      ? 'tied_to_closed'
      : 'directly_tied';
  }
  return input.hadObjectiveContext ? 'context_only' : 'none';
}
