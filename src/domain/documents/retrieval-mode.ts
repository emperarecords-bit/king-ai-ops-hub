import 'server-only';
import { and, eq } from 'drizzle-orm';
import { type RetrievalMode, type TenantContext } from '@/types/domain';
import { AppError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { projects } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { type RetrievedChunk, retrieveRelevant, selectCoreReferences, selectProductionStatus } from './documents';
import { retrieveRelevantVersioned, selectCoreReferencesVersioned, selectProductionStatusVersioned } from './retrieval-versioned';
import { buildDocMeta, shadowCompareQuery } from './shadow';

/**
 * Server-authoritative retrieval-mode dispatch (Documents increment 1, Stage C2). The workspace's mode is
 * read from `projects.retrieval_mode` — NEVER from client input. It decides which retrieval path is
 * authoritative for a run:
 *   - `legacy`    → legacy null-version retrieval decides the result.
 *   - `shadow`    → legacy decides; the versioned path is run and compared non-authoritatively (bounded
 *                   instrumentation only; a shadow error never breaks the authoritative legacy request,
 *                   and shadow execution writes no evidence and mutates nothing).
 *   - `versioned` → the current-version path decides; the run then writes version-bound evidence.
 */

/** A supplied document chunk, carrying version identity when the versioned path produced it. */
export type SuppliedChunk = RetrievedChunk & {
  documentVersionId?: string;
  contentHash?: string | null;
  locator?: string | null;
};
export type SuppliedCoreChunk = SuppliedChunk & { coreType: string };

export interface AssembledDocumentSources {
  mode: RetrievalMode;
  /** True only when the VERSIONED path was authoritative (rows carry documentVersionId). */
  versioned: boolean;
  retrieved: SuppliedChunk[];
  coreRefs: SuppliedCoreChunk[];
  productionStatus: SuppliedChunk | null;
}

/** Read the workspace's authoritative retrieval mode. Trusted (server context), never client-supplied. */
export async function getRetrievalMode(tx: DbTx, ctx: TenantContext): Promise<RetrievalMode> {
  const row = (
    await tx.select({ mode: projects.retrievalMode }).from(projects).where(and(eq(projects.id, ctx.projectId), eq(projects.orgId, ctx.orgId))).limit(1)
  )[0];
  return row?.mode ?? 'legacy';
}

/** Advance/roll back a workspace's retrieval mode (operator action; audited). Per-workspace rollout. */
export async function setRetrievalMode(tx: DbTx, ctx: TenantContext, mode: RetrievalMode): Promise<void> {
  await tx.update(projects).set({ retrievalMode: mode, updatedAt: new Date() }).where(and(eq(projects.id, ctx.projectId), eq(projects.orgId, ctx.orgId)));
  await writeAudit(tx, ctx, { action: 'documents.retrieval_mode.set', entityType: 'project', entityId: ctx.projectId, detail: { mode } });
}

/**
 * Assemble the run's document sources under the workspace's authoritative mode, mirroring the runner's
 * relevant(5) → dedup → core(2) → dedup → production-status assembly on whichever path is authoritative.
 */
export async function assembleDocumentSources(tx: DbTx, ctx: TenantContext, queryText: string, limit = 5): Promise<AssembledDocumentSources> {
  const mode = await getRetrievalMode(tx, ctx);

  if (mode === 'versioned') {
    const retrieved = await retrieveRelevantVersioned(tx, ctx, queryText, limit);
    const seen = new Set(retrieved.map((r) => r.relativePath));
    const coreRefs = await selectCoreReferencesVersioned(tx, ctx, seen, 2);
    coreRefs.forEach((c) => seen.add(c.relativePath));
    const productionStatus = await selectProductionStatusVersioned(tx, ctx, seen);
    return { mode, versioned: true, retrieved, coreRefs, productionStatus };
  }

  // legacy or shadow: legacy is authoritative.
  const retrieved = await retrieveRelevant(tx, ctx, queryText, limit);
  const seen = new Set(retrieved.map((r) => r.relativePath));
  const coreRefs = await selectCoreReferences(tx, ctx, seen, 2);
  coreRefs.forEach((c) => seen.add(c.relativePath));
  const productionStatus = await selectProductionStatus(tx, ctx, seen);

  if (mode === 'shadow') {
    // Non-authoritative comparison. Bounded instrumentation only (counts + categories, no source text).
    // A shadow failure MUST NOT affect the authoritative legacy result.
    try {
      const docMeta = await buildDocMeta(tx, ctx);
      const cmp = await shadowCompareQuery(tx, ctx, queryText, docMeta, limit);
      log.info('retrieval shadow comparison', {
        projectId: ctx.projectId,
        queryHash: cmp.queryHash,
        legacyCount: cmp.legacyCount,
        versionedCount: cmp.versionedCount,
        exactMatches: cmp.exactMatches,
        byCategory: cmp.byCategory,
        clear: cmp.byCategory.versioned_defect === 0 && cmp.byCategory.unresolved === 0,
      });
    } catch (err) {
      log.warn('retrieval shadow comparison failed (legacy result unaffected)', { projectId: ctx.projectId, err: err instanceof Error ? err.message : err });
    }
  }

  return { mode, versioned: false, retrieved, coreRefs, productionStatus };
}

/** Guard for callers that must not proceed under an unexpected mode. */
export function assertKnownMode(mode: string): asserts mode is RetrievalMode {
  if (mode !== 'legacy' && mode !== 'shadow' && mode !== 'versioned') throw new AppError('validation', `Unknown retrieval mode: ${mode}`);
}
