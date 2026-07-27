import 'server-only';
import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { knowledgeSources, runDocumentVersions } from '@/db/schema';

/**
 * Evidence-reference reverse trails + retention protection for immutable Document Versions.
 *
 * A version is referenced through TWO row shapes in `run_document_versions`: a version-level row
 * (`chunk_index = -1`) meaning "this run received evidence from this version," and chunk-level rows
 * meaning "these specific chunks were supplied." Both describe the SAME run. Reverse trails and usage
 * counts must therefore DEDUPLICATE by run — a run that cited a version via one version-level row and
 * three chunks is ONE user of that version, not four. Retention (purge protection) may treat either
 * relationship as sufficient.
 */

/** DISTINCT runs that received evidence from a version (deduped across version-level + chunk-level rows). */
export async function runsReferencingVersion(tx: DbTx, ctx: TenantContext, versionId: string): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ runId: runDocumentVersions.runId })
    .from(runDocumentVersions)
    .where(and(eq(runDocumentVersions.orgId, ctx.orgId), eq(runDocumentVersions.projectId, ctx.projectId), eq(runDocumentVersions.documentVersionId, versionId)));
  return rows.map((r) => r.runId);
}

/** How many DISTINCT runs used this version — the count a reverse trail shows (never inflated by having
 *  both a version-level and several chunk-level rows for one run). */
export async function runReferenceCount(tx: DbTx, ctx: TenantContext, versionId: string): Promise<number> {
  return (await runsReferencingVersion(tx, ctx, versionId)).length;
}

/**
 * Whether an immutable version is still referenced and therefore MUST NOT be purged. A version is
 * protected if ANY run received evidence from it OR any Knowledge citation is bound to it. Deduplication
 * of the run rows does not weaken this — one surviving reference of either kind is sufficient to block
 * deletion. (Purge itself is Stage D; this is the query the safeguard is built on.)
 */
export async function isVersionReferenced(tx: DbTx, ctx: TenantContext, versionId: string): Promise<boolean> {
  const runRef = (
    await tx
      .select({ id: runDocumentVersions.id })
      .from(runDocumentVersions)
      .where(and(eq(runDocumentVersions.orgId, ctx.orgId), eq(runDocumentVersions.projectId, ctx.projectId), eq(runDocumentVersions.documentVersionId, versionId)))
      .limit(1)
  )[0];
  if (runRef) return true;
  const knowledgeRef = (
    await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.orgId, ctx.orgId), eq(knowledgeSources.projectId, ctx.projectId), eq(knowledgeSources.documentVersionId, versionId)))
      .limit(1)
  )[0];
  return !!knowledgeRef;
}
