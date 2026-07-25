import 'server-only';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';
import { and, desc, eq, sql } from 'drizzle-orm';
import { type DocumentKind, type TenantContext } from '@/types/domain';
import { AppError, TenantViolationError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { documentChunks, documents, projects } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';

/**
 * Project Folder ingestion and retrieval (D-020, slice 1).
 *
 * Slice 1 indexes markdown and text from a linked LOCAL folder using Postgres
 * full-text search — no embedding provider, no per-token cost, ranking that
 * can be shown to the user. Extracted text + a content hash are stored; the
 * binary is not, so refresh re-reads from source and no file content lands in
 * a blob store.
 */

// PDF/DOCX are slice 1.5 (each needs a parser dependency). Recognized here so
// the index can REPORT them as unsupported-for-now rather than skip silently.
const EXT_KIND: Record<string, DocumentKind> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.text': 'text',
  '.pdf': 'pdf',
  '.docx': 'docx',
};
const SUPPORTED_IN_SLICE_1: ReadonlySet<DocumentKind> = new Set(['markdown', 'text']);

const MAX_FILE_BYTES = 2_000_000; // 2 MB of text is already a very long doc.
const MAX_FILES = 500; // A guard, not a quota — a runaway folder shouldn't index forever.
const CHUNK_TARGET_CHARS = 1_500; // ~a few paragraphs; small enough to rank precisely.

export interface IndexSummary {
  indexed: number;
  skippedUnchanged: number;
  unsupported: number;
  archived: number;
  failed: number;
}

/** Splits on blank lines, then packs paragraphs up to the target size. */
export function chunkText(text: string): string[] {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const chunks: string[] = [];
  let buf = '';
  for (const p of paras) {
    if (buf.length > 0 && buf.length + p.length + 2 > CHUNK_TARGET_CHARS) {
      chunks.push(buf);
      buf = '';
    }
    // A single paragraph larger than the target becomes its own chunk.
    buf = buf.length === 0 ? p : `${buf}\n\n${p}`;
  }
  if (buf.length > 0) chunks.push(buf);
  return chunks;
}

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string): Promise<void> {
    if (out.length >= MAX_FILES) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (out.length >= MAX_FILES) break;
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await recurse(full);
      else if (e.isFile()) out.push(full);
    }
  }
  await recurse(root);
  return out;
}

/** Links (or relinks) a local folder to the workspace. Does not index yet. */
export async function linkFolder(
  tx: DbTx,
  ctx: TenantContext,
  folderPath: string,
): Promise<void> {
  const trimmed = folderPath.trim();
  if (trimmed.length === 0) throw new AppError('validation', 'Folder path is required.');
  try {
    const s = await stat(trimmed);
    if (!s.isDirectory()) throw new AppError('validation', 'That path is not a folder.');
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('validation', `Cannot read that folder: ${trimmed}`);
  }
  await tx
    .update(projects)
    .set({ documentFolderPath: trimmed, updatedAt: new Date() })
    .where(and(eq(projects.id, ctx.projectId), eq(projects.orgId, ctx.orgId)));
  await writeAudit(tx, ctx, {
    action: 'document_folder.linked',
    entityType: 'project',
    entityId: ctx.projectId,
    detail: { folderPath: trimmed },
  });
}

export async function getFolderPath(tx: DbTx, ctx: TenantContext): Promise<string | null> {
  const rows = await tx
    .select({ path: projects.documentFolderPath })
    .from(projects)
    .where(and(eq(projects.id, ctx.projectId), eq(projects.orgId, ctx.orgId)))
    .limit(1);
  return rows[0]?.path ?? null;
}

/**
 * Re-reads the linked folder and reconciles the index: new/changed files are
 * (re)chunked, unchanged files skipped by hash, vanished files archived. The
 * whole reconcile runs in the caller's tenant transaction, so a failure leaves
 * the prior index intact.
 */
