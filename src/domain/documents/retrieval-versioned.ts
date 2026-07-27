import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { type ContentFidelity, type TenantContext } from '@/types/domain';
import { TenantViolationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { documentChunks, documentVersions, documents } from '@/db/schema';
import {
  CORE_REFERENCE_POSIX,
  CORE_REFERENCE_TYPES,
  PRODUCTION_STATUS_POSIX,
  type RetrievedChunk,
  coreTypeOf,
  expandDocumentQuery,
} from './documents';

/**
 * VERSIONED retrieval (Documents increment 1, Stage C2). The version-aware equivalents of the legacy
 * document reads. Every retrieved excerpt is bound to an explicitly identified immutable version:
 *   - start from ACTIVE logical Documents,
 *   - join ONLY through `documents.current_version_id`,
 *   - require that current version to be `indexed`,
 *   - read ONLY chunks belonging to that exact version (`document_version_id = current_version_id`),
 *   - re-assert org + workspace on every row (I1), and return the version id, version hash, fidelity,
 *     index status, chunk content-hash and locator.
 * This structurally excludes pending / failed / unavailable versions and archived / source_unavailable /
 * uploaded / queued / indexing Documents — none of them have an `active` doc + `indexed` current version.
 *
 * Principle: every retrieved Document excerpt belongs to an explicitly identified immutable version. The
 * version is NEVER inferred from the Document hash after selection — the selected rows are version-bound
 * by the join and the chunk filter.
 */

export interface VersionedRetrievedChunk extends RetrievedChunk {
  /** The immutable version this chunk belongs to — equal to the Document's current_version_id. */
  documentVersionId: string;
  /** The version's content hash (byte_exact/reconstructed: equals the Document hash). */
  versionHash: string;
  versionFidelity: ContentFidelity;
  versionIndexStatus: string;
  /** The chunk's own content hash + locator, for self-proving integrity checks. */
  contentHash: string | null;
  locator: string | null;
}

/** Shared column selection for the versioned reads — version-bound by construction. */
const versionedColumns = {
  documentId: documentChunks.documentId,
  relativePath: documents.relativePath,
  chunkIndex: documentChunks.chunkIndex,
  content: documentChunks.content,
  documentHash: documents.sha256,
  disclosure: documents.disclosure,
  indexedAt: documents.indexedAt,
  source: documents.source,
  documentVersionId: documentVersions.id,
  versionHash: documentVersions.sha256,
  versionFidelity: documentVersions.contentFidelity,
  versionIndexStatus: documentVersions.indexStatus,
  contentHash: documentChunks.contentHash,
  locator: documentChunks.locator,
  orgId: documentChunks.orgId,
  projectId: documentChunks.projectId,
} as const;

type VersionedRow = {
  documentId: string;
  relativePath: string;
  chunkIndex: number;
  content: string;
  documentHash: string;
  disclosure: RetrievedChunk['disclosure'];
  indexedAt: Date | null;
  source: RetrievedChunk['source'];
  documentVersionId: string;
  versionHash: string;
  versionFidelity: ContentFidelity;
  versionIndexStatus: string;
  contentHash: string | null;
  locator: string | null;
  orgId: string;
  projectId: string;
};

/** I1 re-assertion + a self-proving integrity check: each row's version belongs to its Document's current
 *  version, the same workspace, and is indexed. A mismatch is a fire alarm, not a filtered row. */
function assertVersionedTenant(rows: ReadonlyArray<VersionedRow>, ctx: TenantContext, where: string): void {
  for (const r of rows) {
    if (r.projectId !== ctx.projectId || r.orgId !== ctx.orgId) {
      log.error(`TENANT VIOLATION in ${where}`, { expectedProject: ctx.projectId, gotProject: r.projectId });
      throw new TenantViolationError(`Document chunk from project ${r.projectId} surfaced for ${ctx.projectId}`);
    }
    if (r.versionIndexStatus !== 'indexed') {
      throw new TenantViolationError(`${where}: non-indexed version ${r.documentVersionId} surfaced`);
    }
  }
}

function toChunk(r: VersionedRow, rank: number): VersionedRetrievedChunk {
  return {
    documentId: r.documentId,
    relativePath: r.relativePath,
    chunkIndex: r.chunkIndex,
    content: r.content,
    rank,
    sha256: r.documentHash,
    disclosure: r.disclosure,
    indexedAt: r.indexedAt,
    source: r.source,
    documentVersionId: r.documentVersionId,
    versionHash: r.versionHash,
    versionFidelity: r.versionFidelity,
    versionIndexStatus: r.versionIndexStatus,
    contentHash: r.contentHash,
    locator: r.locator,
  };
}

/**
 * Versioned equivalent of `retrieveRelevant`. Same query expansion, ranking, and episode boost — but the
 * candidate chunks are exactly the current-version chunks of active documents. Deterministic tie-break by
 * (episode-hit, rank, relativePath, chunkIndex) so ordering is stable across both retrieval paths.
 */
export async function retrieveRelevantVersioned(tx: DbTx, ctx: TenantContext, queryText: string, limit = 5): Promise<VersionedRetrievedChunk[]> {
  const { tsquery, episodePatterns } = expandDocumentQuery(queryText);
  if (tsquery.length === 0) return [];
  const q = sql`to_tsquery('english', ${tsquery})`;
  const filenameMatch =
    episodePatterns.length === 0 ? sql`false` : sql.join(episodePatterns.map((p) => sql`${documents.relativePath} ilike ${p}`), sql` or `);

  const rows = (await tx
    .select({ ...versionedColumns, rank: sql<number>`ts_rank(document_chunks.search, ${q})`, episodeHit: sql<boolean>`(${filenameMatch})` })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .innerJoin(documentVersions, eq(documents.currentVersionId, documentVersions.id))
    .where(
      and(
        eq(documentChunks.projectId, ctx.projectId),
        eq(documentChunks.orgId, ctx.orgId),
        eq(documents.status, 'active'),
        eq(documentVersions.indexStatus, 'indexed'),
        // Version-bound: only chunks OF the document's current version (never a prior/failed/unavailable one).
        eq(documentChunks.documentVersionId, documents.currentVersionId),
        sql`(document_chunks.search @@ ${q} or ${filenameMatch})`,
      ),
    )
    .orderBy(
      sql`(case when ${filenameMatch} then 1 else 0 end) desc`,
      sql`ts_rank(document_chunks.search, ${q}) desc`,
      documents.relativePath,
      documentChunks.chunkIndex,
    )
    .limit(limit)) as (VersionedRow & { rank: number })[];

  assertVersionedTenant(rows, ctx, 'retrieveRelevantVersioned');
  return rows.map((r) => toChunk(r, Number(r.rank)));
}

export interface VersionedCoreReferenceChunk extends VersionedRetrievedChunk {
  coreType: string;
}

/** Versioned equivalent of `selectCoreReferences`. */
export async function selectCoreReferencesVersioned(tx: DbTx, ctx: TenantContext, exclude: ReadonlySet<string>, limit = 2): Promise<VersionedCoreReferenceChunk[]> {
  const rows = (await tx
    .select(versionedColumns)
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .innerJoin(documentVersions, eq(documents.currentVersionId, documentVersions.id))
    .where(
      and(
        eq(documentChunks.projectId, ctx.projectId),
        eq(documentChunks.orgId, ctx.orgId),
        eq(documents.status, 'active'),
        eq(documentVersions.indexStatus, 'indexed'),
        eq(documentChunks.documentVersionId, documents.currentVersionId),
        eq(documentChunks.chunkIndex, 0),
        sql`${documents.relativePath} ~* ${CORE_REFERENCE_POSIX}`,
      ),
    )) as VersionedRow[];
  assertVersionedTenant(rows, ctx, 'selectCoreReferencesVersioned');

  const priority = (p: string): number => {
    const i = CORE_REFERENCE_TYPES.findIndex((t) => t.test.test(p));
    return i === -1 ? CORE_REFERENCE_TYPES.length : i;
  };
  return rows
    .filter((r) => !exclude.has(r.relativePath))
    .sort((a, b) => priority(a.relativePath) - priority(b.relativePath) || a.relativePath.localeCompare(b.relativePath))
    .slice(0, limit)
    .map((r) => ({ ...toChunk(r, 0), coreType: coreTypeOf(r.relativePath) }));
}

/** Versioned equivalent of `selectProductionStatus`. */
export async function selectProductionStatusVersioned(tx: DbTx, ctx: TenantContext, exclude: ReadonlySet<string>): Promise<VersionedRetrievedChunk | null> {
  const rows = (await tx
    .select(versionedColumns)
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .innerJoin(documentVersions, eq(documents.currentVersionId, documentVersions.id))
    .where(
      and(
        eq(documentChunks.projectId, ctx.projectId),
        eq(documentChunks.orgId, ctx.orgId),
        eq(documents.status, 'active'),
        eq(documentVersions.indexStatus, 'indexed'),
        eq(documentChunks.documentVersionId, documents.currentVersionId),
        eq(documentChunks.chunkIndex, 0),
        sql`${documents.relativePath} ~* ${PRODUCTION_STATUS_POSIX}`,
      ),
    )
    .orderBy(documents.relativePath)
    .limit(1)) as VersionedRow[];
  assertVersionedTenant(rows, ctx, 'selectProductionStatusVersioned');
  const r = rows.find((row) => !exclude.has(row.relativePath));
  return r ? toChunk(r, 0) : null;
}
