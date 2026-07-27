import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { documentVersions, documents } from '@/db/schema';
import { type RetrievedChunk, retrieveRelevant, selectCoreReferences, selectProductionStatus } from './documents';
import { type VersionedRetrievedChunk, retrieveRelevantVersioned, selectCoreReferencesVersioned, selectProductionStatusVersioned } from './retrieval-versioned';

/**
 * SHADOW comparison (Documents increment 1, Stage C2). Runs the legacy and versioned retrieval paths
 * INDEPENDENTLY over a query, normalizes each into a shared comparison contract, and classifies every
 * difference. Read-only and side-effect-free: it calls the read functions only — it never writes
 * `run_document_versions`, never mutates Documents/versions, and never feeds a prompt. Reports carry
 * identifiers, hashes, scores, and disclosure state — NEVER source text (a shadow report must not become
 * a disclosure channel).
 *
 * Both paths genuinely exercise their own data path: legacy reads null-version chunks; versioned reads
 * current-version chunks via `documents.current_version_id`. Neither side is derived from the other.
 */

export type RetrievalCategory = 'relevant' | 'core' | 'production_status';
export type DiffCategory = 'exact_match' | 'expected_exclusion' | 'legacy_defect_corrected' | 'versioned_defect' | 'unresolved';

const SCORE_TOLERANCE = 1e-9; // both paths use identical ts_rank SQL on identical content ⇒ exact equality

function sha256Hex(s: string): string {
  return createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
}

/** The shared, text-free comparison row. `key` = category|documentId|chunkIndex identifies the same unit
 *  across both paths. Versioned rows additionally carry version identity. */
export interface ComparisonRow {
  key: string;
  category: RetrievalCategory;
  projectId: string;
  documentId: string;
  relativePath: string;
  chunkIndex: number;
  chunkContentHash: string;
  documentHash: string;
  disclosure: string;
  rankPosition: number;
  score: number;
  documentVersionId?: string;
  versionFidelity?: string;
  versionIndexStatus?: string;
}

export interface Difference {
  category: DiffCategory;
  key: string;
  documentId: string;
  relativePath: string;
  chunkIndex: number;
  reason: string;
  /** Text-free detail — hashes + ids + scores only. */
  legacy?: Partial<ComparisonRow>;
  versioned?: Partial<ComparisonRow>;
}

export interface QueryComparison {
  queryHash: string;
  legacyCount: number;
  versionedCount: number;
  exactMatches: number;
  byCategory: Record<DiffCategory, number>;
  differences: Difference[];
}

interface DocMeta {
  status: string;
  currentVersionId: string | null;
  currentIndexed: boolean;
}

/** One pass over the workspace's Documents so a legacy-only or versioned-only row can be classified
 *  against the agreed lifecycle contract (which sources are expected to be non-retrievable, and why). */
export async function buildDocMeta(tx: DbTx, ctx: TenantContext): Promise<Map<string, DocMeta>> {
  const docs = await tx
    .select({ id: documents.id, status: documents.status, currentVersionId: documents.currentVersionId, curStatus: documentVersions.indexStatus })
    .from(documents)
    .leftJoin(documentVersions, eq(documents.currentVersionId, documentVersions.id))
    .where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));
  const map = new Map<string, DocMeta>();
  for (const d of docs) {
    map.set(d.id, { status: d.status, currentVersionId: d.currentVersionId, currentIndexed: d.curStatus === 'indexed' });
  }
  return map;
}

const EXPECTED_NON_RETRIEVABLE_STATUSES = new Set(['archived', 'source_unavailable', 'failed', 'unsupported', 'uploaded', 'queued', 'indexing']);

/** Classify a chunk that legacy returned but versioned did NOT. */
function classifyLegacyOnly(meta: DocMeta | undefined): { category: DiffCategory; reason: string } {
  if (!meta) return { category: 'unresolved', reason: 'legacy returned a chunk for a Document not found in this workspace' };
  if (EXPECTED_NON_RETRIEVABLE_STATUSES.has(meta.status)) {
    return { category: 'expected_exclusion', reason: `source is ${meta.status} (agreed non-retrievable lifecycle state)` };
  }
  if (meta.status === 'active' && !meta.currentIndexed) {
    // Legacy served content for an active Document with no valid indexed current version — the versioned
    // path correctly withholds it. This is a legacy defect the switch corrects.
    return { category: 'legacy_defect_corrected', reason: 'active Document has no valid indexed current version; legacy served it, versioned withholds it' };
  }
  return { category: 'versioned_defect', reason: 'versioned path dropped a chunk a valid current version should have supplied' };
}

/** Assemble the supplied-source set exactly as the runner does: relevant (5) → dedup → core (2) → dedup →
 *  production-status. Returns tagged comparison rows. */
