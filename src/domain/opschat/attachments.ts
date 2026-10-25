import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { AppError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { opsChatAttachments, opsChatMessages } from '@/db/schema';
import { ATTACHMENT_LIMITS, type AttachmentKind, type AttachmentStatus } from './attachment-limits';
import { type PromptAttachment } from './attachment-policy';

/**
 * Ops Chat attachment persistence — owner-private, USER-scoped (RLS `user_id = current user`), like
 * the rest of the Ops Chat store. Every function must run inside `withUser({ userId })`; with the
 * GUC unset the policy fails closed. Rows hold METADATA + bounded extracted text only; the body lives
 * in the object store under `opschat/{userId}/{attachmentId}/{sha256}` (outside every workspace
 * prefix, so no workspace library, retrieval, or orphan scan ever sees it).
 *
 * Lifecycle: uploaded into a conversation (message_id null) → linked ONCE to the owner message that
 * sends it → immutable. There is no delete path: conversation history is never deleted.
 */

/** The per-user object-store prefix every attachment body lives under. */
export function attachmentObjectPrefix(userId: string): string {
  return `opschat/${userId}/`;
}

/** The object-store key for an attachment body. Built only from server-trusted ids. */
export function attachmentObjectKey(userId: string, attachmentId: string, sha256: string): string {
  return `${attachmentObjectPrefix(userId)}${attachmentId}/${sha256}`;
}

export interface NewAttachment {
  readonly id: string;
  readonly conversationId: string;
  readonly projectId: string | null;
  readonly filename: string;
  readonly mimeType: string;
  readonly kind: AttachmentKind;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly objectKey: string;
  readonly status: AttachmentStatus;
  readonly error: string | null;
  readonly extractedText: string | null;
  readonly meta: Record<string, unknown>;
}

export async function insertAttachment(tx: DbTx, userId: string, a: NewAttachment): Promise<void> {
  await tx.insert(opsChatAttachments).values({ ...a, userId, messageId: null });
}

/** Display metadata — never the extracted text. */
export interface AttachmentSummary {
  readonly id: string;
  readonly messageId: string | null;
  readonly filename: string;
  readonly mimeType: string;
  readonly kind: AttachmentKind;
  readonly sizeBytes: number;
  readonly status: AttachmentStatus;
  readonly error: string | null;
  readonly projectId: string | null;
  readonly meta: Record<string, unknown>;
}

const summaryCols = {
  id: opsChatAttachments.id,
  messageId: opsChatAttachments.messageId,
  filename: opsChatAttachments.filename,
  mimeType: opsChatAttachments.mimeType,
  kind: opsChatAttachments.kind,
  sizeBytes: opsChatAttachments.sizeBytes,
  status: opsChatAttachments.status,
  error: opsChatAttachments.error,
  projectId: opsChatAttachments.projectId,
  meta: opsChatAttachments.meta,
};

function toSummary(r: { [K in keyof typeof summaryCols]: unknown }): AttachmentSummary {
  return {
    id: r.id as string,
    messageId: (r.messageId as string | null) ?? null,
    filename: r.filename as string,
    mimeType: r.mimeType as string,
    kind: r.kind as AttachmentKind,
    sizeBytes: r.sizeBytes as number,
    status: r.status as AttachmentStatus,
    error: (r.error as string | null) ?? null,
    projectId: (r.projectId as string | null) ?? null,
    meta: (r.meta as Record<string, unknown>) ?? {},
  };
}

/**
 * Link uploaded attachments to the OWNER message that sends them — exactly once.
 *
 * Every id must be this user's attachment, in this conversation, and either still unlinked or already
 * linked to THIS message (an idempotent retry of the same send). Anything else — another user's id
 * (invisible under RLS), another conversation's, one already sent with a different message, or too
 * many — is a hard error and nothing is linked (the caller's transaction rolls back).
 */
export async function linkAttachmentsToMessage(
  tx: DbTx,
  userId: string,
  args: { conversationId: string; messageId: string; attachmentIds: readonly string[] },
): Promise<void> {
  const ids = [...new Set(args.attachmentIds)];
  if (ids.length === 0) return;
  if (ids.length > ATTACHMENT_LIMITS.maxPerMessage) {
    throw new AppError('validation', `A message can carry at most ${ATTACHMENT_LIMITS.maxPerMessage} attachments.`);
  }
  // The target must be an OWNER message in this conversation.
  const msg = await tx
    .select({ role: opsChatMessages.role })
    .from(opsChatMessages)
    .where(and(eq(opsChatMessages.id, args.messageId), eq(opsChatMessages.conversationId, args.conversationId), eq(opsChatMessages.userId, userId)))
    .limit(1);
  if (msg[0]?.role !== 'user') throw new AppError('not_found', 'That message was not found.');

  const rows = await tx
    .select({ id: opsChatAttachments.id, messageId: opsChatAttachments.messageId, conversationId: opsChatAttachments.conversationId })
    .from(opsChatAttachments)
    .where(and(inArray(opsChatAttachments.id, ids), eq(opsChatAttachments.userId, userId)));
  if (rows.length !== ids.length || rows.some((r) => r.conversationId !== args.conversationId)) {
    throw new AppError('not_found', 'An attachment was not found in this conversation.');
  }
  if (rows.some((r) => r.messageId !== null && r.messageId !== args.messageId)) {
    throw new AppError('conflict', 'An attachment was already sent with another message.');
  }
  const unlinked = rows.filter((r) => r.messageId === null).map((r) => r.id);
  if (unlinked.length === 0) return; // idempotent retry
  const updated = await tx
    .update(opsChatAttachments)
    .set({ messageId: args.messageId, updatedAt: new Date() })
    .where(
      and(
        inArray(opsChatAttachments.id, unlinked),
        eq(opsChatAttachments.userId, userId),
        eq(opsChatAttachments.conversationId, args.conversationId),
        isNull(opsChatAttachments.messageId),
      ),
    )
    .returning({ id: opsChatAttachments.id });
  if (updated.length !== unlinked.length) throw new AppError('conflict', 'An attachment was already sent with another message.');
}

/** Attachment summaries for a set of messages (the display window), grouped by message id. */
export async function attachmentsForMessages(
  tx: DbTx,
  userId: string,
  conversationId: string,
  messageIds: readonly string[],
): Promise<Map<string, AttachmentSummary[]>> {
  const out = new Map<string, AttachmentSummary[]>();
  if (messageIds.length === 0) return out;
  const rows = await tx
    .select(summaryCols)
    .from(opsChatAttachments)
    .where(and(eq(opsChatAttachments.userId, userId), eq(opsChatAttachments.conversationId, conversationId), inArray(opsChatAttachments.messageId, [...messageIds])))
    .orderBy(asc(opsChatAttachments.createdAt), asc(opsChatAttachments.id));
  for (const r of rows) {
    const s = toSummary(r);
    const list = out.get(s.messageId!) ?? [];
    list.push(s);
    out.set(s.messageId!, list);
  }
  return out;
}

/** What the download route needs to serve an original (this user's only). */
export async function getAttachmentObject(
  tx: DbTx,
  userId: string,
  attachmentId: string,
): Promise<{ filename: string; mimeType: string; kind: AttachmentKind; objectKey: string } | null> {
  const rows = await tx
    .select({ filename: opsChatAttachments.filename, mimeType: opsChatAttachments.mimeType, kind: opsChatAttachments.kind, objectKey: opsChatAttachments.objectKey })
    .from(opsChatAttachments)
    .where(and(eq(opsChatAttachments.id, attachmentId), eq(opsChatAttachments.userId, userId)))
    .limit(1);
  const r = rows[0];
  return r ? { ...r, kind: r.kind as AttachmentKind } : null;
}

/** One attachment summary (this user's only). */
export async function getAttachmentSummary(tx: DbTx, userId: string, attachmentId: string): Promise<AttachmentSummary | null> {
  const rows = await tx.select(summaryCols).from(opsChatAttachments).where(and(eq(opsChatAttachments.id, attachmentId), eq(opsChatAttachments.userId, userId))).limit(1);
  return rows[0] ? toSummary(rows[0]) : null;
}

export interface PromptAttachmentRow extends PromptAttachment {
  readonly messageId: string | null;
  readonly mimeType: string;
  readonly objectKey: string;
}

const promptCols = {
  id: opsChatAttachments.id,
  messageId: opsChatAttachments.messageId,
  filename: opsChatAttachments.filename,
  kind: opsChatAttachments.kind,
  mimeType: opsChatAttachments.mimeType,
  sizeBytes: opsChatAttachments.sizeBytes,
  status: opsChatAttachments.status,
  extractedText: opsChatAttachments.extractedText,
  meta: opsChatAttachments.meta,
  objectKey: opsChatAttachments.objectKey,
};

function toPromptRow(r: { [K in keyof typeof promptCols]: unknown }): PromptAttachmentRow {
  return {
    id: r.id as string,
    messageId: (r.messageId as string | null) ?? null,
    filename: r.filename as string,
    kind: r.kind as AttachmentKind,
    mimeType: r.mimeType as string,
    sizeBytes: r.sizeBytes as number,
    status: r.status as AttachmentStatus,
    extractedText: (r.extractedText as string | null) ?? null,
    meta: (r.meta as PromptAttachment['meta']) ?? {},
    objectKey: r.objectKey as string,
  };
}

/** Prompt rows (WITH extracted text) for the given owner messages in one conversation. */
export async function promptAttachmentsForMessages(
  tx: DbTx,
  userId: string,
  conversationId: string,
  messageIds: readonly string[],
): Promise<Map<string, PromptAttachmentRow[]>> {
  const out = new Map<string, PromptAttachmentRow[]>();
  if (messageIds.length === 0) return out;
  const rows = await tx
    .select(promptCols)
    .from(opsChatAttachments)
    .where(and(eq(opsChatAttachments.userId, userId), eq(opsChatAttachments.conversationId, conversationId), inArray(opsChatAttachments.messageId, [...messageIds])))
    .orderBy(asc(opsChatAttachments.createdAt), asc(opsChatAttachments.id));
  for (const r of rows) {
    const p = toPromptRow(r);
    const list = out.get(p.messageId!) ?? [];
    list.push(p);
    out.set(p.messageId!, list);
  }
  return out;
}

/**
 * One SENT attachment of this user (with text), for the read_attachment tool. Restricted to a
 * conversation when given; unsent uploads (message_id null) are not readable by the model.
 */
export async function getPromptAttachment(
  tx: DbTx,
  userId: string,
  attachmentId: string,
  conversationId?: string,
): Promise<PromptAttachmentRow | null> {
  const rows = await tx
    .select(promptCols)
    .from(opsChatAttachments)
    .where(
      and(
        eq(opsChatAttachments.id, attachmentId),
        eq(opsChatAttachments.userId, userId),
        ...(conversationId ? [eq(opsChatAttachments.conversationId, conversationId)] : []),
      ),
    )
    .limit(1);
  const r = rows[0] ? toPromptRow(rows[0]) : null;
  return r && r.messageId ? r : null;
}
