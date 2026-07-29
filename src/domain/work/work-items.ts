import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type TenantContext, type WorkItemCondition, type DataClassification, WORK_ITEM_CONDITIONS } from '@/types/domain';
import { ConflictError, ValidationError, NotFoundError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { agents, objectives, profiles, workItems } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Work items: human-owned, editable tracking items (Org Slice 1 follow-up).
 * The counterpart to tasks (write-once AI executions) — this is human work a
 * person owns and advances by hand through their own stages. No provider call,
 * no cost, no automation. Ownership assignment lives in org.ts::setOwner
 * (object 'work_item'); this module handles create / list / edit.
 */

export interface WorkItemRow {
  id: string;
  title: string;
  /** null = never established → "Unknown" in the shared execution model. */
  condition: WorkItemCondition | null;
  waitingOn: string | null;
  stage: string;
  notes: string;
  ownerAgentId: string | null;
  ownerName: string | null;
  objectiveId: string | null;
  objectiveTitle: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkItemDetail {
  id: string;
  title: string;
  classification: DataClassification;
  condition: WorkItemCondition | null;
  waitingOn: string | null;
  stage: string;
  notes: string;
  ownerAgentId: string | null;
  ownerName: string | null;
  objectiveId: string | null;
  objectiveTitle: string | null;
  closureReason: string | null;
  closedByName: string | null;
  closedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

export async function getWorkItem(
  tx: DbTx,
  ctx: TenantContext,
  workItemId: string,
): Promise<WorkItemDetail> {
  const rows = await tx
    .select({
      id: workItems.id,
      title: workItems.title,
      classification: workItems.classification,
      condition: workItems.condition,
      waitingOn: workItems.waitingOn,
      stage: workItems.stage,
      notes: workItems.notes,
      ownerAgentId: workItems.ownerAgentId,
      ownerName: agents.name,
      objectiveId: workItems.objectiveId,
      objectiveTitle: objectives.title,
      closureReason: workItems.closureReason,
      closedByName: profiles.displayName,
      closedAt: workItems.closedAt,
      updatedAt: workItems.updatedAt,
      createdAt: workItems.createdAt,
    })
    .from(workItems)
    .leftJoin(agents, eq(workItems.ownerAgentId, agents.id))
    .leftJoin(objectives, eq(workItems.objectiveId, objectives.id))
    .leftJoin(profiles, eq(workItems.closedBy, profiles.id))
    .where(and(eq(workItems.id, workItemId), eq(workItems.orgId, ctx.orgId), eq(workItems.projectId, ctx.projectId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFoundError('Work item');
  return row;
}

export async function listWorkItems(
  tx: DbTx,
  ctx: TenantContext,
  objectiveId?: string,
): Promise<WorkItemRow[]> {
  const where = objectiveId
    ? and(
        eq(workItems.projectId, ctx.projectId),
        eq(workItems.orgId, ctx.orgId),
        eq(workItems.objectiveId, objectiveId),
      )
    : and(eq(workItems.projectId, ctx.projectId), eq(workItems.orgId, ctx.orgId));

  const rows = await tx
    .select({
      id: workItems.id,
      title: workItems.title,
      condition: workItems.condition,
      waitingOn: workItems.waitingOn,
      stage: workItems.stage,
      notes: workItems.notes,
      ownerAgentId: workItems.ownerAgentId,
      ownerName: agents.name,
      objectiveId: workItems.objectiveId,
      objectiveTitle: objectives.title,
      createdAt: workItems.createdAt,
      updatedAt: workItems.updatedAt,
    })
    .from(workItems)
    .leftJoin(agents, eq(workItems.ownerAgentId, agents.id))
    .leftJoin(objectives, eq(workItems.objectiveId, objectives.id))
    .where(where)
    .orderBy(desc(workItems.createdAt));
  return rows;
}

export const createWorkItemSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  condition: z.enum(WORK_ITEM_CONDITIONS).default('planned'),
  waitingOn: z.string().trim().max(200).default(''),
  stage: z.string().trim().max(60).default('New'),
  notes: z.string().max(8_000).default(''),
  objectiveId: z.string().uuid().nullable().default(null),
});
export type CreateWorkItemInput = z.input<typeof createWorkItemSchema>;

export async function createWorkItem(
  tx: DbTx,
  ctx: TenantContext,
  input: CreateWorkItemInput,
): Promise<string> {
  const parsed = createWorkItemSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message));
  }

  // A supplied objective must belong to this workspace (D-008 tenancy hygiene).
  if (parsed.data.objectiveId) {
    const obj = await tx
      .select({ id: objectives.id })
      .from(objectives)
      .where(
        and(
          eq(objectives.id, parsed.data.objectiveId),
          eq(objectives.projectId, ctx.projectId),
          eq(objectives.orgId, ctx.orgId),
        ),
      )
      .limit(1);
    if (obj.length === 0) throw new ValidationError(['That objective is not in this workspace.']);
  }

  const inserted = await tx
    .insert(workItems)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      title: parsed.data.title,
      condition: parsed.data.condition,
      waitingOn: parsed.data.condition === 'waiting' ? parsed.data.waitingOn || null : null,
      stage: parsed.data.stage || 'New',
      notes: parsed.data.notes,
      objectiveId: parsed.data.objectiveId,
      createdBy: ctx.userId,
    })
    .returning({ id: workItems.id });

  const id = inserted[0]!.id;
  await writeAudit(tx, ctx, {
    action: 'work_item.created',
    entityType: 'work_item',
    entityId: id,
    detail: { title: parsed.data.title, objectiveId: parsed.data.objectiveId },
  });
  return id;
}

