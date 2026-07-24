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
import { agents, departments, milestones, objectives, tasks } from '@/db/schema';
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

  const taskMap = new Map(taskCounts.map((t) => [t.objectiveId, t]));
  const milestoneMap = new Map(milestoneCounts.map((m) => [m.objectiveId, m]));

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
  progress: ObjectiveProgress;
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
    progress: { ...base, percent: computePercent(base) },
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
): Promise<void> {
  if (!OBJECTIVE_STATUSES.includes(next)) throw new ValidationError(['Invalid status.']);
  const detail = await getObjective(tx, ctx, objectiveId);

  if (!TRANSITIONS[detail.status].includes(next)) {
    throw new ConflictError(`An objective cannot go from ${detail.status} to ${next}.`);
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

  await tx
    .update(objectives)
    .set({ status: next, updatedAt: new Date() })
    .where(and(eq(objectives.id, objectiveId), eq(objectives.projectId, ctx.projectId)));

  await writeAudit(tx, ctx, {
    action: `objective.${next === 'active' ? 'activated' : next}`,
    entityType: 'objective',
    entityId: objectiveId,
    detail: { from: detail.status, to: next },
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
  if (detail.status === 'completed' || detail.status === 'cancelled') {
    throw new ConflictError('Criteria on a closed objective cannot change.');
  }
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
