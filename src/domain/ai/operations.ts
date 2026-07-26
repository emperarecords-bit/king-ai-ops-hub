import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { ConflictError } from '@/lib/errors';
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

export async function completeAiOperation(tx: DbTx, ctx: TenantContext, id: string, resultData?: unknown): Promise<void> {
  await tx
    .update(aiOperations)
    .set({ status: 'completed', completedAt: new Date(), resultData: resultData ?? null, updatedAt: new Date() })
    .where(and(eq(aiOperations.id, id), eq(aiOperations.orgId, ctx.orgId), eq(aiOperations.projectId, ctx.projectId)));
}

export type OperationDecision = 'dispatch' | 'return_result' | 'in_progress';

/**
 * Resolve the operation for a request that carries an idempotency key — the real enforcement of
 * "the same logical retry uses the same operation identity". The key is bound to a request
 * FINGERPRINT (`contextHash`): a client cannot reuse a key for materially different input and receive
 * the earlier result — a mismatch is an idempotency conflict.
 *  - no existing op → create one and DISPATCH (isRetry=false).
 *  - existing, fingerprint MISMATCH → throw ConflictError (the key aliases a different request).
 *  - existing completed → RETURN_RESULT (its stored resultData); never re-dispatch.
 *  - existing still running (dispatched) → IN_PROGRESS; do not dispatch a second provider request.
 *  - existing failed → retry under the SAME operation (status back to dispatched, attempt++) →
 *    DISPATCH with isRetry=true, so the caller repeats the FROZEN context rather than rebuilding it.
 * With no key, always a fresh operation to DISPATCH (a genuinely new request).
 */
export async function beginOrReuseAiOperation(
  tx: DbTx,
  ctx: TenantContext,
  args: BeginAiOperationArgs,
): Promise<{ id: string; decision: OperationDecision; resultData: unknown; isRetry: boolean }> {
  if (!args.idempotencyKey) {
    return { id: await beginAiOperation(tx, ctx, args), decision: 'dispatch', resultData: null, isRetry: false };
  }
  const existing = await tx
    .select({ id: aiOperations.id, status: aiOperations.status, resultData: aiOperations.resultData, attempt: aiOperations.attempt, contextHash: aiOperations.contextHash })
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
  const op = existing[0];
  if (!op) return { id: await beginAiOperation(tx, ctx, args), decision: 'dispatch', resultData: null, isRetry: false };

  // The key must identify ONE immutable logical request. A different fingerprint under the same key
  // is a conflict, never a silent alias to the earlier result.
  if (args.contextHash != null && op.contextHash != null && op.contextHash !== args.contextHash) {
    throw new ConflictError('This request key was already used for a different request. Start a new request.');
  }

  if (op.status === 'completed') return { id: op.id, decision: 'return_result', resultData: op.resultData, isRetry: false };
  if (op.status === 'dispatched') return { id: op.id, decision: 'in_progress', resultData: null, isRetry: false };
  // failed → retry under the same logical operation with the same input; caller repeats frozen context.
  await tx
    .update(aiOperations)
    .set({ status: 'dispatched', dispatchedAt: new Date(), failedAt: null, error: null, attempt: op.attempt + 1, updatedAt: new Date() })
    .where(and(eq(aiOperations.id, op.id), eq(aiOperations.orgId, ctx.orgId), eq(aiOperations.projectId, ctx.projectId)));
  return { id: op.id, decision: 'dispatch', resultData: null, isRetry: true };
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
