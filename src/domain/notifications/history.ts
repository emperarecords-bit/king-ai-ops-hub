import 'server-only';
import { and, desc, eq } from 'drizzle-orm';
import { notificationEvents, notificationMessageEvents, notificationMessages } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { writeAudit } from '@/domain/audit/audit';
import { NotFoundError } from '@/lib/errors';
import { type TenantContext } from '@/types/domain';
import { type ProjectAccessRecord } from '@/db/system';

/**
 * In-app notification history for the owner — the recipient-safe read half of the feature. Mirrors
 * `openQuestionsForOwner`: iterate the workspaces the caller ADMINISTERS and read under each workspace's RLS.
 * RLS additionally restricts rows to `recipient_user_id = app.current_user_id()`, so one admin never sees
 * another user's notifications; the explicit `recipientUserId` filter is the app-layer belt over that net.
 */
export interface OwnerNotification {
  readonly notificationId: string;
  readonly projectKey: string;
  readonly workspaceName: string;
  readonly eventType: string;
  readonly severity: string;
  readonly routing: string;
  readonly title: string;
  readonly body: string;
  readonly read: boolean;
  readonly createdAt: Date;
  /** Latest outbound delivery status for this event (null when nothing has been attempted / in_app_only). */
  readonly deliveryStatus: string | null;
  readonly deliveryResultCode: string | null;
}

const HISTORY_LIMIT_PER_WORKSPACE = 50;
const HISTORY_LIMIT_TOTAL = 100;

export async function notificationsForOwner(
  userId: string,
  projects_: readonly ProjectAccessRecord[],
  orgRoleByOrg: ReadonlyMap<string, TenantContext['orgRole']>,
): Promise<readonly OwnerNotification[]> {
  const items: OwnerNotification[] = [];
  for (const project of projects_.filter((p) => p.projectRole === 'admin')) {
    const ctx: TenantContext = {
      userId,
      orgId: project.orgId,
      projectId: project.projectId,
      orgRole: orgRoleByOrg.get(project.orgId) ?? 'member',
      projectRole: project.projectRole,
    };
    // LEFT JOIN the delivery ledger (messages are recipient-scoped; readable here because withTenant stamps the
    // owner's user id). An event may map to >1 message (e.g. an immediate + a later digest); keep the latest.
    const rows = await withTenant(ctx, (tx) =>
      tx
        .select({
          id: notificationEvents.id,
          eventType: notificationEvents.eventType,
          severity: notificationEvents.severity,
          routing: notificationEvents.routing,
          title: notificationEvents.title,
          body: notificationEvents.body,
          readAt: notificationEvents.readAt,
          createdAt: notificationEvents.createdAt,
          msgStatus: notificationMessages.status,
          msgResultCode: notificationMessages.resultCode,
          msgCreatedAt: notificationMessages.createdAt,
        })
        .from(notificationEvents)
        .leftJoin(notificationMessageEvents, eq(notificationMessageEvents.eventId, notificationEvents.id))
        .leftJoin(notificationMessages, eq(notificationMessages.id, notificationMessageEvents.messageId))
        .where(and(eq(notificationEvents.projectId, ctx.projectId), eq(notificationEvents.recipientUserId, userId)))
        .orderBy(desc(notificationEvents.createdAt))
        .limit(HISTORY_LIMIT_PER_WORKSPACE * 3),
    );
    const latestByEvent = new Map<string, (typeof rows)[number]>();
    for (const r of rows) {
      const prev = latestByEvent.get(r.id);
      if (!prev || (r.msgCreatedAt && (!prev.msgCreatedAt || r.msgCreatedAt > prev.msgCreatedAt))) latestByEvent.set(r.id, r);
    }
    for (const r of latestByEvent.values()) {
      items.push({
        notificationId: r.id,
        projectKey: project.key,
        workspaceName: project.name,
        eventType: r.eventType,
        severity: r.severity,
        routing: r.routing,
        title: r.title,
        body: r.body,
        read: r.readAt !== null,
        createdAt: r.createdAt,
        deliveryStatus: r.msgStatus ?? null,
        deliveryResultCode: r.msgResultCode ?? null,
      });
    }
  }
  items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  return items.slice(0, HISTORY_LIMIT_TOTAL);
}

/** Mark one of the OWN recipient's notifications read. RLS (update policy) gates it to the recipient; the
 *  explicit predicate matches, and a miss (not yours / not here) is a NotFound rather than a silent no-op. */
export async function markNotificationRead(tx: DbTx, ctx: TenantContext, notificationId: string): Promise<void> {
  const updated = await tx
    .update(notificationEvents)
    .set({ readAt: new Date(), updatedAt: new Date() })
    .where(
      and(
        eq(notificationEvents.id, notificationId),
        eq(notificationEvents.projectId, ctx.projectId),
        eq(notificationEvents.recipientUserId, ctx.userId),
      ),
    )
    .returning({ id: notificationEvents.id });
  if (updated.length === 0) throw new NotFoundError('Notification');
  await writeAudit(tx, ctx, {
    action: 'notification.read',
    entityType: 'notification',
    entityId: notificationId,
    detail: {},
  });
}
