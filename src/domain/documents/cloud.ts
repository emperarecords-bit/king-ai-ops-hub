import 'server-only';
import { and, eq, isNull } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { AppError } from '@/lib/errors';
import { log } from '@/lib/log';
import { type DbTx } from '@/db/client';
import { documentChunks, documentJobs, documents } from '@/db/schema';
import { writeAudit } from '@/domain/audit/audit';
import { chunkText } from './documents';
import { ingestDocumentVersion } from './versions';
import {
  type ObjectStore,
  ObjectNotFoundError,
  keyBelongsToTenant,
  tenantObjectKey,
} from './object-store';
import {
  UploadRejected,
  classifyUpload,
  normalizeFilename,
  safeDecodeUtf8,
  sha256Of,
} from './upload-validation';

/**
 * Cloud Project Library ingestion (O-23). A workspace can upload text/Markdown
 * files into managed object storage and have them indexed by the durable worker
 * — usable when the user's local machine is offline. Once `active`, a cloud
 * document is INDISTINGUISHABLE from a local-folder document to retrieval and to
 * a model run, except for the `source = 'cloud_upload'` provenance tag.
 *
 * Identity rule (documented): within a workspace, a cloud document's stable
 * source id is its normalized filename. Re-uploading the same filename updates
 * that document in place (a new version); it never creates a duplicate. A cloud
 * upload and a local-folder file that happen to share a name are DIFFERENT
 * sources (different adapter, partial-unique per adapter) and never merge.
 */

/** Indexing runs as a system operation scoped by (org, project); it has no human
 *  actor, so the tenant context uses the nil user id. Document RLS keys off
 *  (org, project) only, so this is sufficient and correct. */
export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

export interface UploadInput {
  rawFilename: string;
  declaredMime: string;
  bytes: Buffer;
  sourceModifiedAt?: Date | null;
}

export type UploadOutcome =
  | { result: 'queued'; documentId: string; status: 'uploaded' }
  | { result: 'unchanged'; documentId: string }
  | { result: 'unsupported'; documentId: string; reason: string };

/**
 * Validate + store + enqueue one uploaded file. Tenancy comes ONLY from `ctx`
 * (the authenticated server context) — never from upload metadata. Runs inside
 * the caller's tenant transaction; the object PUT happens first so a failed
 * store leaves no active row.
 */
export async function uploadDocument(
  tx: DbTx,
  ctx: TenantContext,
  store: ObjectStore,
  input: UploadInput,
): Promise<UploadOutcome> {
  const { filename, ext } = normalizeFilename(input.rawFilename);
  const sourceId = filename; // stable per-workspace source identity for cloud

  // Classify. Unsupported recognized types are RECORDED (status unsupported),
  // never stored or indexed — the user sees a clear result.
  let classification;
  try {
    classification = classifyUpload({
      ext,
      declaredMime: input.declaredMime,
      sizeBytes: input.bytes.length,
      bytes: input.bytes,
    });
  } catch (err) {
    if (err instanceof UploadRejected && err.unsupported) {
      const docId = await recordUnsupported(tx, ctx, sourceId, filename, input.bytes.length, err.reason);
      return { result: 'unsupported', documentId: docId, reason: err.reason };
    }
    throw err instanceof UploadRejected
      ? new AppError('validation', err.reason)
      : err;
  }

  const hash = sha256Of(input.bytes);

  const prior = (
    await tx
      .select({ id: documents.id, sha256: documents.sha256, status: documents.status })
      .from(documents)
      .where(
        and(
          eq(documents.projectId, ctx.projectId),
          eq(documents.orgId, ctx.orgId),
          eq(documents.source, 'cloud_upload'),
          eq(documents.sourceId, sourceId),
        ),
      )
      .limit(1)
  )[0];

  // Same source + same hash + already active ⇒ nothing to do (idempotent).
  if (prior && prior.sha256 === hash && prior.status === 'active') {
    return { result: 'unchanged', documentId: prior.id };
  }

  const objectKey = tenantObjectKey({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    sourceId,
    versionHash: hash,
  });
  // Store the immutable version object FIRST (idempotent — same key, same bytes).
  await store.put(objectKey, input.bytes, classification.mimeType);

  let documentId: string;
  if (prior) {
    // New version of an existing source: repoint metadata, keep the row id
    // (its provenance/identity), re-queue. Old chunks stay until the job
    // atomically replaces them (Test 3).
    await tx
      .update(documents)
      .set({
        relativePath: filename,
        kind: classification.kind,
        mimeType: classification.mimeType,
        sha256: hash,
        sizeBytes: input.bytes.length,
        objectKey,
        status: 'uploaded',
        errorMessage: null,
        sourceModifiedAt: input.sourceModifiedAt ?? null,
        ingestedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(documents.id, prior.id));
    documentId = prior.id;
  } else {
    const inserted = await tx
      .insert(documents)
      .values({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        source: 'cloud_upload',
        sourceId,
        relativePath: filename,
        kind: classification.kind,
        mimeType: classification.mimeType,
        sha256: hash,
        sizeBytes: input.bytes.length,
        objectKey,
        status: 'uploaded',
        sourceModifiedAt: input.sourceModifiedAt ?? null,
        ingestedAt: new Date(),
      })
      .returning({ id: documents.id });
    documentId = inserted[0]!.id;
  }

  await enqueueDocumentJob(tx, ctx, documentId);
  await tx.update(documents).set({ status: 'queued', updatedAt: new Date() }).where(eq(documents.id, documentId));
  await writeAudit(tx, ctx, {
    action: 'document.uploaded',
    entityType: 'document',
    entityId: documentId,
    detail: { source: 'cloud_upload', sizeBytes: input.bytes.length, hash: hash.slice(0, 12) },
  });
  return { result: 'queued', documentId, status: 'uploaded' };
}

async function recordUnsupported(
  tx: DbTx,
  ctx: TenantContext,
  sourceId: string,
  filename: string,
  sizeBytes: number,
  reason: string,
): Promise<string> {
  const prior = (
    await tx
      .select({ id: documents.id })
      .from(documents)
      .where(
        and(
          eq(documents.projectId, ctx.projectId),
          eq(documents.orgId, ctx.orgId),
          eq(documents.source, 'cloud_upload'),
          eq(documents.sourceId, sourceId),
        ),
      )
      .limit(1)
  )[0];
  if (prior) {
    await tx
      .update(documents)
      .set({ status: 'unsupported', errorMessage: reason, updatedAt: new Date() })
      .where(eq(documents.id, prior.id));
    return prior.id;
  }
  const inserted = await tx
    .insert(documents)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      source: 'cloud_upload',
      sourceId,
      relativePath: filename,
      kind: 'markdown', // placeholder; unsupported rows never enter retrieval
      sha256: '',
      sizeBytes,
      status: 'unsupported',
      errorMessage: reason,
    })
    .returning({ id: documents.id });
  return inserted[0]!.id;
}

