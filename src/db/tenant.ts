import { sql } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { getDb, type DbTx } from './client';

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
  const db = getDb();
  return db.transaction(async (tx) => {
    // Parameterized; set_config is SQL-injection-safe with bound values.
    await tx.execute(sql`
      select
        set_config('app.user_id', ${ctx.userId}, true),
        set_config('app.org_id', ${ctx.orgId}, true),
        set_config('app.project_id', ${ctx.projectId}, true)
    `);
    return fn(tx);
  });
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
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      select
        set_config('app.user_id', ${args.userId}, true),
        set_config('app.org_id', ${args.orgId}, true),
        set_config('app.project_id', '00000000-0000-0000-0000-000000000000', true)
    `);
    return fn(tx);
  });
}
