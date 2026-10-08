import 'server-only';
import { sql } from 'drizzle-orm';
import { notificationEvents } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { writeAudit } from '@/domain/audit/audit';
import { log } from '@/lib/log';
import { type TenantContext } from '@/types/domain';
import { classifyNotification, notificationDedupeKey } from './severity';
import { type NotificationInput } from './types';

/**
 * Capture a notifiable event CO-TRANSACTIONALLY with the change that caused it. Call this immediately next to
 * the existing `writeAudit` at a lifecycle seam, passing the SAME `tx` — so an event row exists if and only if
 * its cause committed. This writes ONLY the event + its audit: it resolves the recipient (the workspace owner),
 * never reads preferences, and never performs network I/O. Delivery (email/digest) is materialized out-of-band
 * by the worker in a later increment; nothing sends here.
 *
 * Idempotent: a repeated incident collapses to one event via UNIQUE(org, project, recipient, dedupeKey). Returns
 * the new event id, or null when it was deduped or the org has no owner to notify. Never throws for a missing
 * owner — a notification must never be able to fail the run that triggered it (callers also wrap in try/catch).
 */
export async function enqueueNotification(
  tx: DbTx,
  ctx: TenantContext,
  input: NotificationInput,
): Promise<string | null> {
  const { severity, routing } = classifyNotification(input.eventType);
  const dedupeKey = notificationDedupeKey(input);

  // The recipient is the workspace OWNER, not the run author whose context we're in. Resolve via a SECURITY
  // DEFINER helper so it works even from a system-runner context that cannot read memberships cross-user.
  const res = await tx.execute(sql`select app.org_owner_user_id(${ctx.orgId}::uuid) as uid`);
  const recipientUserId = ((res as { rows?: Array<{ uid: string | null }> }).rows?.[0]?.uid) ?? null;
  if (!recipientUserId) return null;

  const inserted = await tx
    .insert(notificationEvents)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      recipientUserId,
      eventType: input.eventType,
      severity,
      routing,
      title: input.title.slice(0, 300),
      body: input.body.slice(0, 4000),
      entityType: input.entityType,
      entityId: input.entityId,
      dedupeKey,
    })
    .onConflictDoNothing({
      target: [
        notificationEvents.orgId,
        notificationEvents.projectId,
        notificationEvents.recipientUserId,
        notificationEvents.dedupeKey,
      ],
    })
    .returning({ id: notificationEvents.id });

  if (inserted.length === 0) return null; // already captured (deduped)
  const id = inserted[0]!.id;

  await writeAudit(tx, ctx, {
    action: 'notification.enqueued',
    entityType: 'notification',
    entityId: id,
    detail: {
      eventType: input.eventType,
      severity,
      routing,
      recipientUserId,
      subjectType: input.entityType,
      subjectId: input.entityId,
    },
  });
  return id;
}

/**
 * The seam-facing wrapper. A notification must NEVER be able to fail the run/approval/question that triggered it,
 * so the enqueue runs inside its own SAVEPOINT: a failure rolls the savepoint back (leaving the parent
 * transaction usable) and is swallowed with a warning. The event is simply dropped. Lifecycle seams call this,
 * never `enqueueNotification` directly.
 */
export async function enqueueNotificationSafe(
  tx: DbTx,
  ctx: TenantContext,
  input: NotificationInput,
): Promise<void> {
  try {
    await tx.transaction(async (sp) => {
      await enqueueNotification(sp, ctx, input);
    });
  } catch (err) {
    log.warn('notification enqueue failed (caller unaffected)', {
      eventType: input.eventType,
      errorClass: err instanceof Error ? err.name : 'unknown',
    });
  }
}
