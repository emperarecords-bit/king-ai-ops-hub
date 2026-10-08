import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant, withUser } from '@/db/tenant';
import { memberships, notificationEvents, notificationMessageEvents, notificationMessages, notificationPreferences, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { enqueueNotification } from '@/domain/notifications/enqueue';
import { routeDueNotifications } from '@/domain/notifications/router';
import { flushDueDigests } from '@/domain/notifications/digest';
import { updatePreferences } from '@/domain/notifications/preferences';
import { notificationsForOwner } from '@/domain/notifications/history';
import { type ProjectAccessRecord } from '@/db/system';

/**
 * Owner Notifications v1 PR2 — delivery against a real DB (RLS enforced). Proves fail-closed-by-default, the
 * immediate send path with a stable idempotency key, quiet-hours deferral (action_required) vs critical bypass,
 * idempotent routing (no double-send), in-app delivery status, and the digest batcher. The channel's network
 * call is a fake fetcher — no real email leaves. Skips when the disposable DB isn't reachable.
 */
process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: notificationMessages.id }).from(notificationMessages).limit(1);
  available = true;
} catch (err) {
  console.warn(`[notification-delivery.test] SKIPPING — db/schema not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let ownerId = '';
let ctx: TenantContext;
let projectRec: ProjectAccessRecord;
const ownerRoleMap = () => new Map<string, TenantContext['orgRole']>([[orgId, 'owner']]);

const LIVE_ENV = { NOTIFICATIONS_ENABLED: 'email', EMAIL_API_KEY: 'k', EMAIL_FROM: 'bot@test.local' };

function okFetcher(): { fetcher: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ id: 'msg_' + calls.length }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  ownerId = randomUUID();
  await db.insert(profiles).values({ id: ownerId, email: `owner-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = await db.insert(organizations).values({ name: 'Org', slug: `nd-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId: ownerId, role: 'owner' });
  const key = fixtureKey('nd');
  const p = await db.insert(projects).values({ orgId, key, name: 'Workspace' }).returning({ id: projects.id });
  const projectId = p[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId, userId: ownerId, role: 'admin' });
  ctx = { userId: ownerId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' };
  projectRec = { orgId, projectId, key, name: 'Workspace', projectRole: 'admin' } as ProjectAccessRecord;
});

async function enqueue(eventType: 'run_failed' | 'owner_question_raised', entityId: string): Promise<void> {
  await withTenant(ctx, (tx) => enqueueNotification(tx, ctx, { eventType, entityType: eventType === 'run_failed' ? 'run' : 'owner_question', entityId, title: `${eventType} ${entityId}`, body: 'body' }));
}
async function messagesForEvent(eventId: string) {
  return getSetupDb()
    .select({ status: notificationMessages.status, resultCode: notificationMessages.resultCode, idempotencyKey: notificationMessages.idempotencyKey })
    .from(notificationMessageEvents)
    .innerJoin(notificationMessages, eq(notificationMessages.id, notificationMessageEvents.messageId))
    .where(eq(notificationMessageEvents.eventId, eventId));
}
const eventId = async (entityId: string, eventType: string) =>
  (await getSetupDb().select({ id: notificationEvents.id }).from(notificationEvents).where(and(eq(notificationEvents.dedupeKey, `${eventType}:${eventType === 'run_failed' ? 'run' : 'owner_question'}:${entityId}`))).limit(1))[0]!.id;

describe('fail-closed by default', () => {
  it.runIf(available)('suppresses (never calls the provider) when notifications are not enabled', async () => {
    const rid = randomUUID();
    await enqueue('run_failed', rid);
    const { fetcher, calls } = okFetcher();
    const r = await routeDueNotifications({ env: {}, fetcher, now: () => new Date() });
    expect(r.suppressed).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(0);
    const msgs = await messagesForEvent(await eventId(rid, 'run_failed'));
    expect(msgs[0]!.status).toBe('suppressed');
    expect(msgs[0]!.resultCode).toBe('not_enabled');
  });
});

describe('immediate send', () => {
  it.runIf(available)('sends a critical event when the channel is live, with a stable idempotency key', async () => {
    const rid = randomUUID();
    await enqueue('run_failed', rid);
    const { fetcher, calls } = okFetcher();
    const r = await routeDueNotifications({ env: LIVE_ENV, fetcher, now: () => new Date() });
    expect(r.sent).toBeGreaterThanOrEqual(1);
    expect(calls).toHaveLength(1);
    const evId = await eventId(rid, 'run_failed');
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe(`email:${evId}`);
    const msgs = await messagesForEvent(evId);
    expect(msgs[0]!.status).toBe('sent');
  });

  it.runIf(available)('is idempotent — a second route does not re-send', async () => {
    const rid = randomUUID();
    await enqueue('run_failed', rid);
    const first = okFetcher();
    await routeDueNotifications({ env: LIVE_ENV, fetcher: first.fetcher, now: () => new Date() });
    expect(first.calls).toHaveLength(1);
    const second = okFetcher();
    await routeDueNotifications({ env: LIVE_ENV, fetcher: second.fetcher, now: () => new Date() });
    expect(second.calls).toHaveLength(0); // already delivered — event is linked to a message
    const msgs = await messagesForEvent(await eventId(rid, 'run_failed'));
    expect(msgs).toHaveLength(1);
  });

  it.runIf(available)('surfaces the delivery status in-app history', async () => {
    const rid = randomUUID();
    await enqueue('run_failed', rid);
    const { fetcher } = okFetcher();
    await routeDueNotifications({ env: LIVE_ENV, fetcher, now: () => new Date() });
    const hist = await notificationsForOwner(ownerId, [projectRec], ownerRoleMap());
    const row = hist.find((n) => n.title === `run_failed ${rid}`);
    expect(row?.deliveryStatus).toBe('sent');
  });
});

describe('quiet hours', () => {
  it.runIf(available)('defers an action_required event during quiet hours; a critical event bypasses', async () => {
    const now = new Date('2026-01-01T03:00:00Z'); // inside a 22:00–07:00 UTC window
    await withUser({ userId: ownerId }, (tx) => updatePreferences(tx, ownerId, { timezone: 'UTC', quietHoursStartLocal: '22:00', quietHoursEndLocal: '07:00' }, now));

    const qid = randomUUID();
    await enqueue('owner_question_raised', qid);
    const q = okFetcher();
    const rq = await routeDueNotifications({ env: LIVE_ENV, fetcher: q.fetcher, now: () => now });
    expect(rq.deferred).toBeGreaterThanOrEqual(1);
    expect(q.calls).toHaveLength(0); // deferred — no message, left pending
    expect(await messagesForEvent(await eventId(qid, 'owner_question_raised'))).toHaveLength(0);

    const cid = randomUUID();
    await enqueue('run_failed', cid); // critical
    const c = okFetcher();
    await routeDueNotifications({ env: LIVE_ENV, fetcher: c.fetcher, now: () => now });
    expect(c.calls).toHaveLength(1); // critical bypasses quiet hours
    // Reset prefs so later suites aren't affected.
    await withUser({ userId: ownerId }, (tx) => updatePreferences(tx, ownerId, { quietHoursStartLocal: null, quietHoursEndLocal: null }, new Date()));
  });
});

describe('digest', () => {
  it.runIf(available)('batches due digest events into one message and advances the cursor', async () => {
    const now = new Date('2026-03-01T13:30:00Z');
    // Configure a digest schedule; set the cursor to the past so it is due.
    await withUser({ userId: ownerId }, (tx) => updatePreferences(tx, ownerId, { timezone: 'UTC', digestTimesLocal: ['08:00', '18:00'] }, now));
    const db = getSetupDb();
    await db.update(notificationPreferences).set({ nextDigestAt: new Date('2026-03-01T13:00:00Z') }).where(eq(notificationPreferences.userId, ownerId));

    // Two digest-routed events (no v1 event type routes to digest, so insert directly). Capture their PKs.
    const ents = [randomUUID(), randomUUID()];
    const eventRows = await db
      .insert(notificationEvents)
      .values(ents.map((entityId, i) => ({ orgId, projectId: projectRec.projectId, recipientUserId: ownerId, eventType: 'run_completed' as const, severity: 'informational' as const, routing: 'digest' as const, title: `digest ${i}`, body: 'b', entityType: 'run', entityId, dedupeKey: `dg:${entityId}` })))
      .returning({ id: notificationEvents.id });
    const ids = eventRows.map((r) => r.id);

    const { fetcher } = okFetcher();
    const r = await flushDueDigests({ env: LIVE_ENV, fetcher, now: () => now });
    expect(r.sent).toBeGreaterThanOrEqual(1); // this owner (and possibly others in a shared DB) flushed
    // THIS owner's two events landed in exactly ONE message (the batch), and both point to the same one.
    const msg0 = await db.select({ messageId: notificationMessageEvents.messageId }).from(notificationMessageEvents).where(eq(notificationMessageEvents.eventId, ids[0]!));
    const msg1 = await db.select({ messageId: notificationMessageEvents.messageId }).from(notificationMessageEvents).where(eq(notificationMessageEvents.eventId, ids[1]!));
    expect(msg0).toHaveLength(1);
    expect(msg1).toHaveLength(1);
    expect(msg0[0]!.messageId).toBe(msg1[0]!.messageId); // one digest batch for both events
    const batch = (await db.select({ status: notificationMessages.status, kind: notificationMessages.kind }).from(notificationMessages).where(eq(notificationMessages.id, msg0[0]!.messageId)))[0];
    expect(batch!.kind).toBe('digest');
    expect(batch!.status).toBe('sent');
    // Cursor advanced to a future instant.
    const prefRow = (await db.select({ next: notificationPreferences.nextDigestAt }).from(notificationPreferences).where(eq(notificationPreferences.userId, ownerId)))[0];
    expect(prefRow!.next!.getTime()).toBeGreaterThan(now.getTime());
  });
});
