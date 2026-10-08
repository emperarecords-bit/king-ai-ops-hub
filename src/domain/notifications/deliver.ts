import 'server-only';
import { and, eq } from 'drizzle-orm';
import { notificationMessages, notificationMessageEvents } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { type NotificationDeliveryOutcome } from './channel-contract';
import { type NotificationMessageKind, type NotificationMessageStatus } from '@/types/domain';

/** Normalize a drizzle `execute` result (postgres-js returns a bare array; some drivers wrap as { rows }). */
export function resultRows<T>(result: unknown): T[] {
  const wrapped = (result as { rows?: T[] }).rows;
  if (Array.isArray(wrapped)) return wrapped;
  if (Array.isArray(result)) return result as T[];
  return [];
}

/** Map a channel outcome to the persisted message status. `blocked` (withheld before send) records as `suppressed`. */
export function outcomeToStatus(outcome: NotificationDeliveryOutcome): NotificationMessageStatus {
  switch (outcome) {
    case 'sent':
      return 'sent';
    case 'failed':
      return 'failed';
    case 'ambiguous':
      return 'ambiguous';
    case 'blocked':
      return 'suppressed';
  }
}

export interface MessageLink {
  readonly orgId: string;
  readonly projectId: string;
  readonly eventId: string;
}

/**
 * Insert one outbound message for a recipient and link its member event(s), idempotently. The unique
 * (recipient_user_id, idempotency_key) is the CLAIM token: concurrent workers racing the same event, only ONE
 * inserts the message (and thus sends) — the loser gets `claimed: false` and does nothing. Returns the message id
 * on a fresh insert, or null when another worker already owns it.
 */
export async function insertMessageWithLinks(
  tx: DbTx,
  input: {
    readonly recipientUserId: string;
    readonly kind: NotificationMessageKind;
    readonly status: NotificationMessageStatus;
    readonly idempotencyKey: string;
    readonly subject: string;
    readonly body: string;
    readonly attemptCount: number;
    readonly lastAttemptAt: Date | null;
    readonly resultCode: string | null;
    readonly resultDetail: Record<string, unknown>;
    readonly sentAt: Date | null;
    readonly links: readonly MessageLink[];
  },
): Promise<string | null> {
  const inserted = (
    await tx
      .insert(notificationMessages)
      .values({
        recipientUserId: input.recipientUserId,
        channel: 'email',
        kind: input.kind,
        status: input.status,
        idempotencyKey: input.idempotencyKey,
        subject: input.subject,
        body: input.body,
        attemptCount: input.attemptCount,
        lastAttemptAt: input.lastAttemptAt,
        resultCode: input.resultCode,
        resultDetail: input.resultDetail,
        sentAt: input.sentAt,
      })
      .onConflictDoNothing({ target: [notificationMessages.recipientUserId, notificationMessages.idempotencyKey] })
      .returning({ id: notificationMessages.id })
  )[0];
  if (!inserted) return null; // another worker already claimed this (recipient, key)
  for (const link of input.links) {
    await tx
      .insert(notificationMessageEvents)
      .values({ recipientUserId: input.recipientUserId, messageId: inserted.id, orgId: link.orgId, projectId: link.projectId, eventId: link.eventId })
      .onConflictDoNothing({ target: [notificationMessageEvents.messageId, notificationMessageEvents.eventId] });
  }
  return inserted.id;
}

/** Record the terminal outcome of a send onto a previously-claimed ('sending') message. */
export async function finalizeMessage(
  tx: DbTx,
  messageId: string,
  recipientUserId: string,
  patch: { status: NotificationMessageStatus; resultCode: string; detail: string; sentAt: Date | null },
): Promise<void> {
  await tx
    .update(notificationMessages)
    .set({ status: patch.status, resultCode: patch.resultCode, resultDetail: { detail: patch.detail }, sentAt: patch.sentAt, updatedAt: new Date() })
    .where(and(eq(notificationMessages.id, messageId), eq(notificationMessages.recipientUserId, recipientUserId)));
}
