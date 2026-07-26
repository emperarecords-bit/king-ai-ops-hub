import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  MILESTONE_STATUSES,
  type MilestoneStatus,
  OBJECTIVE_STATUSES,
  type ObjectiveStatus,
  type SuccessCriterion,
  type TenantContext,
} from '@/types/domain';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { METRIC_PATTERN, slugifyMetric } from '@/lib/slug';
import { type DbTx } from '@/db/client';
import { agents, departments, milestones, objectives, profiles, tasks, workItems } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Objectives: the unit of business intent (D-010, OBJECTIVES.md).
 *
 * The one rule everything here protects: an objective CANNOT reach
 * `completed` while any success criterion is `unmet` (SPRINT-03-PLAN §5.3).
 * Criteria are met or explicitly waived by a human; both transitions and any
 * post-activation criteria edits are audit events — goalposts move only in
 * daylight.
 */

/**
 * A criterion must be checkable by a human later (O-11). Negative targets are
 * rejected outright; zero is allowed because "zero critical defects" is a
 * legitimate goal, but the SUGGESTER may not propose it for growth units —
 * see domain/objectives/suggest.ts.
 *
 * `metric` is a machine identifier, not a sentence: it is the field a future
 * `source: "usage"` binding joins on, so it is normalized to a slug rather
 * than trusted as typed.
 */
const criterionInputSchema = z.object({
  label: z.string().trim().min(1, 'Criterion label is required').max(200),
  metric: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .transform(slugifyMetric)
    .refine((m) => METRIC_PATTERN.test(m), 'Metric must be a lowercase identifier.'),
  target: z
    .number()
    .finite()
    .min(0, 'A target cannot be negative — state the threshold that counts as success.'),
  unit: z.string().trim().max(50).default(''),
});

export const createObjectiveSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().trim().max(4_000).default(''),
  successCriteria: z.array(criterionInputSchema).max(20).default([]),
  sponsoringDepartmentId: z.string().uuid().nullable().default(null),
  accountableAgentId: z.string().uuid().nullable().default(null),
});

export type CreateObjectiveInput = z.input<typeof createObjectiveSchema>;

export async function createObjective(
  tx: DbTx,
  ctx: TenantContext,
  input: CreateObjectiveInput,
): Promise<string> {
  const parsed = createObjectiveSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message));
  }

  const criteria: SuccessCriterion[] = parsed.data.successCriteria.map((c) => ({
    label: c.label,
    metric: c.metric,
    target: c.target,
    unit: c.unit,
    source: 'manual',
    status: 'unmet',
    verifiedBy: null,
    verifiedAt: null,
  }));

  const inserted = await tx
    .insert(objectives)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      title: parsed.data.title,
      description: parsed.data.description,
      status: 'draft',
      successCriteria: criteria,
      sponsoringDepartmentId: parsed.data.sponsoringDepartmentId,
      accountableAgentId: parsed.data.accountableAgentId,
      createdBy: ctx.userId,
    })
    .returning({ id: objectives.id });
  const objectiveId = inserted[0]!.id;

  await writeAudit(tx, ctx, {
    action: 'objective.created',
    entityType: 'objective',
    entityId: objectiveId,
    detail: { title: parsed.data.title, criteria: criteria.length },
  });
  return objectiveId;
}

export interface ObjectiveProgress {
  tasksTotal: number;
  tasksCompleted: number;
  criteriaTotal: number;
  criteriaSatisfied: number; // met + waived
  milestonesTotal: number;
  milestonesCompleted: number;
  /** 0..100. Tasks when any exist, else criteria, else 0. */
  percent: number;
}

export interface ObjectiveListRow {
  id: string;
  title: string;
  status: ObjectiveStatus;
  priority: number;
  sponsoringDepartment: string | null;
  accountableEmployee: string | null;
  progress: ObjectiveProgress;
  /** The success contract — for criteria-and-evidence assessment (assess.ts). */
  successCriteria: SuccessCriterion[];
  /** Human Work Items attached to this objective (effort, not progress). */
  workItemTotal: number;
  createdAt: Date;
}

function computePercent(p: Omit<ObjectiveProgress, 'percent'>): number {
  if (p.tasksTotal > 0) return Math.round((p.tasksCompleted / p.tasksTotal) * 100);
  if (p.criteriaTotal > 0) return Math.round((p.criteriaSatisfied / p.criteriaTotal) * 100);
  return 0;
}