/** Idempotent enqueue: the partial unique index (one live job per document)
 *  makes a duplicate live job impossible. */
export async function enqueueDocumentJob(tx: DbTx, ctx: TenantContext, documentId: string): Promise<void> {
  await tx
    .insert(documentJobs)
    .values({ orgId: ctx.orgId, projectId: ctx.projectId, documentId, status: 'queued' })
    .onConflictDoNothing();
}

/**
 * Replace a specific document with a new uploaded version (admin). Validates
 * ownership via ctx, keeps the document id, and re-queues indexing.
 */
export async function replaceDocument(
  tx: DbTx,
  ctx: TenantContext,
  store: ObjectStore,
  documentId: string,
  input: UploadInput,
): Promise<UploadOutcome> {
  const doc = await requireOwnedCloudDoc(tx, ctx, documentId);
  // Reuse the source id so the replacement updates in place regardless of the
  // new file's name.
  return uploadDocument(tx, ctx, store, { ...input, rawFilename: doc.sourceId ?? input.rawFilename });
}

/** Re-enqueue indexing for a failed/stuck cloud document (admin). Fail closed: only a genuinely retryable
 *  state (failed / source_unavailable) may be retried — a manually-constructed retry on a healthy active
 *  document is rejected, never silently re-queued. */
export async function retryDocument(tx: DbTx, ctx: TenantContext, documentId: string): Promise<void> {
  const doc = await requireOwnedCloudDoc(tx, ctx, documentId);
  if (doc.status !== 'failed' && doc.status !== 'source_unavailable') {
    throw new AppError('conflict', 'This document is not in a retryable state.');
  }
  if (!doc.objectKey) throw new AppError('validation', 'This document has no stored object to re-index.');
  await tx
    .update(documents)
    .set({ status: 'queued', errorMessage: null, updatedAt: new Date() })
    .where(eq(documents.id, documentId));
  await enqueueDocumentJob(tx, ctx, documentId);
  await writeAudit(tx, ctx, {
    action: 'document.retry',
    entityType: 'document',
    entityId: documentId,
    detail: {},
  });
}

// Archive is now an adapter-neutral lifecycle action — see `archiveDocument` / `restoreDocument` in
// documents.ts. A source's arrival channel (cloud vs local) does not redefine its lifecycle.

interface OwnedCloudDoc {
  id: string;
  sourceId: string | null;
  objectKey: string | null;
  sha256: string;
  status: string;
}

/** Server-side ownership + adapter check for a cloud document. Throws NotFound
 *  (not "forbidden") so another workspace's id is indistinguishable from a
 *  nonexistent one. */
async function requireOwnedCloudDoc(
  tx: DbTx,
  ctx: TenantContext,
  documentId: string,
): Promise<OwnedCloudDoc> {
  const row = (
    await tx
      .select({
        id: documents.id,
        sourceId: documents.sourceId,
        objectKey: documents.objectKey,
        sha256: documents.sha256,
        source: documents.source,
        status: documents.status,
      })
      .from(documents)
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.projectId, ctx.projectId),
          eq(documents.orgId, ctx.orgId),
        ),
      )
      .limit(1)
  )[0];
  if (!row || row.source !== 'cloud_upload') {
    throw new AppError('not_found', 'No such document in this workspace.');
  }
  return { id: row.id, sourceId: row.sourceId, objectKey: row.objectKey, sha256: row.sha256, status: row.status };
}

