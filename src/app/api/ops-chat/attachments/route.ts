import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError, RateLimitedError, toPublicMessage } from '@/lib/errors';
import { log } from '@/lib/log';
import { requireUser, requireTenant, listMyProjectsWithOrgRoles } from '@/domain/auth/guard';
import { getDb } from '@/db/client';
import { withUser } from '@/db/tenant';
import { consumeRateLimit } from '@/domain/usage/rate-limit';
import { serverEnv } from '@/lib/env.server';
import { getObjectStore } from '@/domain/documents/object-store';
import { sha256Of } from '@/domain/documents/upload-validation';
import { conversationExists, createConversation } from '@/domain/opschat/conversations';
import { ATTACHMENT_LIMITS } from '@/domain/opschat/attachment-limits';
import { classifyAttachment } from '@/domain/opschat/attachment-policy';
import { extractAttachmentText } from '@/domain/opschat/attachment-extract';
import { attachmentObjectKey, getAttachmentSummary, insertAttachment } from '@/domain/opschat/attachments';

/**
 * POST — upload ONE Ops Chat attachment (multipart: `file`, `conversationId`, optional `projectKey`).
 *
 * Owner-private: the row is user-scoped (RLS) and the body is stored in the shared object store under
 * `opschat/{userId}/…` — outside every workspace prefix, so it never enters a workspace library, run
 * retrieval, or orphan scan. Type and size are enforced by extension + content signature (the declared
 * MIME type is ignored). Text is extracted synchronously with time and character caps. Uploading
 * changes nothing else: an attachment is only DATA for a later owner message and can never create,
 * confirm, or execute a governed action.
 *
 * `projectKey` optionally associates the file with a workspace the caller ADMINISTERS (checked with the
 * normal tenant authority). It is metadata only — the attachment stays private to its owner.
 */

/** Multipart framing overhead allowed on top of the largest file before we refuse to parse. */
const MULTIPART_OVERHEAD = 64 * 1024;

const Fields = z.object({
  conversationId: z.string().uuid(),
  projectKey: z.string().trim().min(1).max(200).optional(),
});

export async function POST(req: Request): Promise<Response> {
  let userId: string;
  try {
    await requireUser();
    userId = (await listMyProjectsWithOrgRoles()).user.id;
  } catch (err) {
    return Response.json({ error: toPublicMessage(err) }, { status: err instanceof AppError && err.code === 'unauthenticated' ? 401 : 403 });
  }

  // Refuse an oversized body BEFORE buffering it.
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > ATTACHMENT_LIMITS.maxDocumentBytes + MULTIPART_OVERHEAD) {
    return Response.json({ error: 'The file is too large (max 10 MB for documents, 5 MB for images).' }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return Response.json({ error: 'Invalid upload.' }, { status: 400 });
  }
  const fields = Fields.safeParse({
    conversationId: form.get('conversationId'),
    projectKey: (form.get('projectKey') as string | null) || undefined,
  });
  const file = form.get('file');
  if (!fields.success || !(file instanceof File)) return Response.json({ error: 'Invalid upload.' }, { status: 400 });
  if (file.size > ATTACHMENT_LIMITS.maxDocumentBytes) {
    return Response.json({ error: 'The file is too large (max 10 MB for documents, 5 MB for images).' }, { status: 413 });
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  const classified = classifyAttachment(file.name, bytes);
  if (!classified.ok) return Response.json({ error: classified.error }, { status: classified.error.startsWith('The file is too large') ? 413 : 415 });

  try {
    // Optional workspace association — the caller must administer that workspace.
    let projectId: string | null = null;
    if (fields.data.projectKey) {
      const ctx = await requireTenant(fields.data.projectKey);
      if (ctx.projectRole !== 'admin') throw new AppError('forbidden', 'You can only associate files with workspaces you administer.');
      projectId = ctx.projectId;
    }

    // Bounded anti-abuse guard (uploads cost storage + parsing), then the conversation (idempotent
    // create by the client-minted id, exactly like the chat route; another user's id → 404).
    await getDb().transaction((tx) => consumeRateLimit(tx, `ops-chat-attach:user:${userId}`, serverEnv().RATE_LIMIT_RUNS_PER_MINUTE));
    const conversationId = fields.data.conversationId;
    const owned = await withUser({ userId }, async (tx) => {
      await createConversation(tx, userId, { id: conversationId });
      return conversationExists(tx, userId, conversationId);
    });
    if (!owned) return Response.json({ error: 'That conversation was not found.' }, { status: 404 });

    const extraction = await extractAttachmentText(classified.kind, bytes);
    const id = randomUUID();
    const sha256 = sha256Of(bytes);
    const objectKey = attachmentObjectKey(userId, id, sha256);
    // Store the original first: a failed row insert leaves only an unreferenced object outside every
    // workspace prefix (harmless), never a row pointing at a missing body.
    await (await getObjectStore()).put(objectKey, bytes, classified.mimeType);
    const summary = await withUser({ userId }, async (tx) => {
      await insertAttachment(tx, userId, {
        id,
        conversationId,
        projectId,
        filename: classified.filename,
        mimeType: classified.mimeType,
        kind: classified.kind,
        sizeBytes: bytes.byteLength,
        sha256,
        objectKey,
        status: extraction.status,
        error: extraction.error,
        extractedText: extraction.text,
        meta: extraction.meta,
      });
      return getAttachmentSummary(tx, userId, id);
    });
    return Response.json({ attachment: summary }, { status: 201 });
  } catch (err) {
    if (err instanceof RateLimitedError) return Response.json({ error: toPublicMessage(err) }, { status: 429 });
    if (err instanceof AppError) {
      const status = err.code === 'unauthenticated' ? 401 : err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400;
      return Response.json({ error: toPublicMessage(err) }, { status });
    }
    log.error('ops-chat attachment upload failed', { err });
    return Response.json({ error: 'The upload failed. Nothing was attached — try again.' }, { status: 500 });
  }
}
