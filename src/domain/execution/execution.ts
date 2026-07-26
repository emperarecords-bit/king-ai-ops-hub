import { and, desc, eq, inArray } from 'drizzle-orm';
import { type Cadence, type TaskStatus, type TenantContext, type WorkItemCondition } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { agents, objectives, profiles, taskSchedules, tasks, workItems } from '@/db/schema';

/**
 * The unified execution feed (Execution). One stream across both engines — human Work Items and
 * AI Tasks — normalized to a common row so the shared translator (assess.ts) can read them the
 * same way. Work type stays as `kind` (secondary context); the operational meaning leads.
 */

export interface ExecutionRow {
  kind: 'work_item' | 'ai_task';
  id: string;
  title: string;
  ownerAgentId: string | null;
  ownerName: string | null;
  objectiveId: string | null;
  objectiveTitle: string | null;
  updatedAt: Date;
  /** work_item only (null → Unknown in the translator). */
  condition: WorkItemCondition | null;
  waitingOn: string | null;
  stage: string | null;
  notes: string | null;
  /** ai_task only. */
  status: TaskStatus | null;
  /** Closure record for terminal work (Finished/Stopped). */
  closureReason: string | null;
  closedByName: string | null;
  closedAt: Date | null;
}

export async function listExecution(tx: DbTx, ctx: TenantContext): Promise<ExecutionRow[]> {
  const wi = await tx
    .select({
      id: workItems.id,
      title: workItems.title,
      ownerAgentId: workItems.ownerAgentId,
      ownerName: agents.name,
      objectiveId: workItems.objectiveId,
      objectiveTitle: objectives.title,
      updatedAt: workItems.updatedAt,
      condition: workItems.condition,
      waitingOn: workItems.waitingOn,
      stage: workItems.stage,
      notes: workItems.notes,
      closureReason: workItems.closureReason,
      closedByName: profiles.displayName,
      closedAt: workItems.closedAt,
    })
    .from(workItems)
    .leftJoin(agents, eq(workItems.ownerAgentId, agents.id))
    .leftJoin(objectives, eq(workItems.objectiveId, objectives.id))
    .leftJoin(profiles, eq(workItems.closedBy, profiles.id))
    .where(and(eq(workItems.projectId, ctx.projectId), eq(workItems.orgId, ctx.orgId)))
    .orderBy(desc(workItems.updatedAt));

  const ts = await tx
    .select({
      id: tasks.id,
      title: tasks.title,
      ownerAgentId: tasks.ownerAgentId,
      ownerName: agents.name,
      objectiveId: tasks.objectiveId,
      objectiveTitle: objectives.title,
      updatedAt: tasks.updatedAt,
      status: tasks.status,
      cancelReason: tasks.cancelReason,
    })
    .from(tasks)
    .leftJoin(agents, eq(tasks.ownerAgentId, agents.id))
    .leftJoin(objectives, eq(tasks.objectiveId, objectives.id))
    .where(and(eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)))
    .orderBy(desc(tasks.updatedAt));

  const workItemRows: ExecutionRow[] = wi.map((r) => ({
    kind: 'work_item',
    id: r.id,
    title: r.title,
    ownerAgentId: r.ownerAgentId,
    ownerName: r.ownerName,
    objectiveId: r.objectiveId,
    objectiveTitle: r.objectiveTitle,
    updatedAt: r.updatedAt,
    condition: r.condition,
    waitingOn: r.waitingOn,
    stage: r.stage,
    notes: r.notes,
    status: null,
    closureReason: r.closureReason,
    closedByName: r.closedByName,
    closedAt: r.closedAt,
  }));
  const taskRows: ExecutionRow[] = ts.map((r) => ({
    kind: 'ai_task',
    id: r.id,
    title: r.title,
    ownerAgentId: r.ownerAgentId,
    ownerName: r.ownerName,
    objectiveId: r.objectiveId,
    objectiveTitle: r.objectiveTitle,
    updatedAt: r.updatedAt,
    condition: null,
    waitingOn: null,
    stage: null,
    notes: null,
    status: r.status,
    closureReason: r.cancelReason,
    closedByName: null,
    closedAt: null,
  }));

  return [...workItemRows, ...taskRows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
}

/**
 * Ongoing automations — recurring schedules, workspace-wide. A schedule is authority to create
 * work, NOT an execution instance, so it lives in its own layer (never in the condition groups).
 * Recent-run health is derived from its identifiable generated tasks (linked via scheduleId),
 * never a generic status. No per-schedule spend is reported in v1 — per-instance cost stays on the
 * tasks, so nothing is double-counted.
 */
export interface AutomationRow {
  id: string;
  title: string;
  enabled: boolean;
  cadence: Cadence;
  nextRunAt: Date;
  objectiveId: string | null;
  objectiveTitle: string | null;
  producedCount: number;
  recentRuns: number;
  recentFailures: number;
}

export async function listAutomations(tx: DbTx, ctx: TenantContext): Promise<AutomationRow[]> {
  const schedules = await tx
    .select({
      id: taskSchedules.id,
      title: taskSchedules.title,
      enabled: taskSchedules.enabled,
      cadence: taskSchedules.cadence,
      nextRunAt: taskSchedules.nextRunAt,
      objectiveId: taskSchedules.objectiveId,
      objectiveTitle: objectives.title,
    })
    .from(taskSchedules)
    .leftJoin(objectives, eq(taskSchedules.objectiveId, objectives.id))
    .where(and(eq(taskSchedules.projectId, ctx.projectId), eq(taskSchedules.orgId, ctx.orgId)))
    .orderBy(desc(taskSchedules.nextRunAt));

  if (schedules.length === 0) return [];
  const ids = schedules.map((s) => s.id);

  // Generated tasks for these schedules, newest first — health is computed from real runs.
  const generated = await tx
    .select({ scheduleId: tasks.scheduleId, status: tasks.status, createdAt: tasks.createdAt })
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.projectId), inArray(tasks.scheduleId, ids)))
    .orderBy(desc(tasks.createdAt));

  const bySchedule = new Map<string, { status: TaskStatus }[]>();
  for (const g of generated) {
    if (!g.scheduleId) continue;
    const arr = bySchedule.get(g.scheduleId) ?? [];
    arr.push({ status: g.status });
    bySchedule.set(g.scheduleId, arr);
  }

  return schedules.map((s) => {
    const runs = bySchedule.get(s.id) ?? [];
    const recent = runs.slice(0, 3); // already newest-first
    return {
      id: s.id,
      title: s.title,
      enabled: s.enabled,
      cadence: s.cadence,
      nextRunAt: s.nextRunAt,
      objectiveId: s.objectiveId,
      objectiveTitle: s.objectiveTitle,
      producedCount: runs.length,
      recentRuns: recent.length,
      recentFailures: recent.filter((r) => r.status === 'failed').length,
    };
  });
}