// Ordinary edits can only set a *live* condition — finishing/stopping goes through the closure
// actions so it captures who/when/why and freezes the record.
const LIVE_CONDITIONS = ['planned', 'moving', 'waiting'] as const;

export const updateWorkItemSchema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  condition: z.enum(LIVE_CONDITIONS),
  waitingOn: z.string().trim().max(200).default(''),
  stage: z.string().trim().max(60),
  notes: z.string().max(8_000),
});
export type UpdateWorkItemInput = z.infer<typeof updateWorkItemSchema>;

async function currentCondition(
  tx: DbTx,
  ctx: TenantContext,
  workItemId: string,
): Promise<WorkItemCondition | null> {
  const rows = await tx
    .select({ condition: workItems.condition })
    .from(workItems)
    .where(and(eq(workItems.id, workItemId), eq(workItems.orgId, ctx.orgId), eq(workItems.projectId, ctx.projectId)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError('Work item');
  return rows[0]!.condition;
}

function assertNotClosed(condition: WorkItemCondition | null): void {
  if (condition === 'finished' || condition === 'stopped') {
    throw new ConflictError('This work item is closed. Its record is frozen and cannot be edited.');
  }
}

export async function updateWorkItem(
  tx: DbTx,
  ctx: TenantContext,
  workItemId: string,
  input: UpdateWorkItemInput,
): Promise<void> {
  const parsed = updateWorkItemSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(parsed.error.issues.map((i) => i.message));
  }
  assertNotClosed(await currentCondition(tx, ctx, workItemId));

  const updated = await tx
    .update(workItems)
    .set({
      title: parsed.data.title,
      condition: parsed.data.condition,
      waitingOn: parsed.data.condition === 'waiting' ? parsed.data.waitingOn || null : null,
      stage: parsed.data.stage || 'New',
      notes: parsed.data.notes,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(workItems.id, workItemId),
        eq(workItems.orgId, ctx.orgId),
        eq(workItems.projectId, ctx.projectId),
      ),
    )
    .returning({ id: workItems.id });
  if (updated.length === 0) throw new NotFoundError('Work item');

  await writeAudit(tx, ctx, {
    action: 'work_item.updated',
    entityType: 'work_item',
    entityId: workItemId,
    detail: { stage: parsed.data.stage },
  });
}

/**
 * Stop a work item — a terminal transition that requires a reason and freezes the record. The
 * item's condition/stage/owner at this moment become the closure snapshot (it can't be edited
 * afterward). Institutional memory, like an objective's closure.
 */
export async function stopWorkItem(
  tx: DbTx,
  ctx: TenantContext,
  workItemId: string,
  reason: string,
): Promise<void> {
  const r = (reason ?? '').trim();
  if (!r) {
    throw new ValidationError([
      'A reason is required to stop work — why it ended is the record that makes it useful later.',
    ]);
  }
  assertNotClosed(await currentCondition(tx, ctx, workItemId));
  await tx
    .update(workItems)
    .set({ condition: 'stopped', waitingOn: null, closedBy: ctx.userId, closedAt: new Date(), closureReason: r, updatedAt: new Date() })
    .where(and(eq(workItems.id, workItemId), eq(workItems.orgId, ctx.orgId), eq(workItems.projectId, ctx.projectId)));

  await writeAudit(tx, ctx, { action: 'work_item.stopped', entityType: 'work_item', entityId: workItemId, detail: { reason: r } });
}

/** Finish a work item — terminal, freezes the record. A completion note is optional. */
export async function finishWorkItem(
  tx: DbTx,
  ctx: TenantContext,
  workItemId: string,
  note?: string,
): Promise<void> {
  assertNotClosed(await currentCondition(tx, ctx, workItemId));
  const n = (note ?? '').trim() || null;
  await tx
    .update(workItems)
    .set({ condition: 'finished', waitingOn: null, closedBy: ctx.userId, closedAt: new Date(), closureReason: n, updatedAt: new Date() })
    .where(and(eq(workItems.id, workItemId), eq(workItems.orgId, ctx.orgId), eq(workItems.projectId, ctx.projectId)));

  await writeAudit(tx, ctx, { action: 'work_item.finished', entityType: 'work_item', entityId: workItemId, detail: { note: n } });
}
