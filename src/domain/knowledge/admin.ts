import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { TenantViolationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { knowledgeItems } from '@/db/schema';

/**
 * ADMINISTRATION-ONLY knowledge retrieval, deliberately isolated from the AI-context surface.
 *
 * This returns ALL active project knowledge UNFILTERED by relevance or disclosure — the wholesale
 * read whose unrestricted output was the context-leak defect. It lives in this admin module (not the
 * prompt/domain surface) so that a prompt-producing path can only reach it by a conspicuous,
 * deliberate import. Every AI context consumer must instead use `selectRelevantKnowledge` (relevance
 * gate today; disclosure gate is future). Use here is confined to admin/inspection/migration/lifecycle
 * reads that are NOT sent to a model.
 *
 * Still the highest-risk read (invariant I1): on top of the WHERE clause and RLS it re-asserts
 * tenancy on every returned row and treats a mismatch as a fire alarm.
 */
export async function listAllActiveKnowledgeForAdministration(
  tx: DbTx,
  ctx: TenantContext,
): Promise<{ title: string; content: string }[]> {
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
      log.error('TENANT VIOLATION in listAllActiveKnowledgeForAdministration', {
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
