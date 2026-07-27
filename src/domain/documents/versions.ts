import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { type ContentFidelity, type DocumentIndexStatus, type KnowledgeDisclosure, type TenantContext } from '@/types/domain';
import { AppError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { documentChunks, documentVersions, documents } from '@/db/schema';
import { type ObjectStore, tenantObjectKey } from './object-store';

/**
 * The immutable-version ingestion SERVICE (Documents increment 1, Stage B). One narrow path creates
 * versions, retains their exact bytes under a content-addressed key, builds version-specific chunks, and
 * repoints the logical Document's current version — enforcing the Stage B invariants:
 *  - same content → reuse the version (no dup rows, no dup bytes, no rewrite of immutable facts);
 *  - changed content → a NEW immutable version + a NEW object;
 *  - a failed parse → the version is retained (bytes + error) but never becomes current;
 *  - the current pointer only ever references an INDEXED version of the SAME document + workspace.
 * A DB trigger (`app.document_version_guard`) is the hard backstop for content-metadata immutability;
 * this service is the only code that writes versions, and exposes no generic "set arbitrary current".
 */

const PARSER_VERSION = 'chunk-v1';

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Content-addressed, tenant-partitioned, immutable version object key. Built only from trusted ctx. */
export function versionObjectKey(ctx: TenantContext, documentId: string, sha256: string): string {
  return tenantObjectKey({ orgId: ctx.orgId, projectId: ctx.projectId, sourceId: documentId, versionHash: sha256 });
}

/**
 * Ensure the immutable content object exists holding EXACTLY these bytes. Idempotent: a retry reuses the
 * object; an existing object whose bytes hash differently is a key collision and fails safely (never
 * overwritten). Object storage isn't transactional, so this is safe to re-run after a DB failure.
 */
async function ensureObject(store: ObjectStore, key: string, bytes: Buffer, sha256: string, mimeType: string): Promise<void> {
  const head = await store.head(key).catch(() => null);
  if (head) {
    const existing = await store.get(key);
    if (sha256Hex(existing) !== sha256) {
      throw new AppError('conflict', `Object key collision: ${key} already holds different bytes.`);
    }
    return; // same bytes already retained — idempotent reuse
  }
  await store.put(key, bytes, mimeType);
}

export interface IngestVersionInput {
  documentId: string;
  /** The exact source bytes — read ONCE; hash, retention, and parsing all derive from these same bytes. */
  bytes: Buffer;
  /** The same bytes decoded for parsing (caller decodes once from `bytes`). */
  text: string;
  mimeType: string;
  /** Current logical-document disclosure → recorded as the version's immutable ingest snapshot. */
  disclosure: KnowledgeDisclosure;
  sourceRevisionId?: string | null;
  sourceModifiedAt?: Date | null;
  ingestionOperationId?: string | null;
  /** The parser: text → ordered chunk strings. A throw here marks the version failed (bytes retained). */
  chunk: (text: string) => string[];
}

export interface IngestVersionResult {
  versionId: string;
  reused: boolean;
  indexStatus: DocumentIndexStatus;
  contentFidelity: ContentFidelity;
}

/**
 * Ingest one observed source state of a logical Document as an immutable version. Establishes the
 * workspace from trusted ctx (never from the caller's key), enforces same-content idempotency, retains
 * exact bytes, builds version chunks, and repoints current only on a successful index.
 */
export async function ingestDocumentVersion(tx: DbTx, ctx: TenantContext, store: ObjectStore, input: IngestVersionInput): Promise<IngestVersionResult> {
  const doc = (
    await tx
      .select({ id: documents.id })
      .from(documents)
      .where(and(eq(documents.id, input.documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)))
      .limit(1)
  )[0];
  if (!doc) throw new AppError('not_found', 'Document not found in this workspace.');

  const sha = sha256Hex(input.bytes);
  const key = versionObjectKey(ctx, input.documentId, sha);

  // SAME CONTENT → reuse. Never rewrite the immutable version, never duplicate chunks; re-put bytes only
  // if the immutable object is missing/failing verification. Update only lastSeenAt on the logical doc.
  const existing = (
    await tx
      .select({ id: documentVersions.id, indexStatus: documentVersions.indexStatus, contentFidelity: documentVersions.contentFidelity })
      .from(documentVersions)
      .where(and(eq(documentVersions.documentId, input.documentId), eq(documentVersions.sha256, sha), eq(documentVersions.orgId, ctx.orgId), eq(documentVersions.projectId, ctx.projectId)))
      .limit(1)
  )[0];
  if (existing) {
    await ensureObject(store, key, input.bytes, sha, input.mimeType);
    await tx.update(documents).set({ lastSeenAt: new Date(), updatedAt: new Date() }).where(and(eq(documents.id, input.documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));
    return { versionId: existing.id, reused: true, indexStatus: existing.indexStatus, contentFidelity: existing.contentFidelity };
  }

  // CHANGED / NEW → write the immutable object first (idempotent), then the version + chunks.
  await ensureObject(store, key, input.bytes, sha, input.mimeType);
  const inserted = await tx
    .insert(documentVersions)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      documentId: input.documentId,
      sha256: sha,
      sizeBytes: input.bytes.length,
      mimeType: input.mimeType,
      objectKey: key,
      contentFidelity: 'byte_exact', // bytes retained + verified above
      disclosureSnapshot: input.disclosure,
      sourceRevisionId: input.sourceRevisionId ?? null,
      sourceModifiedAt: input.sourceModifiedAt ?? null,
      ingestedAt: new Date(),
      indexStatus: 'pending',
      parserVersion: PARSER_VERSION,
      ingestionOperationId: input.ingestionOperationId ?? null,
    })
    .returning({ id: documentVersions.id });
  const versionId = inserted[0]!.id;

  // Parse the SAME bytes. A parse failure keeps the version (bytes + error) and does NOT become current.
  let chunks: string[];
  try {
    chunks = input.chunk(input.text);
  } catch (err) {
    await tx.update(documentVersions).set({ indexStatus: 'failed', errorMessage: err instanceof Error ? err.message.slice(0, 2000) : String(err) }).where(eq(documentVersions.id, versionId));
    await tx.update(documents).set({ lastSeenAt: new Date(), updatedAt: new Date() }).where(and(eq(documents.id, input.documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));
    return { versionId, reused: false, indexStatus: 'failed', contentFidelity: 'byte_exact' };
  }
  if (chunks.length > 0) {
    await tx.insert(documentChunks).values(
      chunks.map((content, i) => ({
        orgId: ctx.orgId,
        projectId: ctx.projectId,
        documentId: input.documentId,
        documentVersionId: versionId,
        chunkIndex: i,
        content,
        parserVersion: PARSER_VERSION,
        contentHash: sha256Hex(Buffer.from(content, 'utf8')),
      })),
    );
  }
  await tx.update(documentVersions).set({ indexStatus: 'indexed', indexedAt: new Date() }).where(eq(documentVersions.id, versionId));
  await setCurrentVersion(tx, ctx, input.documentId, versionId);
  await tx.update(documents).set({ lastSeenAt: new Date(), updatedAt: new Date() }).where(and(eq(documents.id, input.documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));
  return { versionId, reused: false, indexStatus: 'indexed', contentFidelity: 'byte_exact' };
}

/**
 * Repoint a logical Document's current version — the ONLY way `currentVersionId` is set. Validates the
 * version belongs to that document AND workspace AND is `indexed`. There is no generic update that could
 * assign an arbitrary or cross-tenant version id.
 */
export async function setCurrentVersion(tx: DbTx, ctx: TenantContext, documentId: string, versionId: string): Promise<void> {
  const v = (
    await tx
      .select({ documentId: documentVersions.documentId, orgId: documentVersions.orgId, projectId: documentVersions.projectId, indexStatus: documentVersions.indexStatus })
      .from(documentVersions)
      .where(eq(documentVersions.id, versionId))
      .limit(1)
  )[0];
  if (!v || v.orgId !== ctx.orgId || v.projectId !== ctx.projectId) throw new AppError('validation', 'That version is not in this workspace.');
  if (v.documentId !== documentId) throw new AppError('validation', 'That version belongs to a different document.');
  if (v.indexStatus !== 'indexed') throw new AppError('validation', 'Only a successfully-indexed version may become current.');
  await tx
    .update(documents)
    .set({ currentVersionId: versionId, updatedAt: new Date() })
    .where(and(eq(documents.id, documentId), eq(documents.orgId, ctx.orgId), eq(documents.projectId, ctx.projectId)));
}