export async function listObjectives(tx: DbTx, ctx: TenantContext): Promise<ObjectiveListRow[]> {
  const rows = await tx
    .select({
      id: objectives.id,
      title: objectives.title,
      status: objectives.status,
      priority: objectives.priority,
      successCriteria: objectives.successCriteria,
      createdAt: objectives.createdAt,
      departmentName: departments.name,
      agentName: agents.name,
    })
    .from(objectives)
    .leftJoin(departments, eq(objectives.sponsoringDepartmentId, departments.id))
    .leftJoin(agents, eq(objectives.accountableAgentId, agents.id))
    .where(and(eq(objectives.projectId, ctx.projectId), eq(objectives.orgId, ctx.orgId)))
    .orderBy(asc(objectives.priority), desc(objectives.createdAt));

  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);

  const taskCounts = await tx
    .select({
      objectiveId: tasks.objectiveId,
      total: sql<string>`count(*)`,
      completed: sql<string>`count(*) filter (where ${tasks.status} = 'completed')`,
    })
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.projectId), inArray(tasks.objectiveId, ids)))
    .groupBy(tasks.objectiveId);

  const milestoneCounts = await tx
    .select({
      objectiveId: milestones.objectiveId,
      total: sql<string>`count(*)`,
      completed: sql<string>`count(*) filter (where ${milestones.status} = 'completed')`,
    })
    .from(milestones)
    .where(and(eq(milestones.projectId, ctx.projectId), inArray(milestones.objectiveId, ids)))
    .groupBy(milestones.objectiveId);

  const workItemCounts = await tx
    .select({ objectiveId: workItems.objectiveId, total: sql<string>`count(*)` })
    .from(workItems)
    .where(and(eq(workItems.projectId, ctx.projectId), inArray(workItems.objectiveId, ids)))
    .groupBy(workItems.objectiveId);

  const taskMap = new Map(taskCounts.map((t) => [t.objectiveId, t]));
  const milestoneMap = new Map(milestoneCounts.map((m) => [m.objectiveId, m]));
  const workItemMap = new Map(workItemCounts.map((w) => [w.objectiveId, w]));

  return rows.map((r) => {
    const t = taskMap.get(r.id);
    const m = milestoneMap.get(r.id);
    const criteria = r.successCriteria;
    const base = {
      tasksTotal: Number(t?.total ?? 0),
      tasksCompleted: Number(t?.completed ?? 0),
      criteriaTotal: criteria.length,
      criteriaSatisfied: criteria.filter((c) => c.status !== 'unmet').length,
      milestonesTotal: Number(m?.total ?? 0),
      milestonesCompleted: Number(m?.completed ?? 0),
    };
    return {
      id: r.id,
      title: r.title,
      status: r.status,
      priority: r.priority,
      sponsoringDepartment: r.departmentName,
      accountableEmployee: r.agentName,
      progress: { ...base, percent: computePercent(base) },
      successCriteria: criteria,
      workItemTotal: Number(workItemMap.get(r.id)?.total ?? 0),
      createdAt: r.createdAt,
    };
  });
}

export interface MilestoneRow {
  id: string;
  title: string;
  status: MilestoneStatus;
  position: number;
  targetDate: Date | null;
}

export interface ObjectiveTaskRow {
  id: string;
  title: string;
  status: string;
  createdAt: Date;
}

/**
 * The compact objective view the runner injects into a task's prompt so an
 * employee works with its goal in view (closes the O-9 disconnect). Returns
 * null when the id is absent or the objective is closed — a completed or
 * cancelled objective is not live intent. Tenant-scoped like every read here.
 */
export interface ObjectiveForRun {
  title: string;
  description: string;
  openCriteria: string[];
}

export async function loadObjectiveForRun(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string | null,
): Promise<ObjectiveForRun | null> {
  if (!objectiveId) return null;
  const rows = await tx
    .select({
      title: objectives.title,
      description: objectives.description,
      status: objectives.status,
      successCriteria: objectives.successCriteria,
    })
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
  if (!row || row.status === 'completed' || row.status === 'cancelled') return null;
  return {
    title: row.title,
    description: row.description,
    openCriteria: row.successCriteria.filter((c) => c.status === 'unmet').map((c) => c.label),
  };
}

