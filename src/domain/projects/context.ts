import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { TenantViolationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { knowledgeItems } from '@/db/schema';
import { type ContextItemForPrompt } from '@/orchestration/prompts';

/**
 * Loads the ONLY context that may enter a prompt: this project's ACTIVE
 * knowledge (K1 — KNOWLEDGE-DESIGN.md §4; formerly approved context items,
 * migrated in by migration 0004). Draft and archived items are never
 * injected; supersede archives predecessors atomically, so "active" always
 * means "the newest approved version".
 *
 * This is the highest-risk read in the system (invariant I1), so on top of
 * the WHERE clause and RLS it re-asserts tenancy on every returned row and
 * treats a mismatch as a fire alarm.
 */
export async function loadApprovedContext(
  tx: DbTx,
  ctx: TenantContext,
): Promise<ContextItemForPrompt[]> {
  const rows = await tx
    .select({
      projectId: knowledgeItems.projectId,
      orgId: knowledgeItems.orgId,
      title: knowledgeItems.title,
      content: knowledgeItems.body,
    })
    .from(knowledgeItems)
    .where(
      and(
        eq(knowledgeItems.projectId, ctx.projectId),
        eq(knowledgeItems.orgId, ctx.orgId),
        eq(knowledgeItems.scope, 'project'),
        eq(knowledgeItems.status, 'active'),
      ),
    );

  for (const row of rows) {
    if (row.projectId !== ctx.projectId || row.orgId !== ctx.orgId) {
      log.error('TENANT VIOLATION in loadApprovedContext', {
        expectedProject: ctx.projectId,
        gotProject: row.projectId,
      });
      throw new TenantViolationError(
        `Knowledge row from project ${row.projectId} surfaced for ${ctx.projectId}`,
      );
    }
  }

  return rows.map((r) => ({ title: r.title, content: r.content }));
}