function assembleRows(
  relevant: RetrievedChunk[],
  core: RetrievedChunk[],
  production: RetrievedChunk | null,
  versioned: boolean,
): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  const push = (r: RetrievedChunk, category: RetrievalCategory, pos: number) => {
    const v = versioned ? (r as VersionedRetrievedChunk) : undefined;
    rows.push({
      key: `${category}|${r.documentId}|${r.chunkIndex}`,
      category,
      projectId: '', // filled by caller-independent compare (project is fixed per run)
      documentId: r.documentId,
      relativePath: r.relativePath,
      chunkIndex: r.chunkIndex,
      // Hash the ACTUAL returned content on both sides (never a stored hash that could be stale) so a
      // corrupted or diverging chunk is genuinely detected rather than trusted.
      chunkContentHash: sha256Hex(r.content),
      documentHash: r.sha256,
      disclosure: r.disclosure,
      rankPosition: pos,
      score: r.rank,
      documentVersionId: v?.documentVersionId,
      versionFidelity: v?.versionFidelity,
      versionIndexStatus: v?.versionIndexStatus,
    });
  };
  relevant.forEach((r, i) => push(r, 'relevant', i));
  core.forEach((r, i) => push(r, 'core', i));
  if (production) push(production, 'production_status', 0);
  return rows;
}

function emptyByCategory(): Record<DiffCategory, number> {
  return { exact_match: 0, expected_exclusion: 0, legacy_defect_corrected: 0, versioned_defect: 0, unresolved: 0 };
}

/** Compare two assembled row sets for one query. */
export function compareAssembled(legacy: ComparisonRow[], versioned: ComparisonRow[], docMeta: Map<string, DocMeta>): QueryComparison {
  const byCategory = emptyByCategory();
  const differences: Difference[] = [];
  const legacyByKey = new Map(legacy.map((r) => [r.key, r]));
  const versionedByKey = new Map(versioned.map((r) => [r.key, r]));
  let exactMatches = 0;

  for (const l of legacy) {
    const v = versionedByKey.get(l.key);
    if (!v) {
      const { category, reason } = classifyLegacyOnly(docMeta.get(l.documentId));
      byCategory[category] += 1;
      differences.push({ category, key: l.key, documentId: l.documentId, relativePath: l.relativePath, chunkIndex: l.chunkIndex, reason, legacy: textFree(l) });
      continue;
    }
    // Present on both — compare identity, content, disclosure, ordering.
    const contentSame = l.chunkContentHash === v.chunkContentHash && l.documentHash === v.documentHash;
    const disclosureSame = l.disclosure === v.disclosure;
    const orderSame = l.rankPosition === v.rankPosition;
    const scoreSame = Math.abs(l.score - v.score) <= SCORE_TOLERANCE;
    if (contentSame && disclosureSame && orderSame && scoreSame) {
      exactMatches += 1;
      byCategory.exact_match += 1;
    } else if (!contentSame) {
      byCategory.versioned_defect += 1;
      differences.push({ category: 'versioned_defect', key: l.key, documentId: l.documentId, relativePath: l.relativePath, chunkIndex: l.chunkIndex, reason: 'content/document hash differs between paths', legacy: textFree(l), versioned: textFree(v) });
    } else if (!disclosureSame) {
      byCategory.versioned_defect += 1;
      differences.push({ category: 'versioned_defect', key: l.key, documentId: l.documentId, relativePath: l.relativePath, chunkIndex: l.chunkIndex, reason: 'disclosure result differs between paths', legacy: textFree(l), versioned: textFree(v) });
    } else if (scoreSame && !orderSame) {
      // Same content, same disclosure, SAME relevance score, different position: a pure tie-ordering
      // artifact. Legacy retrieval has no deterministic tie-break (non-deterministic on ties); the
      // versioned path breaks ties by stable Document identity + chunk index. The set and scores are
      // identical, so this is an accepted legacy defect the switch corrects — not a ranking divergence.
      byCategory.legacy_defect_corrected += 1;
      differences.push({ category: 'legacy_defect_corrected', key: l.key, documentId: l.documentId, relativePath: l.relativePath, chunkIndex: l.chunkIndex, reason: `tied score ${l.score} ordered non-deterministically by legacy (pos ${l.rankPosition}) vs deterministically by versioned (pos ${v.rankPosition})`, legacy: textFree(l), versioned: textFree(v) });
    } else {
      // The relevance scores themselves differ — a genuine ranking divergence. Blocking.
      byCategory.unresolved += 1;
      differences.push({ category: 'unresolved', key: l.key, documentId: l.documentId, relativePath: l.relativePath, chunkIndex: l.chunkIndex, reason: `relevance score differs (legacy pos ${l.rankPosition} score ${l.score}; versioned pos ${v.rankPosition} score ${v.score})`, legacy: textFree(l), versioned: textFree(v) });
    }
  }
  // Rows the versioned path returned that legacy did not.
  for (const v of versioned) {
    if (legacyByKey.has(v.key)) continue;
    const meta = docMeta.get(v.documentId);
    // Versioned surfaced a current-version chunk legacy missed. If the Document is active+indexed this is
    // a real divergence to explain (versioned defect); otherwise unresolved.
    const category: DiffCategory = 'versioned_defect';
    byCategory[category] += 1;
    differences.push({ category, key: v.key, documentId: v.documentId, relativePath: v.relativePath, chunkIndex: v.chunkIndex, reason: meta ? 'versioned returned a chunk legacy did not' : 'versioned returned a chunk for an unknown Document', versioned: textFree(v) });
  }

  return { queryHash: '', legacyCount: legacy.length, versionedCount: versioned.length, exactMatches, byCategory, differences };
}