export interface ObjectiveDetail {
  id: string;
  title: string;
  description: string;
  status: ObjectiveStatus;
  priority: number;
  successCriteria: SuccessCriterion[];
  sponsoringDepartmentId: string | null;
  sponsoringDepartment: string | null;
  accountableAgentId: string | null;
  accountableEmployee: string | null;
  milestones: MilestoneRow[];
  tasks: ObjectiveTaskRow[];
  /** Human Work Items attached to this objective — effort, shown alongside AI tasks. */
  workItems: { id: string; title: string; stage: string }[];
  progress: ObjectiveProgress;
  /** Frozen closure record (completed/cancelled only). */
  closedByName: string | null;
  closedAt: Date | null;
  closureReason: string | null;
  /** Display names for criterion verifiers (verifiedBy id → name), for evidence provenance. */
  verifierNames: Record<string, string>;
  createdAt: Date;
}

export async function getObjective(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string,
): Promise<ObjectiveDetail> {
  const rows = await tx
    .select({
      id: objectives.id,
      title: objectives.title,
      description: objectives.description,
      status: objectives.status,
      priority: objectives.priority,
      successCriteria: objectives.successCriteria,
      sponsoringDepartmentId: objectives.sponsoringDepartmentId,
      accountableAgentId: objectives.accountableAgentId,
      closedBy: objectives.closedBy,
      closedAt: objectives.closedAt,
      closureReason: objectives.closureReason,
      createdAt: objectives.createdAt,
      departmentName: departments.name,
      agentName: agents.name,
    })
    .from(objectives)
    .leftJoin(departments, eq(objectives.sponsoringDepartmentId, departments.id))
    .leftJoin(agents, eq(objectives.accountableAgentId, agents.id))
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

  const ms = await tx
    .select({
      id: milestones.id,
      title: milestones.title,
      status: milestones.status,
      position: milestones.position,
      targetDate: milestones.targetDate,
    })
    .from(milestones)
    .where(and(eq(milestones.objectiveId, objectiveId), eq(milestones.projectId, ctx.projectId)))
    .orderBy(asc(milestones.position), asc(milestones.createdAt));

  const attachedTasks = await tx
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      createdAt: tasks.createdAt,
    })
    .from(tasks)
    .where(and(eq(tasks.objectiveId, objectiveId), eq(tasks.projectId, ctx.projectId)))
    .orderBy(desc(tasks.createdAt));

  const attachedWorkItems = await tx
    .select({ id: workItems.id, title: workItems.title, stage: workItems.stage })
    .from(workItems)
    .where(and(eq(workItems.objectiveId, objectiveId), eq(workItems.projectId, ctx.projectId)))
    .orderBy(desc(workItems.createdAt));

  // Resolve the people behind criterion evidence and the closure, for provenance wording.
  const personIds = [
    ...new Set(row.successCriteria.map((c) => c.verifiedBy).filter((x): x is string => !!x)),
  ];
  if (row.closedBy) personIds.push(row.closedBy);
  const people = personIds.length
    ? await tx.select({ id: profiles.id, name: profiles.displayName }).from(profiles).where(inArray(profiles.id, personIds))
    : [];
  const nameById = new Map(people.map((p) => [p.id, p.name]));

  const base = {
    tasksTotal: attachedTasks.length,
    tasksCompleted: attachedTasks.filter((t) => t.status === 'completed').length,
    criteriaTotal: row.successCriteria.length,
    criteriaSatisfied: row.successCriteria.filter((c) => c.status !== 'unmet').length,
    milestonesTotal: ms.length,
    milestonesCompleted: ms.filter((m) => m.status === 'completed').length,
  };

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    successCriteria: row.successCriteria,
    sponsoringDepartmentId: row.sponsoringDepartmentId,
    sponsoringDepartment: row.departmentName,
    accountableAgentId: row.accountableAgentId,
    accountableEmployee: row.agentName,
    milestones: ms,
    tasks: attachedTasks,
    workItems: attachedWorkItems,
    progress: { ...base, percent: computePercent(base) },
    closedByName: row.closedBy ? (nameById.get(row.closedBy) ?? null) : null,
    closedAt: row.closedAt,
    closureReason: row.closureReason,
    verifierNames: Object.fromEntries(nameById),
    createdAt: row.createdAt,
  };
}

