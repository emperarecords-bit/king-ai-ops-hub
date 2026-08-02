import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  CADENCES,
  FLAGSHIP_CATEGORIES,
  MODEL_TIERS,
  type Cadence,
  type TenantContext,
} from '@/types/domain';
import { PROVIDER_SELECTIONS } from '@/types/provider';
import { AppError, NotFoundError, ValidationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx, getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { taskSchedules, tasks, usageEvents } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { getAssignableAgentById } from '@/domain/agents/agents';
import { createTask } from '@/domain/tasks/tasks';
import { startRun } from '@/domain/tasks/runner';
import { computeNextRunAt } from './cadence';

export { computeNextRunAt };

/**
 * Standing work (Sprint 8, Continuous Operations): the company keeps
 * producing while the owner is away — inside every existing gate.
 *
 * The safety story, explicitly:
 *  - Schedules are HUMAN-authored (project admins only) and audited.
 *  - Each due tick creates exactly one ordinary task and one ordinary run:
 *    the budget preflight, rate limits, cross-review, and approval queue
 *    apply unchanged. Standing work cannot spend past a budget or execute
 *    anything — it can only propose, like all work.
 *  - next_run_at always advances BEFORE execution, so a crashing run can
 *    never cause a catch-up storm; a missed window runs once, not N times.
 *  - The tick is external and dumb (Task Scheduler → script); no model ever
 *    decides what or when to schedule.
 */

export const createScheduleSchema = z
  .object({
    title: z.string().trim().min(1, 'Title is required').max(200),
    input: z.string().trim().min(1, 'The recurring brief is required').max(32_000),
    objectiveId: z.string().uuid().nullable().default(null),
    providerSelection: z.enum(PROVIDER_SELECTIONS),
    reviewEnabled: z.boolean().default(true),
    modelTier: z.enum(MODEL_TIERS).default('standard'),
    flagshipCategory: z.enum(FLAGSHIP_CATEGORIES).nullable().default(null),
    cadence: z.enum(CADENCES),
    atHour: z.number().int().min(0).max(23).default(6),
    weekday: z.number().int().min(0).max(6).nullable().default(null),
    monthday: z.number().int().min(1).max(28).nullable().default(null),
    /** P1a agent pinning — the exact employees every due tick pins its produced task to. Required primary;
     *  reviewer required IFF reviewEnabled and never equal to the primary. Validated against the workspace
     *  in createSchedule/updateSchedule. */
    assignedPrimaryAgentId: z.string().uuid(),
    assignedReviewerAgentId: z.string().uuid().nullable().default(null),
  })
  .refine((v) => v.cadence !== 'weekly' || v.weekday != null, {
    message: 'Weekly standing work needs a weekday.',
  })
  .refine((v) => v.cadence !== 'monthly' || v.monthday != null, {
    message: 'Monthly standing work needs a day of month (1–28).',
  })
  .refine((v) => v.modelTier !== 'flagship' || v.flagshipCategory != null, {
    message: 'Flagship standing work must declare a category.',
  })
  .refine((v) => !v.reviewEnabled || v.assignedReviewerAgentId != null, {
    message: 'A cross-check requires an assigned reviewer employee.',
  })
  .refine((v) => v.reviewEnabled || v.assignedReviewerAgentId == null, {
    message: 'A reviewer can only be assigned when cross-check is enabled.',
  })
  .refine((v) => v.assignedReviewerAgentId == null || v.assignedReviewerAgentId !== v.assignedPrimaryAgentId, {
    message: 'The reviewer must be a different employee than the primary.',
  });

export interface ScheduleRow {
  id: string;
  title: string;
  input: string;
  objectiveId: string | null;
  cadence: Cadence;
  atHour: number;
  weekday: number | null;
  monthday: number | null;
  nextRunAt: Date;
  lastRunAt: Date | null;
  enabled: boolean;
  /** Lifetime spend of the work this schedule produced, USD micros. */
  spentMicros: bigint;
  /** Results produced to date. */
  producedCount: number;
}

const rowSelection = {
  id: taskSchedules.id,
  title: taskSchedules.title,
  input: taskSchedules.input,
  objectiveId: taskSchedules.objectiveId,
  cadence: taskSchedules.cadence,
  atHour: taskSchedules.atHour,
  weekday: taskSchedules.weekday,
  monthday: taskSchedules.monthday,
  nextRunAt: taskSchedules.nextRunAt,
  lastRunAt: taskSchedules.lastRunAt,
  enabled: taskSchedules.enabled,
  // Per-schedule cost attribution: recurring spend must be visible per
  // schedule, not folded into a workspace total (Sprint 8 debt).
  // Table-qualified: Drizzle renders ${taskSchedules.id} unqualified inside
  // raw SQL, which is ambiguous against the subquery's own columns.
  spentMicros: sql<string>`coalesce((
    select sum(u.cost_micros) from ${usageEvents} u
    join ${tasks} t on t.id = u.task_id
    where t.schedule_id = task_schedules.id
  ), 0)`,
  producedCount: sql<string>`(
    select count(*) from ${tasks} t where t.schedule_id = task_schedules.id
  )`,
};

export async function listSchedules(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId?: string,
): Promise<ScheduleRow[]> {
  const base = and(
    eq(taskSchedules.projectId, ctx.projectId),
    eq(taskSchedules.orgId, ctx.orgId),
  );
  const rows = await tx
    .select(rowSelection)
    .from(taskSchedules)
    .where(objectiveId ? and(base, eq(taskSchedules.objectiveId, objectiveId)) : base)
    .orderBy(asc(taskSchedules.nextRunAt));

  return rows.map((r) => ({
    ...r,
    spentMicros: BigInt(r.spentMicros),
    producedCount: Number(r.producedCount),
  }));
}

/**
 * P1a agent pinning — validate a schedule's assigned employees against THIS workspace, fail closed. Returns
 * the ids to persist. Shared by create + edit so both paths pin the same way the task form does: the primary
 * must be an enabled primary-role agent here; a reviewer (required IFF reviewEnabled) an enabled reviewer.
 */
async function validateScheduleAssignment(
  tx: DbTx,
  ctx: TenantContext,
  d: { reviewEnabled: boolean; assignedPrimaryAgentId: string; assignedReviewerAgentId: string | null },
): Promise<{ assignedPrimaryAgentId: string; assignedReviewerAgentId: string | null }> {
  const primary = await getAssignableAgentById(tx, ctx, d.assignedPrimaryAgentId, 'primary');
  if (!primary) {
    throw new ValidationError(['Selected primary employee is not an enabled primary agent in this workspace.']);
  }
  let reviewerId: string | null = null;
  if (d.reviewEnabled) {
    if (!d.assignedReviewerAgentId) {
      throw new ValidationError(['A cross-check requires an assigned reviewer employee.']);
    }
    const reviewer = await getAssignableAgentById(tx, ctx, d.assignedReviewerAgentId, 'reviewer');
    if (!reviewer) {
      throw new ValidationError(['Selected reviewer employee is not an enabled reviewer agent in this workspace.']);
    }
    if (reviewer.id === primary.id) {
      throw new ValidationError(['The reviewer must be a different employee than the primary.']);
    }
    reviewerId = reviewer.id;
  }
  return { assignedPrimaryAgentId: primary.id, assignedReviewerAgentId: reviewerId };
}

export async function createSchedule(
  tx: DbTx,
  ctx: TenantContext,
  input: z.input<typeof createScheduleSchema>,
): Promise<string> {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only project admins can create standing work.');
  }
  const parsed = createScheduleSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message));
  const d = parsed.data;
  const assignment = await validateScheduleAssignment(tx, ctx, d);

  const inserted = await tx
    .insert(taskSchedules)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      objectiveId: d.objectiveId,
      title: d.title,
      input: d.input,
      providerSelection: d.providerSelection,
      reviewEnabled: d.reviewEnabled,
      assignedPrimaryAgentId: assignment.assignedPrimaryAgentId,
      assignedReviewerAgentId: assignment.assignedReviewerAgentId,
      modelTier: d.modelTier,
      flagshipCategory: d.flagshipCategory,
      cadence: d.cadence,
      atHour: d.atHour,
      weekday: d.weekday,
      monthday: d.monthday,
      nextRunAt: computeNextRunAt(d, new Date()),
      createdBy: ctx.userId,
    })
    .returning({ id: taskSchedules.id });
  const scheduleId = inserted[0]!.id;

  await writeAudit(tx, ctx, {
    action: 'standing_work.created',
    entityType: 'task_schedule',
    entityId: scheduleId,
    detail: { title: d.title, cadence: d.cadence, atHour: d.atHour },
  });
  return scheduleId;
}

