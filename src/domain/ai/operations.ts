import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { aiOperations } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Durable AI-operation records for AI work that is not a task run (objective suggestion today). An
 * application of Knowledge is inspectable only when it belongs to one of these — so we record the
 * operation BEFORE provider dispatch, reference it from `knowledge_injections`, and advance its
 * status to completed/failed. With an `idempotencyKey`, the same logical retry reuses the same
 * operation; without one, each call is a distinct operation.
 */

export interface BeginAiOperationArgs {
  operationType: string;
  subjectType?: string | null;
  subjectId?: string | null;
  idempotencyKey?: string | null;
  provider?: string | null;
  model?: string | null;
  contextHash?: string | null;
}

/** Begin (or reuse, when an idempotency key matches) a durable operation; returns its id. */
export async function beginAiOperation(tx: DbTx, ctx: TenantContext, args: BeginAiOperationArgs): Promise<string> {
  if (args.idempotencyKey) {
    const existing = await tx
      .select({ id: aiOperations.id })
      .from(aiOperations)
      .where(
        and(
          eq(aiOperations.projectId, ctx.projectId),
          eq(aiOperations.orgId, ctx.orgId),
          eq(aiOperations.operationType, args.operationType),
          eq(aiOperations.idempotencyKey, args.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0].id; // same logical retry → same operation identity
  }

  const now = new Date();
  const inserted = await tx
    .insert(aiOperations)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      operationType: args.operationType,
      subjectType: args.subjectType ?? null,
      subjectId: args.subjectId ?? null,
      idempotencyKey: args.idempotencyKey ?? null,
      status: 'dispatched',
      provider: args.provider ?? null,
      model: args.model ?? null,
      contextHash: args.contextHash ?? null,
      dispatchedAt: now,
      createdBy: ctx.userId,
    })
    .returning({ id: aiOperations.id });
  const id = inserted[0]!.id;
  await writeAudit(tx, ctx, { action: 'ai_operation.dispatched', entityType: 'ai_operation', entityId: id, detail: { operationType: args.operationType } });
  return id;
}

export async function completeAiOperation(tx: DbTx, ctx: TenantContext, id: string, resultRef?: string | null): Promise<void> {
  await tx
    .update(aiOperations)
    .set({ status: 'completed', completedAt: new Date(), resultRef: resultRef ?? null, updatedAt: new Date() })
    .where(and(eq(aiOperations.id, id), eq(aiOperations.orgId, ctx.orgId), eq(aiOperations.projectId, ctx.projectId)));
}

export async function failAiOperation(tx: DbTx, ctx: TenantContext, id: string, error: string): Promise<void> {
  await tx
    .update(aiOperations)
    .set({ status: 'failed', failedAt: new Date(), error: error.slice(0, 2_000), updatedAt: new Date() })
    .where(and(eq(aiOperations.id, id), eq(aiOperations.orgId, ctx.orgId), eq(aiOperations.projectId, ctx.projectId)));
}

export interface AiOperationRow {
  id: string;
  operationType: string;
  status: string;
  provider: string | null;
  contextHash: string | null;
  dispatchedAt: Date | null;
  completedAt: Date | null;
  failedAt: Date | null;
  createdAt: Date;
}

/** Read one operation (for the reverse trail / future Knowledge Detail). */
export async function getAiOperation(tx: DbTx, ctx: TenantContext, id: string): Promise<AiOperationRow | null> {
  const rows = await tx
    .select({
      id: aiOperations.id,
      operationType: aiOperations.operationType,
      status: aiOperations.status,
      provider: aiOperations.provider,
      contextHash: aiOperations.contextHash,
      dispatchedAt: aiOperations.dispatchedAt,
      completedAt: aiOperations.completedAt,
      failedAt: aiOperations.failedAt,
      createdAt: aiOperations.createdAt,
    })
    .from(aiOperations)
    .where(and(eq(aiOperations.id, id), eq(aiOperations.orgId, ctx.orgId), eq(aiOperations.projectId, ctx.projectId)))
    .limit(1);
  return rows[0] ?? null;
}
