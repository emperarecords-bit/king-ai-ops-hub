import { desc, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { AUDIT_CHAIN_GENESIS, auditRowHash } from '@/lib/crypto';
import { type DbTx } from '@/db/client';
import { auditLogs } from '@/db/schema';

/**
 * The append-only, hash-chained audit trail (invariant I6). `writeAudit` MUST
 * be called inside the same transaction as the change it describes — that is
 * why it takes a DbTx, not a TenantContext: it composes with withTenant()
 * rather than opening its own transaction.
 */

export interface AuditEventInput {
  readonly action: string; // dotted verb: task.created, run.completed, …
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly detail?: Record<string, unknown>;
}

/** The nil user id used by background/system operations (O-23 document
 *  indexing). It is not a real profile, so audit records it as a NULL actor. */
const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000000';

export async function writeAudit(
  tx: DbTx,
  ctx: Pick<TenantContext, 'orgId' | 'projectId' | 'userId'>,
  event: AuditEventInput,
): Promise<void> {
  // Chain head for this org. The org-scoped chain means cross-project events
  // (org settings changes) still chain; project attribution lives in its column.
  const prev = await tx
    .select({ rowHash: auditLogs.rowHash })
    .from(auditLogs)
    .where(eq(auditLogs.orgId, ctx.orgId))
    .orderBy(desc(auditLogs.seq))
    .limit(1);

  const prevHash = prev[0]?.rowHash ?? AUDIT_CHAIN_GENESIS;
  const createdAt = new Date();
  const detail = event.detail ?? {};
  const detailJson = JSON.stringify(detail);

  // System actions (background indexing, O-23) carry the nil user id, which is
  // not a real profile — record them with a NULL actor rather than a dangling FK.
  const actorId = ctx.userId === SYSTEM_ACTOR_ID ? null : ctx.userId;

  const rowHash = auditRowHash({
    prevHash,
    orgId: ctx.orgId,
    actorId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    detailJson,
    createdAtIso: createdAt.toISOString(),
  });

  await tx.insert(auditLogs).values({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    actorId,
    action: event.action,
    entityType: event.entityType,
    entityId: event.entityId ?? null,
    detail,
    prevHash,
    rowHash,
    createdAt,
  });
}

export interface AuditListRow {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: unknown;
  actorId: string | null;
  createdAt: Date;
  rowHash: string;
}

export async function listAuditEvents(tx: DbTx, projectId: string, limit = 100): Promise<AuditListRow[]> {
  const rows = await tx
    .select({
      id: auditLogs.id,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      detail: auditLogs.detail,
      actorId: auditLogs.actorId,
      createdAt: auditLogs.createdAt,
      rowHash: auditLogs.rowHash,
    })
    .from(auditLogs)
    .where(eq(auditLogs.projectId, projectId))
    .orderBy(desc(auditLogs.seq))
    .limit(limit);
  return rows;
}