/** Legal status transitions. The completion gate is checked separately. */
const TRANSITIONS: Record<ObjectiveStatus, readonly ObjectiveStatus[]> = {
  draft: ['active', 'cancelled'],
  active: ['completed', 'cancelled'],
  completed: [],
  cancelled: [],
};

export async function setObjectiveStatus(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string,
  next: ObjectiveStatus,
  /** Required when cancelling — the strategic reason, kept as institutional memory. Optional
   *  caveat on completion. */
  reason?: string,
): Promise<void> {
  if (!OBJECTIVE_STATUSES.includes(next)) throw new ValidationError(['Invalid status.']);
  const detail = await getObjective(tx, ctx, objectiveId);

  if (!TRANSITIONS[detail.status].includes(next)) {
    throw new ConflictError(`An objective cannot go from ${detail.status} to ${next}.`);
  }

  const trimmedReason = reason?.trim() || null;
  if (next === 'cancelled' && !trimmedReason) {
    throw new ValidationError([
      'A cancellation reason is required — why the objective is being abandoned is the institutional memory that makes it useful later.',
    ]);
  }

  // Executive decision 2026-07-24: activation requires a measurable
  // definition of success. Drafts may exist without criteria — thinking is
  // allowed to be unfinished — but an ACTIVE objective with nothing to
  // satisfy makes the completion gate vacuous (OBSERVATIONS.md O-1).
  if (next === 'active' && detail.successCriteria.length === 0) {
    throw new ConflictError(
      'An objective needs at least one success criterion before it can become active — otherwise "complete" means nothing. Add how you will know this succeeded.',
    );
  }

  // THE completion gate (SPRINT-03-PLAN §5.3): every criterion met or waived.
  if (next === 'completed') {
    const unmet = detail.successCriteria.filter((c) => c.status === 'unmet');
    if (unmet.length > 0) {
      throw new ConflictError(
        `Cannot complete: ${unmet.length} success criteri${unmet.length === 1 ? 'on is' : 'a are'} unmet (${unmet
          .map((c) => c.label)
          .join(', ')}). Mark each met or explicitly waive it first.`,
      );
    }
  }

  const terminal = next === 'completed' || next === 'cancelled';
  await tx
    .update(objectives)
    .set({
      status: next,
      updatedAt: new Date(),
      ...(terminal
        ? { closedBy: ctx.userId, closedAt: new Date(), closureReason: trimmedReason }
        : {}),
    })
    .where(and(eq(objectives.id, objectiveId), eq(objectives.projectId, ctx.projectId)));

  await writeAudit(tx, ctx, {
    action: `objective.${next === 'active' ? 'activated' : next}`,
    entityType: 'objective',
    entityId: objectiveId,
    detail: { from: detail.status, to: next, reason: trimmedReason },
  });
}

export async function setCriterionStatus(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string,
  criterionIndex: number,
  status: 'met' | 'waived' | 'unmet',
): Promise<void> {
  const detail = await getObjective(tx, ctx, objectiveId);
  assertOpenForCriteriaChange(detail.status);
  const current = detail.successCriteria[criterionIndex];
  if (!current) throw new NotFoundError('Success criterion');

  const updated: SuccessCriterion = {
    ...current,
    status,
    verifiedBy: status === 'unmet' ? null : ctx.userId,
    verifiedAt: status === 'unmet' ? null : new Date().toISOString(),
  };
  const next = [...detail.successCriteria];
  next[criterionIndex] = updated;

  await tx
    .update(objectives)
    .set({ successCriteria: next, updatedAt: new Date() })
    .where(and(eq(objectives.id, objectiveId), eq(objectives.projectId, ctx.projectId)));

  await writeAudit(tx, ctx, {
    action: status === 'unmet' ? 'objective.criterion_reopened' : `objective.criterion_${status}`,
    entityType: 'objective',
    entityId: objectiveId,
    detail: { criterion: current.label, index: criterionIndex },
  });
}