export async function refreshIndex(tx: DbTx, ctx: TenantContext): Promise<IndexSummary> {
  const folder = await getFolderPath(tx, ctx);
  if (!folder) throw new AppError('validation', 'No folder is linked to this workspace.');

  const summary: IndexSummary = {
    indexed: 0,
    skippedUnchanged: 0,
    unsupported: 0,
    archived: 0,
    failed: 0,
  };

  const existing = await tx
    .select({
      id: documents.id,
      relativePath: documents.relativePath,
      sha256: documents.sha256,
      status: documents.status,
    })
    .from(documents)
    .where(and(eq(documents.projectId, ctx.projectId), eq(documents.orgId, ctx.orgId)));
  const byPath = new Map(existing.map((d) => [d.relativePath, d]));
  const seen = new Set<string>();

  // Storage availability (O-21): if the linked folder is unreachable (e.g. the
  // cloud app cannot see a local machine's disk), REPORT it and stop — never
  // fall through to the archival loop below, which would falsely archive every
  // previously-indexed document just because the source is disconnected.
  try {
    const s = await stat(folder);
    if (!s.isDirectory()) throw new AppError('validation', `Linked path is not a folder: ${folder}`);
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError('validation', `Linked folder is unavailable (not archiving existing documents): ${folder}`);
  }

  let files: string[];
  try {
    files = await walk(folder);
  } catch {
    throw new AppError('validation', `Cannot read the linked folder: ${folder}`);
  }

  for (const full of files) {
    const rel = relative(folder, full).split(sep).join('/');
    const kind = EXT_KIND[extname(full).toLowerCase()];
    if (!kind) continue; // not a recognized document type at all
    if (!SUPPORTED_IN_SLICE_1.has(kind)) {
      summary.unsupported += 1;
      continue;
    }
    seen.add(rel);

    try {
      const s = await stat(full);
      if (s.size > MAX_FILE_BYTES) {
        summary.unsupported += 1;
        continue;
      }
      const raw = await readFile(full, 'utf8');
      const sha = createHash('sha256').update(raw).digest('hex');
      const prior = byPath.get(rel);
      if (prior && prior.sha256 === sha && prior.status === 'active') {
        summary.skippedUnchanged += 1;
        continue;
      }

      const chunks = chunkText(raw);
      const docId = await upsertDocument(tx, ctx, {
        priorId: prior?.id ?? null,
        relativePath: rel,
        kind,
        sha256: sha,
        sizeBytes: s.size,
        chunkCount: chunks.length,
      });
      // Replace chunks wholesale — simpler and correct vs diffing.
      await tx.delete(documentChunks).where(eq(documentChunks.documentId, docId));
      if (chunks.length > 0) {
        await tx.insert(documentChunks).values(
          chunks.map((content, i) => ({
            orgId: ctx.orgId,
            projectId: ctx.projectId,
            documentId: docId,
            chunkIndex: i,
            content,
          })),
        );
      }
      summary.indexed += 1;
    } catch (err) {
      summary.failed += 1;
      log.warn('Document index failed', { rel, err: err instanceof Error ? err.message : err });
    }
  }

  // Files that were indexed before but are gone now → archived (and their
  // chunks removed, so they stop being retrievable immediately).
  for (const d of existing) {
    if (!seen.has(d.relativePath) && d.status === 'active') {
      await tx.delete(documentChunks).where(eq(documentChunks.documentId, d.id));
      await tx
        .update(documents)
        .set({ status: 'archived', chunkCount: 0, updatedAt: new Date() })
        .where(eq(documents.id, d.id));
      summary.archived += 1;
    }
  }

  await writeAudit(tx, ctx, {
    action: 'document_folder.refreshed',
    entityType: 'project',
    entityId: ctx.projectId,
    detail: { ...summary },
  });
  return summary;
}

async function upsertDocument(
  tx: DbTx,
  ctx: TenantContext,
  d: {
    priorId: string | null;
    relativePath: string;
    kind: DocumentKind;
    sha256: string;
    sizeBytes: number;
    chunkCount: number;
  },
): Promise<string> {
  if (d.priorId) {
    await tx
      .update(documents)
      .set({
        kind: d.kind,
        sha256: d.sha256,
        sizeBytes: d.sizeBytes,
        chunkCount: d.chunkCount,
        status: 'active',
        errorMessage: null,
        indexedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(documents.id, d.priorId));
    return d.priorId;
  }
  const inserted = await tx
    .insert(documents)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      relativePath: d.relativePath,
      kind: d.kind,
      sha256: d.sha256,
      sizeBytes: d.sizeBytes,
      chunkCount: d.chunkCount,
      status: 'active',
      indexedAt: new Date(),
    })
    .returning({ id: documents.id });
  return inserted[0]!.id;
}