export interface IndexJobResult {
  status: 'active' | 'failed' | 'source_unavailable';
  chunkCount: number;
}

/**
 * The durable indexing step (runs in the worker under withTenant). Idempotent:
 * fetches the object, decodes text, replaces chunks wholesale (so a retry never
 * duplicates), and flips the document to `active`. A missing object →
 * `source_unavailable` (provenance retained). No AI provider is involved.
 */
export async function indexCloudDocument(
  tx: DbTx,
  ctx: TenantContext,
  store: ObjectStore,
  documentId: string,
): Promise<IndexJobResult> {
  const doc = (
    await tx
      .select({
        id: documents.id,
        objectKey: documents.objectKey,
        sha256: documents.sha256,
        status: documents.status,
        chunkCount: documents.chunkCount,
        mimeType: documents.mimeType,
        disclosure: documents.disclosure,
        sourceModifiedAt: documents.sourceModifiedAt,
      })
      .from(documents)
      .where(and(eq(documents.id, documentId), eq(documents.projectId, ctx.projectId), eq(documents.orgId, ctx.orgId)))
      .limit(1)
  )[0];
  if (!doc) throw new AppError('not_found', 'Document vanished before indexing.');

  // Idempotency: already active with chunks present ⇒ a duplicate delivery, skip.
  if (doc.status === 'active' && doc.chunkCount > 0) {
    return { status: 'active', chunkCount: doc.chunkCount };
  }
  if (!doc.objectKey || !keyBelongsToTenant(doc.objectKey, ctx)) {
    await failIndex(tx, documentId, 'missing or foreign object key');
    return { status: 'failed', chunkCount: 0 };
  }

  await tx.update(documents).set({ status: 'indexing', updatedAt: new Date() }).where(eq(documents.id, documentId));

  let bytes: Buffer;
  try {
    bytes = await store.get(doc.objectKey);
  } catch (err) {
    if (err instanceof ObjectNotFoundError) {
      await tx
        .update(documents)
        .set({ status: 'source_unavailable', errorMessage: 'stored object not found', updatedAt: new Date() })
        .where(eq(documents.id, documentId));
      return { status: 'source_unavailable', chunkCount: 0 };
    }
    await failIndex(tx, documentId, err instanceof Error ? err.message : 'object fetch failed');
    return { status: 'failed', chunkCount: 0 };
  }

  let text: string;
  try {
    text = safeDecodeUtf8(bytes);
  } catch {
    await failIndex(tx, documentId, 'content is not valid UTF-8 text');
    return { status: 'failed', chunkCount: 0 };
  }

  const chunks = chunkText(text);
  // Replace the legacy (null-version) chunk set atomically: within this tenant transaction, delete-all
  // then insert. A retry re-runs the same replacement — never duplicates (Test 5). The version-scoped
  // chunks are immutable and untouched here.
  await tx.delete(documentChunks).where(and(eq(documentChunks.documentId, documentId), isNull(documentChunks.documentVersionId)));
  if (chunks.length > 0) {
    await tx.insert(documentChunks).values(
      chunks.map((content, i) => ({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        documentId,
        chunkIndex: i,
        content,
      })),
    );
  }
  await tx
    .update(documents)
    .set({ status: 'active', chunkCount: chunks.length, errorMessage: null, indexedAt: new Date(), updatedAt: new Date() })
    .where(eq(documents.id, documentId));

  // Stage B dual-write: retain the EXACT bytes just fetched from storage as an immutable version, build
  // version chunks, and repoint current — using the same byte sequence that produced the legacy chunks.
  // A version-store hiccup is logged, not fatal, during the transition (retrieval is unchanged).
  try {
    await ingestDocumentVersion(tx, ctx, store, {
      documentId,
      bytes,
      text,
      mimeType: doc.mimeType ?? 'text/plain',
      disclosure: doc.disclosure,
      sourceModifiedAt: doc.sourceModifiedAt ?? null,
      chunk: chunkText,
    });
  } catch (verr) {
    log.warn('version dual-write failed (legacy cloud index unaffected)', { documentId, err: verr instanceof Error ? verr.message : verr });
  }

  await writeAudit(tx, ctx, {
    action: 'document.indexed',
    entityType: 'document',
    entityId: documentId,
    detail: { source: 'cloud_upload', chunks: chunks.length },
  });
  return { status: 'active', chunkCount: chunks.length };
}

async function failIndex(tx: DbTx, documentId: string, reason: string): Promise<void> {
  await tx
    .update(documents)
    .set({ status: 'failed', errorMessage: reason.slice(0, 500), updatedAt: new Date() })
    .where(eq(documents.id, documentId));
  log.warn('cloud document index failed', { documentId, reason });
}