export async function setScheduleEnabled(
  tx: DbTx,
  ctx: TenantContext,
  scheduleId: string,
  enabled: boolean,
): Promise<void> {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only project admins can change standing work.');
  }
  const updated = await tx
    .update(taskSchedules)
    .set({ enabled, updatedAt: new Date() })
    .where(
      and(
        eq(taskSchedules.id, scheduleId),
        eq(taskSchedules.projectId, ctx.projectId),
        eq(taskSchedules.orgId, ctx.orgId),
      ),
    )
    .returning({ id: taskSchedules.id, title: taskSchedules.title });
  if (updated.length === 0) throw new NotFoundError('Standing work');

  await writeAudit(tx, ctx, {
    action: enabled ? 'standing_work.enabled' : 'standing_work.paused',
    entityType: 'task_schedule',
    entityId: scheduleId,
    detail: { title: updated[0]!.title },
  });
}

/**
 * Editing standing work (LIFECYCLE-AUDIT). Previously pause/resume were the
 * only controls, so changing a cadence or fixing a brief meant creating a
 * second schedule and pausing the first — the accumulation of half-dead
 * objects that makes a system feel unmanaged.
 *
 * Changing the cadence recomputes `nextRunAt` from now, so a schedule cannot
 * be edited into firing immediately (or into the past). Editing does not
 * resume a paused schedule: resuming stays a separate, deliberate act.
 */
