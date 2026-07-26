import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { TenantViolationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { knowledgeItems } from '@/db/schema';
import { type ContextItemForPrompt } from '@/orchestration/prompts';

/**
 * ALL active project knowledge, UNFILTERED by relevance — for administration and inspection only.
 * NEVER call this from a prompt-producing path: it is the wholesale loader whose unrestricted output
 * was the context-leak defect. Every AI context consumer must instead pass through
 * `selectRelevantKnowledge` (relevance + disclosure gate). Kept for admin/migration/lifecycle reads.
 *
 * Still the highest-risk read (invariant I1): on top of the WHERE clause and RLS it re-asserts
 * tenancy on every returned row and treats a mismatch as a fire alarm.
 */
export async function listAllActiveKnowledgeForAdministration(
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