/**
 * Criteria editing (LIFECYCLE-AUDIT, critical gap). Until now a criterion's
 * content was frozen at creation and only its status could move — so a
 * criterion generated wrong (O-11: three targets of 0) was permanent, and the
 * only escape was waiving a bug as though it had been a goal.
 *
 * The rule that keeps D-017 honest while allowing correction: **changing what
 * is measured invalidates any verification of it.** Editing the target or
 * unit resets the criterion to `unmet`; editing only the label (a typo, a
 * clarification) preserves status, because the measure did not change. Both
 * are audited with before and after.
 */
export const editCriterionSchema = z.object({
  label: z.string().trim().min(1, 'Criterion label is required').max(200),
  target: z.number().finite().min(0, 'A target cannot be negative.'),
  unit: z.string().trim().max(50).default(''),
});

export async function updateCriterion(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string,
  criterionIndex: number,
  input: z.input<typeof editCriterionSchema>,
): Promise<void> {
  const parsed = editCriterionSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));

  const detail = await getObjective(tx, ctx, objectiveId);
  assertOpenForCriteriaChange(detail.status);
  const current = detail.successCriteria[criterionIndex];
  if (!current) throw new NotFoundError('Success criterion');

  const measureChanged = current.target !== parsed.data.target || current.unit !== parsed.data.unit;

  const updated: SuccessCriterion = {
    ...current,
    label: parsed.data.label,
    metric: slugifyMetric(parsed.data.label),
    target: parsed.data.target,
    unit: parsed.data.unit,
    // A verification of the old measure says nothing about the new one.
    status: measureChanged ? 'unmet' : current.status,
    verifiedBy: measureChanged ? null : current.verifiedBy,
    verifiedAt: measureChanged ? null : current.verifiedAt,
  };

  const next = [...detail.successCriteria];
  next[criterionIndex] = updated;
  await writeCriteria(tx, ctx, objectiveId, next);

  await writeAudit(tx, ctx, {
    action: 'objective.criterion_edited',
    entityType: 'objective',
    entityId: objectiveId,
    detail: {
      index: criterionIndex,
      from: { label: current.label, target: current.target, unit: current.unit },
      to: { label: updated.label, target: updated.target, unit: updated.unit },
      statusReset: measureChanged && current.status !== 'unmet',
    },
  });
}

export async function addCriterion(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string,
  input: z.input<typeof editCriterionSchema>,
): Promise<void> {
  const parsed = editCriterionSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));

  const detail = await getObjective(tx, ctx, objectiveId);
  assertOpenForCriteriaChange(detail.status);
  if (detail.successCriteria.length >= 20) {
    throw new ConflictError('An objective can hold at most 20 success criteria.');
  }

  const added: SuccessCriterion = {
    label: parsed.data.label,
    metric: slugifyMetric(parsed.data.label),
    target: parsed.data.target,
    unit: parsed.data.unit,
    source: 'manual',
    status: 'unmet',
    verifiedBy: null,
    verifiedAt: null,
  };
  await writeCriteria(tx, ctx, objectiveId, [...detail.successCriteria, added]);

  await writeAudit(tx, ctx, {
    action: 'objective.criterion_added',
    entityType: 'objective',
    entityId: objectiveId,
    detail: { label: added.label, target: added.target, unit: added.unit },
  });
}

export async function removeCriterion(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string,
  criterionIndex: number,
): Promise<void> {
  const detail = await getObjective(tx, ctx, objectiveId);
  assertOpenForCriteriaChange(detail.status);
  const current = detail.successCriteria[criterionIndex];
  if (!current) throw new NotFoundError('Success criterion');

  // An active objective with no criteria would sit past D-017's activation
  // gate with nothing left to satisfy — the exact state that rule exists to
  // prevent. Draft objectives may empty out; they cannot activate that way.
  if (detail.status === 'active' && detail.successCriteria.length === 1) {
    throw new ConflictError(
      'An active objective needs at least one success criterion. Add its replacement first, or cancel the objective.',
    );
  }

  const next = detail.successCriteria.filter((_, i) => i !== criterionIndex);
  await writeCriteria(tx, ctx, objectiveId, next);

  await writeAudit(tx, ctx, {
    action: 'objective.criterion_removed',
    entityType: 'objective',
    entityId: objectiveId,
    detail: {
      label: current.label,
      target: current.target,
      unit: current.unit,
      hadStatus: current.status,
    },
  });
}

