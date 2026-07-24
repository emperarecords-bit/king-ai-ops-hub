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
}

/**
 * The retrieval read (invariant I1). Ranks this project's chunks against the
 * task text with ts_rank and returns the top K. Like loadApprovedContext it
 * re-asserts tenancy on every row and treats a mismatch as a fire alarm — this
 * is a prompt-feeding read, so isolation is enforced in depth, not just by the
 * WHERE clause and RLS.
 */
export async function retrieveRelevant(
  tx: DbTx,
  ctx: TenantContext,
  queryText: string,
  limit = 5,
): Promise<RetrievedChunk[]> {
  const cleaned = queryText.trim();
  if (cleaned.length === 0) return [];

  // websearch_to_tsquery tolerates arbitrary user text (no syntax errors on
  // punctuation), which matters because the "query" is a raw task brief.
  const rows = await tx
    .select({
      documentId: documentChunks.documentId,
      relativePath: documents.relativePath,
      chunkIndex: documentChunks.chunkIndex,
      content: documentChunks.content,
      orgId: documentChunks.orgId,
      projectId: documentChunks.projectId,
      rank: sql<number>`ts_rank(document_chunks.search, websearch_to_tsquery('english', ${cleaned}))`,
    })
    .from(documentChunks)
    .innerJoin(documents, eq(documentChunks.documentId, documents.id))
    .where(
      and(
        eq(documentChunks.projectId, ctx.projectId),
        eq(documentChunks.orgId, ctx.orgId),
        eq(documents.status, 'active'),
        sql`document_chunks.search @@ websearch_to_tsquery('english', ${cleaned})`,
      ),
    )
    .orderBy(sql`ts_rank(document_chunks.search, websearch_to_tsquery('english', ${cleaned})) desc`)
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
  }));
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