/** Strip content text; keep only identifiers, hashes, scores, disclosure. */
function textFree(r: ComparisonRow): Partial<ComparisonRow> {
  return {
    documentId: r.documentId,
    relativePath: r.relativePath,
    chunkIndex: r.chunkIndex,
    chunkContentHash: r.chunkContentHash,
    documentHash: r.documentHash,
    disclosure: r.disclosure,
    rankPosition: r.rankPosition,
    score: r.score,
    documentVersionId: r.documentVersionId,
    versionFidelity: r.versionFidelity,
    versionIndexStatus: r.versionIndexStatus,
  };
}

/**
 * Run BOTH retrieval paths for one query and compare. Read-only; assembles the same relevant→core→
 * production set the runner would, on each path independently. No prompt is fed, no evidence is written.
 */
export async function shadowCompareQuery(tx: DbTx, ctx: TenantContext, queryText: string, docMeta: Map<string, DocMeta>, limit = 5): Promise<QueryComparison> {
  // Legacy path (authoritative in shadow mode).
  const lRelevant = await retrieveRelevant(tx, ctx, queryText, limit);
  const lSeen = new Set(lRelevant.map((r) => r.relativePath));
  const lCore = await selectCoreReferences(tx, ctx, lSeen, 2);
  lCore.forEach((c) => lSeen.add(c.relativePath));
  const lProd = await selectProductionStatus(tx, ctx, lSeen);

  // Versioned path (compared, non-authoritative).
  const vRelevant = await retrieveRelevantVersioned(tx, ctx, queryText, limit);
  const vSeen = new Set(vRelevant.map((r) => r.relativePath));
  const vCore = await selectCoreReferencesVersioned(tx, ctx, vSeen, 2);
  vCore.forEach((c) => vSeen.add(c.relativePath));
  const vProd = await selectProductionStatusVersioned(tx, ctx, vSeen);

  const legacyRows = assembleRows(lRelevant, lCore, lProd, false);
  const versionedRows = assembleRows(vRelevant, vCore, vProd, true);
  const cmp = compareAssembled(legacyRows, versionedRows, docMeta);
  cmp.queryHash = sha256Hex(queryText);
  return cmp;
}

export interface ShadowCorpusReport {
  projectId: string;
  queries: number;
  totalComparisons: number;
  exactMatches: number;
  byCategory: Record<DiffCategory, number>;
  /** Documents the agreed lifecycle marks non-retrievable — reported explicitly, never silently omitted. */
  expectedNonRetrievable: { documentId: string; relativePath: string; status: string }[];
  retrievableDocuments: number;
  /** Only the blocking differences (versioned_defect + unresolved) are surfaced in full. */
  blockingDifferences: Difference[];
  switchClear: boolean;
}

/** Run a corpus of queries and aggregate. Also enumerates the workspace's expected-non-retrievable
 *  Documents so they appear in the report as named exclusions rather than unexplained absences. */
export async function runShadowCorpus(tx: DbTx, ctx: TenantContext, queries: string[], limit = 5): Promise<ShadowCorpusReport> {
  const docMeta = await buildDocMeta(tx, ctx);
  const byCategory = emptyByCategory();
  const blocking: Difference[] = [];
  let totalComparisons = 0;
  let exactMatches = 0;
  for (const query of queries) {
    const cmp = await shadowCompareQuery(tx, ctx, query, docMeta, limit);
    totalComparisons += cmp.legacyCount + cmp.versionedCount;
    exactMatches += cmp.exactMatches;
    for (const k of Object.keys(byCategory) as DiffCategory[]) byCategory[k] += cmp.byCategory[k];
    for (const d of cmp.differences) if (d.category === 'versioned_defect' || d.category === 'unresolved') blocking.push(d);
  }

  const expectedNonRetrievable: ShadowCorpusReport['expectedNonRetrievable'] = [];
  let retrievable = 0;
  const allDocs = await tx
    .select({ id: documents.id, relativePath: documents.relativePath, status: documents.status })
    .from(documents)
    .where(and(eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));
  for (const d of allDocs) {
    const meta = docMeta.get(d.id);
    const retrievableNow = d.status === 'active' && !!meta?.currentIndexed;
    if (retrievableNow) retrievable += 1;
    else expectedNonRetrievable.push({ documentId: d.id, relativePath: d.relativePath, status: d.status });
  }

  return {
    projectId: ctx.projectId,
    queries: queries.length,
    totalComparisons,
    exactMatches,
    byCategory,
    expectedNonRetrievable,
    retrievableDocuments: retrievable,
    blockingDifferences: blocking,
    switchClear: byCategory.versioned_defect === 0 && byCategory.unresolved === 0,
  };
}