export interface RetrievedChunk {
  documentId: string;
  relativePath: string;
  chunkIndex: number;
  content: string;
  rank: number;
  /** Indexed file modification time (O-17 freshness). Additive; no effect on ranking. */
  indexedAt: Date | null;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

// A task brief is a natural-language instruction, not a search query. Matching
// AND across all its words (the websearch_to_tsquery default) is why "Review
// Episode 1 for continuity" retrieved nothing: no single chunk held all of
// review+episode+1+continuity. We OR the terms instead, and expand episode
// references so "Episode 1" also matches "S01E01" / "E01" in the material.
const MAX_PLAIN_TOKENS = 40;

export interface ExpandedQuery {
  /** OR-joined lexemes for to_tsquery('english', …). Empty ⇒ nothing to search. */
  tsquery: string;
  /** ILIKE patterns for referenced episodes, e.g. '%S01E01%'. */
  episodePatterns: string[];
}

/**
 * Normalizes a task brief into an OR query plus episode filename patterns.
 * Treats Episode 1 / Episode One / Ep 1 / E01 / S01E01 / Season 1 Episode 1 as
 * equivalent (deliverables #5, #6).
 */
export function expandDocumentQuery(text: string): ExpandedQuery {
  const lower = text.toLowerCase();
  const tokens = new Set<string>();
  const episodes = new Map<string, { season: number | null; ep: number }>();

  // Plain content words — to_tsquery stems them; Postgres drops stopwords.
  let plain = 0;
  for (const w of lower.match(/[a-z0-9]+/g) ?? []) {
    if (plain >= MAX_PLAIN_TOKENS) break;
    if (w.length >= 2 || /^\d+$/.test(w)) {
      tokens.add(w);
      plain += 1;
    }
  }

  const addEpisode = (season: number | null, ep: number): void => {
    if (ep < 1 || ep > 999) return;
    const e2 = String(ep).padStart(2, '0');
    const s2 = String(season ?? 1).padStart(2, '0');
    tokens.add('episode');
    tokens.add(String(ep));
    tokens.add(`e${e2}`);
    tokens.add(`s${s2}e${e2}`);
    if (season != null) {
      tokens.add('season');
      tokens.add(String(season));
    }
    // Keyed by episode number so "Episode 1" and "S01E01" don't double-count;
    // an explicit season wins over an inferred one.
    const key = `e${e2}`;
    const prior = episodes.get(key);
    episodes.set(key, { season: season ?? prior?.season ?? null, ep });
  };

  // "episode one" / "season two" → digits, so the patterns below catch them.
  const normalized = lower.replace(
    /\b(episode|ep|season|s)\s+([a-z]+)\b/g,
    (m, kw, word) => (WORD_NUMBERS[word] ? `${kw} ${WORD_NUMBERS[word]}` : m),
  );

  // Most specific first. S01E01 / S1E1.
  for (const m of normalized.matchAll(/\bs(\d{1,2})e(\d{1,3})\b/g)) {
    addEpisode(Number(m[1]), Number(m[2]));
  }
  // Season X … Episode Y (same clause).
  for (const m of normalized.matchAll(/\bseason\s*(\d{1,2})\b[^.\n]*?\bep(?:isode)?\.?\s*(\d{1,3})\b/g)) {
    addEpisode(Number(m[1]), Number(m[2]));
  }
  // Episode Y / Ep Y / Ep.Y (no season).
  for (const m of normalized.matchAll(/\bep(?:isode)?\.?\s*(\d{1,3})\b/g)) {
    addEpisode(null, Number(m[1]));
  }
  // Bare E01 / E1.
  for (const m of normalized.matchAll(/\be(\d{1,3})\b/g)) {
    addEpisode(null, Number(m[1]));
  }

  const episodePatterns = [...episodes.values()].map(
    (e) => `%S${String(e.season ?? 1).padStart(2, '0')}E${String(e.ep).padStart(2, '0')}%`,
  );

  return { tsquery: [...tokens].join(' | '), episodePatterns };
}

/**
 * The retrieval read (invariant I1). Expands the task brief (OR + episode
 * normalization), ranks this project's chunks with ts_rank, and boosts chunks
 * from a document whose filename matches a referenced episode so a request for
 * "Episode 1" pulls the whole S01E01 material — not just whichever chunk
 * happens to repeat the words. Like loadApprovedContext it re-asserts tenancy
 * on every row and treats a mismatch as a fire alarm — this is a prompt-feeding
 * read, so isolation is enforced in depth, not just by the WHERE clause + RLS.
 */
export async function retrieveRelevant(
  tx: DbTx,
  ctx: TenantContext,
  queryText: string,
  limit = 5,
): Promise<RetrievedChunk[]> {
  const { tsquery, episodePatterns } = expandDocumentQuery(queryText);
  if (tsquery.length === 0) return [];

  const q = sql`to_tsquery('english', ${tsquery})`;
  // OR of per-pattern ILIKEs; constant false when no episode was referenced
  // (an empty ANY(...) is a SQL syntax error, and Drizzle inlines arrays as
  // IN-lists rather than a single array param).
  const filenameMatch =
    episodePatterns.length === 0
      ? sql`false`
      : sql.join(
          episodePatterns.map((p) => sql`${documents.relativePath} ilike ${p}`),
          sql` or `,
        );

  const rows = await tx
    .select({
      documentId: documentChunks.documentId,
      relativePath: documents.relativePath,
      chunkIndex: documentChunks.chunkIndex,
      content: documentChunks.content,
      indexedAt: documents.indexedAt,
      orgId: documentChunks.orgId,
      projectId: documentChunks.projectId,
      rank: sql<number>`ts_rank(document_chunks.search, ${q})`,
      episodeHit: sql<boolean>`(${filenameMatch})`,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .where(
      and(
        eq(documentChunks.projectId, ctx.projectId),
        eq(documentChunks.orgId, ctx.orgId),
        eq(documents.status, 'active'),
        sql`(document_chunks.search @@ ${q} or ${filenameMatch})`,
      ),
    )
    .orderBy(
      sql`(case when ${filenameMatch} then 1 else 0 end) desc`,
      sql`ts_rank(document_chunks.search, ${q}) desc`,
    )
    .limit(limit);

  for (const r of rows) {
    if (r.projectId !== ctx.projectId || r.orgId !== ctx.orgId) {
      log.error('TENANT VIOLATION in retrieveRelevant', {
        expectedProject: ctx.projectId,
        gotProject: r.projectId,
      });
      throw new TenantViolationError(
        `Document chunk from project ${r.projectId} surfaced for ${ctx.projectId}`,
      );
    }
  }

  return rows.map((r) => ({
    documentId: r.documentId,
    relativePath: r.relativePath,
    chunkIndex: r.chunkIndex,
    content: r.content,
    rank: Number(r.rank),
    indexedAt: r.indexedAt,
  }));
}

/**
 * Foundational workspace references, in priority order (O-14). Filename
 * regexes are deterministic and explainable — no embeddings. The core quota
 * reserves 1–2 of these so an "Episode 1" retrieval that fills every slot with
 * episode-specific docs still carries the canon the review should honour.
 */
export const CORE_REFERENCE_TYPES: ReadonlyArray<{ name: string; test: RegExp }> = [
  { name: 'Character Bible', test: /character[ _-]?bible/i },
  { name: 'Story Bible', test: /story[ _-]?bible/i },
  { name: 'Dialogue Bible', test: /dialogue[ _-]?bible/i },
  { name: 'Character Arc Tracker', test: /character[ _-]?arc[ _-]?tracker/i },
];
// POSIX alternation for the DB pre-filter; JS RegExps above assign priority.
const CORE_REFERENCE_POSIX =
  '(character[ _-]?bible|story[ _-]?bible|dialogue[ _-]?bible|character[ _-]?arc[ _-]?tracker)';
// Specific on purpose: matches "Season1_Production_Status", not an unrelated
// "...event-as-status" file that merely ends in "status".
const PRODUCTION_STATUS_POSIX = 'production[ _-]?status';

export interface CoreReferenceChunk extends RetrievedChunk {
  /** Which foundational type this is, for the manifest detail. */
  coreType: string;
}

function coreTypeOf(relativePath: string): string {
  return CORE_REFERENCE_TYPES.find((t) => t.test.test(relativePath))?.name ?? 'Core reference';
}

/** Shared tenancy re-assertion for the prompt-feeding document reads (I1). */
function assertTenant(
  rows: ReadonlyArray<{ orgId: string; projectId: string }>,
  ctx: TenantContext,
  where: string,
): void {
  for (const r of rows) {
    if (r.projectId !== ctx.projectId || r.orgId !== ctx.orgId) {
      log.error(`TENANT VIOLATION in ${where}`, {
        expectedProject: ctx.projectId,
        gotProject: r.projectId,
      });
      throw new TenantViolationError(
        `Document chunk from project ${r.projectId} surfaced for ${ctx.projectId}`,
      );
    }
  }
}

/**
 * Selects up to `limit` foundational reference documents NOT already present
 * in the retrieved set (dedup, requirement #3). One representative chunk
 * (chunk 0, the overview) per document. Deterministic: ordered by the priority
 * of CORE_REFERENCE_TYPES, then path. Tenant-scoped + I1 re-assertion.
 */
export async function selectCoreReferences(
  tx: DbTx,
  ctx: TenantContext,
  exclude: ReadonlySet<string>,
  limit = 2,
): Promise<CoreReferenceChunk[]> {
  const rows = await tx
    .select({
      documentId: documentChunks.documentId,
      relativePath: documents.relativePath,
      chunkIndex: documentChunks.chunkIndex,
      content: documentChunks.content,
      indexedAt: documents.indexedAt,
      orgId: documentChunks.orgId,
      projectId: documentChunks.projectId,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .where(
      and(
        eq(documentChunks.projectId, ctx.projectId),
        eq(documentChunks.orgId, ctx.orgId),
        eq(documents.status, 'active'),
        eq(documentChunks.chunkIndex, 0),
        sql`${documents.relativePath} ~* ${CORE_REFERENCE_POSIX}`,
      ),
    );
  assertTenant(rows, ctx, 'selectCoreReferences');

  const priority = (p: string): number => {
    const i = CORE_REFERENCE_TYPES.findIndex((t) => t.test.test(p));
    return i === -1 ? CORE_REFERENCE_TYPES.length : i;
  };

  return rows
    .filter((r) => !exclude.has(r.relativePath))
    .sort((a, b) => priority(a.relativePath) - priority(b.relativePath) || a.relativePath.localeCompare(b.relativePath))
    .slice(0, limit)
    .map((r) => ({
      documentId: r.documentId,
      relativePath: r.relativePath,
      chunkIndex: r.chunkIndex,
      content: r.content,
      rank: 0,
      indexedAt: r.indexedAt,
      coreType: coreTypeOf(r.relativePath),
    }));
}

/**
 * Selects the workspace's production-status document (chunk 0) if one exists
 * and is not already retrieved. Optional by nature — returns null when absent.
 */
export async function selectProductionStatus(
  tx: DbTx,
  ctx: TenantContext,
  exclude: ReadonlySet<string>,
): Promise<RetrievedChunk | null> {
  const rows = await tx
    .select({
      documentId: documentChunks.documentId,
      relativePath: documents.relativePath,
      chunkIndex: documentChunks.chunkIndex,
      content: documentChunks.content,
      indexedAt: documents.indexedAt,
      orgId: documentChunks.orgId,
      projectId: documentChunks.projectId,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .where(
      and(
        eq(documentChunks.projectId, ctx.projectId),
        eq(documentChunks.orgId, ctx.orgId),
        eq(documents.status, 'active'),
        eq(documentChunks.chunkIndex, 0),
        sql`${documents.relativePath} ~* ${PRODUCTION_STATUS_POSIX}`,
      ),
    )
    .orderBy(documents.relativePath)
    .limit(1);
  assertTenant(rows, ctx, 'selectProductionStatus');

  const r = rows.find((row) => !exclude.has(row.relativePath));
  if (!r) return null;
  return {
    documentId: r.documentId,
    relativePath: r.relativePath,
    chunkIndex: r.chunkIndex,
    content: r.content,
    rank: 0,
    indexedAt: r.indexedAt,
  };
}

export interface DocumentListRow {
  id: string;
  relativePath: string;
  kind: DocumentKind;
  status: string;
  chunkCount: number;
  sizeBytes: number;
  indexedAt: Date | null;
}

export async function listDocuments(tx: DbTx, ctx: TenantContext): Promise<DocumentListRow[]> {
  return tx
    .select({
      id: documents.id,
      relativePath: documents.relativePath,
      kind: documents.kind,
      status: documents.status,
      chunkCount: documents.chunkCount,
      sizeBytes: documents.sizeBytes,
      indexedAt: documents.indexedAt,
    })
    .from(documents)
    .where(and(eq(documents.projectId, ctx.projectId), eq(documents.orgId, ctx.orgId)))
    .orderBy(desc(documents.status), documents.relativePath);
}