export const editScheduleSchema = createScheduleSchema;

export async function updateSchedule(
  tx: DbTx,
  ctx: TenantContext,
  scheduleId: string,
  input: z.input<typeof editScheduleSchema>,
): Promise<void> {
  if (ctx.projectRole !== 'admin') {
    throw new AppError('forbidden', 'Only project admins can change standing work.');
  }
  const parsed = editScheduleSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message));
  }
  const d = parsed.data;
  const assignment = await validateScheduleAssignment(tx, ctx, d);

  const existing = await tx
    .select({
      title: taskSchedules.title,
      cadence: taskSchedules.cadence,
      atHour: taskSchedules.atHour,
      weekday: taskSchedules.weekday,
      monthday: taskSchedules.monthday,
    })
    .from(taskSchedules)
    .where(
      and(
        eq(taskSchedules.id, scheduleId),
        eq(taskSchedules.projectId, ctx.projectId),
        eq(taskSchedules.orgId, ctx.orgId),
      ),
    )
    .limit(1);
  const before = existing[0];
  if (!before) throw new NotFoundError('Standing work');

  const timingChanged =
    before.cadence !== d.cadence ||
    before.atHour !== d.atHour ||
    before.weekday !== d.weekday ||
    before.monthday !== d.monthday;

  await tx
    .update(taskSchedules)
    .set({
      title: d.title,
      input: d.input,
      objectiveId: d.objectiveId,
      providerSelection: d.providerSelection,
      reviewEnabled: d.reviewEnabled,
      assignedPrimaryAgentId: assignment.assignedPrimaryAgentId,
      assignedReviewerAgentId: assignment.assignedReviewerAgentId,
      modelTier: d.modelTier,
      flagshipCategory: d.flagshipCategory,
      cadence: d.cadence,
      atHour: d.atHour,
      weekday: d.weekday,
      monthday: d.monthday,
      // Only recompute when timing actually moved: rewriting a brief should
      // not silently postpone tomorrow's run.
      ...(timingChanged ? { nextRunAt: computeNextRunAt(d, new Date()) } : {}),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(taskSchedules.id, scheduleId),
        eq(taskSchedules.projectId, ctx.projectId),
        eq(taskSchedules.orgId, ctx.orgId),
      ),
    );

  await writeAudit(tx, ctx, {
    action: 'standing_work.updated',
    entityType: 'task_schedule',
    entityId: scheduleId,
    detail: {
      title: { from: before.title, to: d.title },
      cadence: { from: before.cadence, to: d.cadence },
      rescheduled: timingChanged,
    },
  });
}