function assertOpenForCriteriaChange(status: ObjectiveStatus): void {
  if (status === 'completed' || status === 'cancelled') {
    throw new ConflictError('Criteria on a closed objective cannot change.');
  }
}

async function writeCriteria(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string,
  criteria: SuccessCriterion[],
): Promise<void> {
  await tx
    .update(objectives)
    .set({ successCriteria: criteria, updatedAt: new Date() })
    .where(and(eq(objectives.id, objectiveId), eq(objectives.projectId, ctx.projectId)));
}

/** Title and description are content, not state — correcting them is not a status change. */
export const editObjectiveSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().trim().max(4_000).default(''),
});

export async function updateObjectiveDetails(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string,
  input: z.input<typeof editObjectiveSchema>,
): Promise<void> {
  const parsed = editObjectiveSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));

  const detail = await getObjective(tx, ctx, objectiveId);
  if (detail.status === 'completed' || detail.status === 'cancelled') {
    throw new ConflictError('A closed objective cannot be rewritten.');
  }

  await tx
    .update(objectives)
    .set({
      title: parsed.data.title,
      description: parsed.data.description,
      updatedAt: new Date(),
    })
    .where(and(eq(objectives.id, objectiveId), eq(objectives.projectId, ctx.projectId)));

  await writeAudit(tx, ctx, {
    action: 'objective.details_edited',
    entityType: 'objective',
    entityId: objectiveId,
    detail: { title: { from: detail.title, to: parsed.data.title } },
  });
}

export const addMilestoneSchema = z.object({
  title: z.string().trim().min(1, 'Milestone title is required').max(200),
});

export async function addMilestone(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId: string,
  input: z.input<typeof addMilestoneSchema>,
): Promise<string> {
  const parsed = addMilestoneSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));

  // Existence + tenancy check.
  const detail = await getObjective(tx, ctx, objectiveId);
  if (detail.status === 'completed' || detail.status === 'cancelled') {
    throw new ConflictError('A closed objective cannot gain milestones.');
  }

  const inserted = await tx
    .insert(milestones)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      objectiveId,
      title: parsed.data.title,
      position: detail.milestones.length,
    })
    .returning({ id: milestones.id });

  await writeAudit(tx, ctx, {
    action: 'milestone.created',
    entityType: 'milestone',
    entityId: inserted[0]!.id,
    detail: { objectiveId, title: parsed.data.title },
  });
  return inserted[0]!.id;
}

export async function setMilestoneStatus(
  tx: DbTx,
  ctx: TenantContext,
  milestoneId: string,
  status: MilestoneStatus,
): Promise<void> {
  if (!MILESTONE_STATUSES.includes(status)) throw new ValidationError(['Invalid status.']);
  const updated = await tx
    .update(milestones)
    .set({ status, updatedAt: new Date() })
    .where(and(eq(milestones.id, milestoneId), eq(milestones.projectId, ctx.projectId)))
    .returning({ id: milestones.id, objectiveId: milestones.objectiveId });
  if (updated.length === 0) throw new NotFoundError('Milestone');

  await writeAudit(tx, ctx, {
    action: 'milestone.status_changed',
    entityType: 'milestone',
    entityId: milestoneId,
    detail: { objectiveId: updated[0]!.objectiveId, to: status },
  });
}

export interface DepartmentOption {
  id: string;
  key: string;
  name: string;
}

export async function listDepartments(tx: DbTx, ctx: TenantContext): Promise<DepartmentOption[]> {
  return tx
    .select({ id: departments.id, key: departments.key, name: departments.name })
    .from(departments)
    .where(eq(departments.orgId, ctx.orgId))
    .orderBy(asc(departments.name));
}

export interface EmployeeOption {
  id: string;
  name: string;
  departmentName: string | null;
}

/** Enabled employees of this workspace, for assignment pickers. */
export async function listEmployeeOptions(
  tx: DbTx,
  ctx: TenantContext,
): Promise<EmployeeOption[]> {
  return tx
    .select({ id: agents.id, name: agents.name, departmentName: departments.name })
    .from(agents)
    .leftJoin(departments, eq(agents.departmentId, departments.id))
    .where(
      and(eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId), eq(agents.enabled, true)),
    )
    .orderBy(asc(agents.name));
}
