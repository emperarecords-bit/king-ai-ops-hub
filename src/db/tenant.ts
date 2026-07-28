import { sql } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { getDb, getPurgeDb, type DbTx } from './client';
import {
  invalidTenantFields,
  isRlsViolation,
  logRlsRejection,
  logTenantContextInvalid,
} from './security-log';

/** Fail closed if a required identifier is missing/malformed before it is ever
 *  stamped as a GUC. A blank or non-UUID GUC would silently make the RLS
 *  helpers return NULL — better to refuse loudly than to run context-less. */
function assertIdentifiers(
  boundary: 'withTenant' | 'withOrg' | 'withUser',
  ctx: { userId?: string; orgId?: string; projectId?: string },
): void {
  const bad = invalidTenantFields(ctx);
  if (bad.length > 0) {
    logTenantContextInvalid(boundary, bad);
    throw new Error(`${boundary}: missing or invalid tenant context (${bad.join(', ')})`);
  }
}

/**
 * The tenant boundary, TB-2 (ARCHITECTURE.md §3).
 *
 * `withTenant` is the ONLY sanctioned way to touch tenant-scoped tables. It
 * opens a transaction and stamps the caller's identity into transaction-local
 * GUCs that the RLS policies read. Because `set_config(..., true)` is
 * transaction-scoped, nothing can leak across pooled connections.
 *
 * App-layer queries still filter by org/project explicitly — RLS is the net
 * under the trapeze, not the trapeze.
 */

export async function withTenant<T>(
  ctx: TenantContext,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  assertIdentifiers('withTenant', {
    userId: ctx.userId,
    orgId: ctx.orgId,
    projectId: ctx.projectId,
  });
  const db = getDb();
  try {
    return await db.transaction(async (tx) => {
      // Parameterized; set_config is SQL-injection-safe with bound values.
      await tx.execute(sql`
        select
          set_config('app.user_id', ${ctx.userId}, true),
          set_config('app.org_id', ${ctx.orgId}, true),
          set_config('app.project_id', ${ctx.projectId}, true)
      `);
      return fn(tx);
    });
  } catch (err) {
    if (isRlsViolation(err)) logRlsRejection('withTenant', ctx, err);
    throw err;
  }
}

/**
 * The tenant boundary for the DOCUMENT PURGE execution path — identical to withTenant (same transaction-local
 * GUCs, same RLS enforcement) except it runs on the dedicated least-privilege `purge_agent` connection, the
 * only role permitted to delete immutable version rows. Used ONLY by the purge execute action; ordinary
 * application code uses withTenant (app_server), which cannot delete versions.
 */
export async function withPurgeTenant<T>(
  ctx: TenantContext,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  assertIdentifiers('withTenant', { userId: ctx.userId, orgId: ctx.orgId, projectId: ctx.projectId });
  const db = getPurgeDb();
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.user_id', ${ctx.userId}, true),
          set_config('app.org_id', ${ctx.orgId}, true),
          set_config('app.project_id', ${ctx.projectId}, true)
      `);
      return fn(tx);
    });
  } catch (err) {
    if (isRlsViolation(err)) logRlsRejection('withTenant', ctx, err);
    throw err;
  }
}

/**
 * The pre-tenant bootstrap boundary (O-22). A handful of reads must run BEFORE
 * an (org, project) is known — resolving which orgs/projects the authenticated
 * user belongs to. Under the non-superuser `app_server` role those reads are
 * still RLS-governed, so they need at least the user's identity stamped. This
 * sets ONLY app.user_id (org/project left unset → NULL → fail closed on tenant
 * tables); the navigation-table policies key off membership, so a user sees
 * exactly their own memberships/projects/orgs and nothing else.
 *
 * This is strictly narrower than withOrg/withTenant — use it only for the
 * identity-resolution reads in src/db/system.ts.
 */
export async function withUser<T>(
  args: { userId: string },
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  assertIdentifiers('withUser', { userId: args.userId });
  const db = getDb();
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.user_id', ${args.userId}, true)`);
      return fn(tx);
    });
  } catch (err) {
    if (isRlsViolation(err)) logRlsRejection('withUser', args, err);
    throw err;
  }
}

/**
 * For operations that are org-scoped but not project-scoped (listing the
 * caller's projects, org settings). project_id is set to the nil UUID, which
 * matches no project row.
 */
export async function withOrg<T>(
  args: { userId: string; orgId: string },
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> {
  assertIdentifiers('withOrg', { userId: args.userId, orgId: args.orgId });
  const db = getDb();
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`
        select
          set_config('app.user_id', ${args.userId}, true),
          set_config('app.org_id', ${args.orgId}, true),
          set_config('app.project_id', '00000000-0000-0000-0000-000000000000', true)
      `);
      return fn(tx);
    });
  } catch (err) {
    if (isRlsViolation(err)) logRlsRejection('withOrg', args, err);
    throw err;
  }
}