export interface TickResult {
  due: number;
  /** Schedules that dispatched a task + run this tick. */
  started: number;
  /** Due schedules left UNTOUCHED because their pinned assignment was missing or invalid: no task, no run,
   *  no clock advance, only an append-only `schedule.assignment_required` audit. They stay due next tick. */
  assignmentRequired: number;
  failures: Array<{ scheduleId: string; reason: string }>;
}

/**
 * Executes every due schedule. Called by the external tick (scripts/
 * run-standing-work.ts, registered hourly). The author's identity drives the
 * run; if their project membership was revoked since, the schedule is
 * skipped and paused — standing work never outlives its author's authority.
 */
export async function runDueSchedules(now = new Date()): Promise<TickResult> {
  // Cross-tenant discovery via the SECURITY DEFINER dispatcher (O-22). Under the
  // non-superuser app_server role there is no direct cross-tenant read of
  // task_schedules; the dispatcher returns only the identity tuple + the
  // author's project role. Every subsequent read/write runs under withTenant().
  // Bind the cutoff as an explicit ISO string cast to timestamptz. Passing a raw JS Date as a
  // function argument trips a postgres-js parameter-binding path; an ISO string + ::timestamptz cast is
  // unambiguous and identical in meaning.
  const listed = await getDb().execute(
    sql`select * from app.list_due_schedules(${now.toISOString()}::timestamptz)`,
  );
  const dueRows = ((listed as { rows?: unknown[] }).rows ??
    (Array.isArray(listed) ? listed : [])) as Array<{
    schedule_id: string;
    org_id: string;
    project_id: string;
    created_by: string;
    project_role: string | null;
  }>;

  const result: TickResult = { due: dueRows.length, started: 0, assignmentRequired: 0, failures: [] };

  for (const row of dueRows) {
    const ctx: TenantContext = {
      userId: row.created_by,
      orgId: row.org_id,
      projectId: row.project_id,
      orgRole: 'member',
      projectRole: (row.project_role as TenantContext['projectRole']) ?? 'viewer',
    };

    // Authority check: the author must still be a project admin (role resolved
    // across tenants by the dispatcher). Standing work never outlives it.
    if (ctx.projectRole !== 'admin') {
      await withTenant(ctx, async (tx) => {
        await tx
          .update(taskSchedules)
          .set({ enabled: false, updatedAt: new Date() })
          .where(eq(taskSchedules.id, row.schedule_id));
        await writeAudit(tx, ctx, {
          action: 'standing_work.paused',
          entityType: 'task_schedule',
          entityId: row.schedule_id,
          detail: { reason: 'author no longer a project admin' },
        });
      });
      result.failures.push({ scheduleId: row.schedule_id, reason: 'author lost admin role; paused' });
      continue;
    }

    // Read the full schedule row under RLS (ctx matches, so it is visible).
    const schedule = await withTenant(ctx, async (tx) =>
      (
        await tx
          .select({
            id: taskSchedules.id,
            orgId: taskSchedules.orgId,
            projectId: taskSchedules.projectId,
            objectiveId: taskSchedules.objectiveId,
            title: taskSchedules.title,
            input: taskSchedules.input,
            providerSelection: taskSchedules.providerSelection,
            reviewEnabled: taskSchedules.reviewEnabled,
            assignedPrimaryAgentId: taskSchedules.assignedPrimaryAgentId,
            assignedReviewerAgentId: taskSchedules.assignedReviewerAgentId,
            modelTier: taskSchedules.modelTier,
            flagshipCategory: taskSchedules.flagshipCategory,
            cadence: taskSchedules.cadence,
            atHour: taskSchedules.atHour,
            weekday: taskSchedules.weekday,
            monthday: taskSchedules.monthday,
            createdBy: taskSchedules.createdBy,
          })
          .from(taskSchedules)
          .where(eq(taskSchedules.id, row.schedule_id))
          .limit(1)
      )[0],
    );
    if (!schedule) continue; // vanished between listing and processing

    // P1a agent pinning — VALIDATE the pinned assignment BEFORE any clock advance or dispatch. A due schedule
    // whose assignment is missing OR invalid (no pinned primary; a primary/reviewer that is disabled, deleted,
    // cross-workspace, or wrong-role per getAssignableAgentById; a review-enabled schedule with no reviewer; or
    // reviewer == primary) must dispatch NO task and NO run, and leave nextRunAt / lastRunAt / cadence / enabled
    // and EVERY other column byte-for-byte UNCHANGED — no UPDATE to the row at all. The only side effect is the
    // append-only schedule.assignment_required audit. Because the clock never advances, the occurrence is
    // neither consumed nor skipped: the schedule simply stays due each tick until an admin corrects it. Never
    // provider-substitute; never disable/reschedule/rewrite the schedule. (A schedule authored/edited after P1a
    // always carries a valid pinned assignment; this path is for legacy/decayed rows only.)
    const validated = await withTenant(
      ctx,
      async (tx): Promise<{ primaryId: string } | { reason: string }> => {
        if (schedule.assignedPrimaryAgentId == null) return { reason: 'no_assigned_primary' };
        const primary = await getAssignableAgentById(tx, ctx, schedule.assignedPrimaryAgentId, 'primary');
        if (!primary) return { reason: 'primary_not_assignable' };
        if (schedule.reviewEnabled) {
          if (schedule.assignedReviewerAgentId == null) return { reason: 'review_enabled_without_reviewer' };
          const reviewer = await getAssignableAgentById(tx, ctx, schedule.assignedReviewerAgentId, 'reviewer');
          if (!reviewer) return { reason: 'reviewer_not_assignable' };
          if (reviewer.id === primary.id) return { reason: 'reviewer_equals_primary' };
        }
        return { primaryId: primary.id };
      },
    );
    if ('reason' in validated) {
      // Append-only audit ONLY — no UPDATE to the schedule row. Detail carries identity ids + a machine
      // reason, never the schedule brief or any secret.
      await withTenant(ctx, (tx) =>
        writeAudit(tx, ctx, {
          action: 'schedule.assignment_required',
          entityType: 'task_schedule',
          entityId: schedule.id,
          detail: { scheduleId: schedule.id, reason: validated.reason },
        }),
      );
      result.assignmentRequired += 1;
      result.failures.push({
        scheduleId: schedule.id,
        reason: `assignment required (${validated.reason}); left due, not dispatched`,
      });
      continue;
    }
    // Validated: the pinned primary (and reviewer, when review is enabled) are enabled agents of the right
    // role in this workspace. getAssignableAgentById loaded by the exact pinned id, so this equals the pin.
    const assignedPrimaryAgentId = validated.primaryId;

    // Advance the clock FIRST: a crash below runs once next window, never N.
    const nextRunAt = computeNextRunAt(schedule, now);
    await withTenant(ctx, (tx) =>
      tx
        .update(taskSchedules)
        .set({ nextRunAt, lastRunAt: now, updatedAt: new Date() })
        .where(eq(taskSchedules.id, schedule.id)),
    );

    try {
      const taskId = await withTenant(ctx, (tx) =>
        createTask(tx, ctx, {
          title: `${schedule.title} — ${now.toISOString().slice(0, 10)}`,
          input: schedule.input,
          providerSelection: schedule.providerSelection,
          reviewEnabled: schedule.reviewEnabled,
          modelTier: schedule.modelTier,
          flagshipCategory: schedule.flagshipCategory,
          objectiveId: schedule.objectiveId,
          scheduleId: schedule.id,
          // The tick pins the produced task to the schedule's exact employees.
          primaryAgentId: assignedPrimaryAgentId,
          reviewerAgentId: schedule.assignedReviewerAgentId,
        }),
      );
      const outcome = await startRun(ctx, taskId);
      result.started += 1;
      if (outcome.status === 'failed') {
        result.failures.push({
          scheduleId: schedule.id,
          reason: outcome.failureReason ?? 'run failed',
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown failure';
      result.failures.push({ scheduleId: schedule.id, reason });
      log.warn('standing work tick failed for schedule', { scheduleId: schedule.id, reason });
    }
  }

  return result;
}
