import { and, desc, eq, gte, like, lt, lte, sql, type SQL } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { AUDIT_CHAIN_GENESIS, auditRowHash } from '@/lib/crypto';
import { AppError } from '@/lib/errors';
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

// ---------------------------------------------------------------------------
// HUB-006 — server-backed discovery of the FULL append-only history. Read-only:
// nothing here mutates a row or a hash. Keyset paginated on the monotonic `seq`.
// ---------------------------------------------------------------------------

/**
 * Viewing the audit trail requires a real workspace role above viewer. The audit history exposes actors
 * and cross-cutting detail, so a read-only viewer is not authorized. Enforced in the domain (not just the
 * page) so no caller can bypass it. Tenant scope is enforced by the query's org+project filter + RLS.
 */
export function assertCanViewAudit(ctx: TenantContext): void {
  if (ctx.projectRole === 'viewer') {
    throw new AppError('forbidden', 'Your role cannot view the audit history.');
  }
}

/** Keys whose VALUES are never shown, even if a caller stored them in `detail` (req 3). Structure is kept. */
const REDACTED_KEY = /(secret|token|password|passwd|api[-_]?key|authorization|credential|private[-_]?key|access[-_]?key|client[-_]?secret|bearer)/i;
const REDACTED = '[redacted]';

/** Recursively redact sensitive-looking keys so a stored secret is never surfaced by the audit UI. */
export function redactAuditDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactAuditDetail);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACTED_KEY.test(k) ? REDACTED : redactAuditDetail(v);
    }
    return out;
  }
  return value;
}

export interface AuditSearchFilters {
  /** Exact action, e.g. 'approval.decided'. */
  action?: string | null;
  /** Server-side action prefix, e.g. 'approval.' → matches approval.*. Exact prefix, never a client wildcard. */
  actionPrefix?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  /** Case-insensitive SUBSTRING over the detail JSON text and the action. */
  freeText?: string | null;
  /** Inclusive UTC lower bound on created_at. */
  startUtc?: Date | null;
  /** Inclusive UTC upper bound on created_at. */
  endUtc?: Date | null;
}

export interface AuditEventRow {
  id: string;
  seq: bigint;
  action: string;
  entityType: string;
  entityId: string | null;
  detail: unknown; // redacted
  actorId: string | null;
  createdAt: Date;
  rowHash: string;
  prevHash: string;
  projectId: string | null;
}

export interface AuditSearchResult {
  rows: AuditEventRow[];
  /** Opaque keyset cursor (the last row's seq as a string) for the NEXT (older) page; null when exhausted. */
  nextCursor: string | null;
  hasMore: boolean;
  /** Total matching the filters (this workspace), for a result count. */
  totalCount: number;
}

const MAX_AUDIT_PAGE = 100;

function auditFilterConditions(ctx: TenantContext, f: AuditSearchFilters): SQL[] {
  // Tenant scope in the query (defense in depth on top of the org-scoped RLS policy).
  const conds: SQL[] = [eq(auditLogs.orgId, ctx.orgId), eq(auditLogs.projectId, ctx.projectId)];
  if (f.action) conds.push(eq(auditLogs.action, f.action));
  if (f.actionPrefix) conds.push(like(auditLogs.action, `${f.actionPrefix}%`));
  if (f.entityType) conds.push(eq(auditLogs.entityType, f.entityType));
  if (f.entityId) conds.push(eq(auditLogs.entityId, f.entityId));
  if (f.startUtc) conds.push(gte(auditLogs.createdAt, f.startUtc));
  if (f.endUtc) conds.push(lte(auditLogs.createdAt, f.endUtc));
  if (f.freeText && f.freeText.trim()) {
    // Free-text matches ONLY over permitted fields: the action, the entity type, and a REDACTED copy of the
    // detail (secret-bearing key values stripped in SQL before matching). A stored secret value therefore
    // never influences a match, a count, or the empty-result signal (HUB-006 correction 1). The redaction
    // regex mirrors redactAuditDetail() so search and display agree.
    const term = `%${f.freeText.trim()}%`;
    conds.push(
      sql`(${auditLogs.action} ilike ${term} or ${auditLogs.entityType} ilike ${term} or app.redact_audit_detail(${auditLogs.detail})::text ilike ${term})`,
    );
  }
  return conds;
}

/**
 * Search the ENTIRE authorized audit history (req 1). Newest-first, stable ordering on the unique
 * monotonic `seq`; keyset pagination (`seq < cursor`) so events sharing a timestamp are never duplicated
 * or skipped. Read-only — no hash is touched. Role + tenant enforced.
 */
export async function searchAuditEvents(
  tx: DbTx,
  ctx: TenantContext,
  filters: AuditSearchFilters = {},
  opts: { cursorSeq?: bigint | null; limit?: number } = {},
): Promise<AuditSearchResult> {
  assertCanViewAudit(ctx);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_AUDIT_PAGE);
  const conds = auditFilterConditions(ctx, filters);
  if (opts.cursorSeq != null) conds.push(lt(auditLogs.seq, opts.cursorSeq));

  // Fetch limit+1 to know whether an older page exists, without a second query.
  const rows = await tx
    .select({
      id: auditLogs.id,
      seq: auditLogs.seq,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      detail: auditLogs.detail,
      actorId: auditLogs.actorId,
      createdAt: auditLogs.createdAt,
      rowHash: auditLogs.rowHash,
      prevHash: auditLogs.prevHash,
      projectId: auditLogs.projectId,
    })
    .from(auditLogs)
    .where(and(...conds))
    .orderBy(desc(auditLogs.seq))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Result count over the same filters (excludes the cursor bound — the total match, not the page).
  const countConds = auditFilterConditions(ctx, filters);
  const counted = await tx
    .select({ n: sql<string>`count(*)` })
    .from(auditLogs)
    .where(and(...countConds));
  const totalCount = Number(counted[0]?.n ?? 0);

  return {
    rows: page.map((r) => ({ ...r, detail: redactAuditDetail(r.detail) })),
    nextCursor: hasMore ? String(page[page.length - 1]!.seq) : null,
    hasMore,
    totalCount,
  };
}

/** Full detail for a single audit event (req 3), redacted. Role + tenant enforced. Null if not in scope. */
export async function getAuditEvent(
  tx: DbTx,
  ctx: TenantContext,
  id: string,
): Promise<AuditEventRow | null> {
  assertCanViewAudit(ctx);
  const rows = await tx
    .select({
      id: auditLogs.id,
      seq: auditLogs.seq,
      action: auditLogs.action,
      entityType: auditLogs.entityType,
      entityId: auditLogs.entityId,
      detail: auditLogs.detail,
      actorId: auditLogs.actorId,
      createdAt: auditLogs.createdAt,
      rowHash: auditLogs.rowHash,
      prevHash: auditLogs.prevHash,
      projectId: auditLogs.projectId,
    })
    .from(auditLogs)
    .where(and(eq(auditLogs.id, id), eq(auditLogs.orgId, ctx.orgId), eq(auditLogs.projectId, ctx.projectId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { ...row, detail: redactAuditDetail(row.detail) };
}
