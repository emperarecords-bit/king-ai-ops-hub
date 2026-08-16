import { and, desc, eq, inArray } from 'drizzle-orm';
import { auditLogs } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { type TenantContext } from '@/types/domain';

/**
 * The durable execution record for an approval, derived from the append-only audit log
 * (action `execution.result`) — the same rows the dispatch choke point writes. No separate
 * mutable "execution status" column exists to drift out of sync with the evidence.
 */
export interface ApprovalExecutionRecord {
  readonly outcome: string;
  readonly executorId: string | null;
  readonly prNumber: number | null;
  readonly prUrl: string | null;
  readonly executedAt: Date;
}

/** Latest execution.result per approval id (a retry after `failed` produces a newer row). */
export async function executionRecordsForApprovals(
  tx: DbTx,
  ctx: TenantContext,
  approvalIds: readonly string[],
): Promise<Map<string, ApprovalExecutionRecord>> {
  if (approvalIds.length === 0) return new Map();
  const rows = await tx
    .select({ entityId: auditLogs.entityId, detail: auditLogs.detail, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.orgId, ctx.orgId),
        eq(auditLogs.projectId, ctx.projectId),
        eq(auditLogs.action, 'execution.result'),
        inArray(auditLogs.entityId, [...approvalIds]),
      ),
    )
    .orderBy(desc(auditLogs.createdAt));

  const out = new Map<string, ApprovalExecutionRecord>();
  for (const row of rows) {
    if (!row.entityId || out.has(row.entityId)) continue; // newest-first: first row per approval wins
    const detail = (row.detail ?? {}) as Record<string, unknown>;
    const preview = (detail.resultPreview ?? {}) as Record<string, unknown>;
    out.set(row.entityId, {
      outcome: typeof detail.outcome === 'string' ? detail.outcome : 'unknown',
      executorId: typeof detail.executorId === 'string' ? detail.executorId : null,
      prNumber: typeof preview.prNumber === 'number' ? preview.prNumber : null,
      prUrl: typeof preview.prUrl === 'string' ? preview.prUrl : null,
      executedAt: row.createdAt,
    });
  }
  return out;
}
