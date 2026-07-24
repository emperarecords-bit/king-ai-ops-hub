import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { TenantViolationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { projectContextItems } from '@/db/schema';
import { type ContextItemForPrompt } from '@/orchestration/prompts';

/**
 * Loads the ONLY context that may enter a prompt: this project's APPROVED
 * items. This is the highest-risk read in the system (invariant I1), so on top
 * of the WHERE clause and RLS it re-asserts tenancy on every returned row and
 * treats a mismatch as a fire alarm.
 */
export async function loadApprovedContext(
  tx: DbTx,
  ctx: TenantContext,
): Promise<ContextItemForPrompt[]> {
  const rows = await tx
    .select({
      projectId: projectContextItems.projectId,
      orgId: projectContextItems.orgId,
      title: projectContextItems.title,
      content: projectContextItems.content,
    })
    .from(projectContextItems)
    .where(
      and(
        eq(projectContextItems.projectId, ctx.projectId),
        eq(projectContextItems.orgId, ctx.orgId),
        eq(projectContextItems.status, 'approved'),
      ),
    );

  for (const row of rows) {
    if (row.projectId !== ctx.projectId || row.orgId !== ctx.orgId) {
      log.error('TENANT VIOLATION in loadApprovedContext', {
        expectedProject: ctx.projectId,
        gotProject: row.projectId,
      });
      throw new TenantViolationError(
        `Context row from project ${row.projectId} surfaced for ${ctx.projectId}`,
      );
    }
  }

  return rows.map((r) => ({ title: r.title, content: r.content }));
}
