import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import {
  auditLogs,
  memberships,
  notificationEvents,
  organizations,
  profiles,
  projectMembers,
  projects,
} from '@/db/schema';
import { enqueueNotification } from '@/domain/notifications/enqueue';
import { notificationsForOwner, markNotificationRead } from '@/domain/notifications/history';
import { NotFoundError } from '@/lib/errors';
import { type ProjectAccessRecord } from '@/db/system';

/**
 * Owner Notifications v1 — capture + recipient-safe reads against a real DB (RLS enforced). Proves: capture is
 * co-transactional and idempotent, the recipient is resolved to the ORG OWNER (not the inserting author), reads
 * and mark-read are gated to the recipient (a different admin cannot see or clear them), and events never leak
 * across tenants. Skips when the disposable DB isn't reachable (local dev without Docker Postgres).
 */
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: notificationEvents.id }).from(notificationEvents).limit(1);
  available = true;
} catch (err) {
  console.warn(`[notifications.test] SKIPPING — db/schema not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let ownerId = '';
let adminId = '';
let ownerCtx: TenantContext;
let adminCtx: TenantContext;
let projectRec: ProjectAccessRecord;
// A fully separate tenant, to prove cross-org isolation.
let otherCtx: TenantContext;
let otherProjectRec: ProjectAccessRecord;

const ownerRoleMap = () => new Map<string, TenantContext['orgRole']>([[orgId, 'owner']]);

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  ownerId = randomUUID();
  adminId = randomUUID();
  await db.insert(profiles).values([
    { id: ownerId, email: `owner-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' },
    { id: adminId, email: `admin-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Admin2' },
  ]);
  const org = await db.insert(organizations).values({ name: 'Org', slug: `nt-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  // Owner holds the org-owner membership (the notification recipient); admin2 is a plain member of the org…
  await db.insert(memberships).values([
    { orgId, userId: ownerId, role: 'owner' },
    { orgId, userId: adminId, role: 'member' },
  ]);
  const key = fixtureKey('nt');
  const p = await db.insert(projects).values({ orgId, key, name: 'Workspace' }).returning({ id: projects.id });
  const projectId = p[0]!.id;
  // …but both are ADMINS of the workspace (so both would normally see the inbox — recipient scoping must still split them).
  await db.insert(projectMembers).values([
    { orgId, projectId, userId: ownerId, role: 'admin' },
    { orgId, projectId, userId: adminId, role: 'admin' },
  ]);
  ownerCtx = { userId: ownerId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' };
  adminCtx = { userId: adminId, orgId, projectId, orgRole: 'member', projectRole: 'admin' };
  projectRec = { orgId, projectId, key, name: 'Workspace', projectRole: 'admin' } as ProjectAccessRecord;

  // A separate org/owner/project for isolation.
  const otherOwner = randomUUID();
  await db.insert(profiles).values({ id: otherOwner, email: `oth-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Other' });
  const org2 = await db.insert(organizations).values({ name: 'Other', slug: `nt2-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  const org2Id = org2[0]!.id;
  await db.insert(memberships).values({ orgId: org2Id, userId: otherOwner, role: 'owner' });
  const key2 = fixtureKey('nt2');
  const p2 = await db.insert(projects).values({ orgId: org2Id, key: key2, name: 'Other WS' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId: org2Id, projectId: p2[0]!.id, userId: otherOwner, role: 'admin' });
  otherCtx = { userId: otherOwner, orgId: org2Id, projectId: p2[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  otherProjectRec = { orgId: org2Id, projectId: p2[0]!.id, key: key2, name: 'Other WS', projectRole: 'admin' } as ProjectAccessRecord;
});

const input = (entityId: string) => ({
  eventType: 'run_failed' as const,
  entityType: 'run',
  entityId,
  title: 'A run failed',
  body: 'because reasons',
});

describe('enqueueNotification — capture', () => {
  it.runIf(available)('resolves the recipient to the org owner and writes a co-transactional audit', async () => {
    const runId = randomUUID();
    const id = await withTenant(ownerCtx, (tx) => enqueueNotification(tx, ownerCtx, input(runId)));
    expect(id).not.toBeNull();
    const row = await getSetupDb()
      .select({ recipientUserId: notificationEvents.recipientUserId, severity: notificationEvents.severity, routing: notificationEvents.routing })
      .from(notificationEvents)
      .where(eq(notificationEvents.id, id!));
    expect(row[0]!.recipientUserId).toBe(ownerId); // the OWNER, resolved by app.org_owner_user_id
    expect(row[0]!.severity).toBe('critical');
    expect(row[0]!.routing).toBe('immediate');
    const audit = await getSetupDb()
      .select({ id: auditLogs.id })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'notification'), eq(auditLogs.entityId, id!), eq(auditLogs.action, 'notification.enqueued')));
    expect(audit.length).toBe(1);
  });

  it.runIf(available)('is idempotent — the same incident collapses to one event', async () => {
    const runId = randomUUID();
    const first = await withTenant(ownerCtx, (tx) => enqueueNotification(tx, ownerCtx, input(runId)));
    const second = await withTenant(ownerCtx, (tx) => enqueueNotification(tx, ownerCtx, input(runId)));
    expect(first).not.toBeNull();
    expect(second).toBeNull(); // deduped
    const rows = await getSetupDb()
      .select({ id: notificationEvents.id })
      .from(notificationEvents)
      .where(eq(notificationEvents.dedupeKey, `run_failed:run:${runId}`));
    expect(rows.length).toBe(1);
  });
});

describe('recipient-safe reads', () => {
  it.runIf(available)('the owner sees their notifications; a co-admin who is not the recipient does not', async () => {
    const runId = randomUUID();
    await withTenant(ownerCtx, (tx) => enqueueNotification(tx, ownerCtx, input(runId)));
    const ownerSees = await notificationsForOwner(ownerId, [projectRec], ownerRoleMap());
    expect(ownerSees.some((n) => n.body === 'because reasons')).toBe(true);
    // admin2 administers the same workspace but is NOT the recipient → recipient-scoped RLS hides it.
    const adminSees = await notificationsForOwner(adminId, [projectRec], new Map([[orgId, 'member' as const]]));
    expect(adminSees.length).toBe(0);
  });

  it.runIf(available)('does not leak across tenants', async () => {
    const runId = randomUUID();
    await withTenant(ownerCtx, (tx) => enqueueNotification(tx, ownerCtx, input(runId)));
    const otherSees = await notificationsForOwner(otherCtx.userId, [otherProjectRec], new Map([[otherCtx.orgId, 'owner' as const]]));
    expect(otherSees.length).toBe(0);
  });
});

describe('app.org_owner_user_id — deterministic recipient (multi-owner safe)', () => {
  const uid = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;
  async function ownerOf(oid: string): Promise<string | null> {
    const res = await getSetupDb().execute(sql`select app.org_owner_user_id(${oid}::uuid) as uid`);
    const rows = (res as { rows?: Array<{ uid: string | null }> }).rows ?? (res as unknown as Array<{ uid: string | null }>);
    return (Array.isArray(rows) ? rows[0]?.uid : null) ?? null;
  }

  it.runIf(available)('breaks a created_at tie by the lowest user_id', async () => {
    const db = getSetupDb();
    const a = uid('0a');
    const b = uid('0b');
    await db.insert(profiles).values([
      { id: a, email: `a-${randomUUID().slice(0, 8)}@test.local`, displayName: 'A' },
      { id: b, email: `b-${randomUUID().slice(0, 8)}@test.local`, displayName: 'B' },
    ]);
    const org = await db.insert(organizations).values({ name: 'Multi', slug: `mo-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
    const oid = org[0]!.id;
    const ts = new Date('2026-01-01T00:00:00.000Z');
    // Two owners, SAME created_at → the user_id tiebreaker must decide (and decide the same way every call).
    await db.insert(memberships).values([
      { orgId: oid, userId: b, role: 'owner', createdAt: ts, updatedAt: ts },
      { orgId: oid, userId: a, role: 'owner', createdAt: ts, updatedAt: ts },
    ]);
    expect(await ownerOf(oid)).toBe(a); // lower user_id wins the tie
    expect(await ownerOf(oid)).toBe(a); // stable across calls
  });

  it.runIf(available)('prefers the earliest created_at over a lower user_id', async () => {
    const db = getSetupDb();
    const earlyHigh = uid('ff'); // higher user_id, but created first
    const lateLow = uid('01'); // lower user_id, but created later
    await db.insert(profiles).values([
      { id: earlyHigh, email: `eh-${randomUUID().slice(0, 8)}@test.local`, displayName: 'EH' },
      { id: lateLow, email: `ll-${randomUUID().slice(0, 8)}@test.local`, displayName: 'LL' },
    ]);
    const org = await db.insert(organizations).values({ name: 'Multi2', slug: `mo2-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
    const oid = org[0]!.id;
    await db.insert(memberships).values([
      { orgId: oid, userId: earlyHigh, role: 'owner', createdAt: new Date('2026-01-01T00:00:00.000Z'), updatedAt: new Date('2026-01-01T00:00:00.000Z') },
      { orgId: oid, userId: lateLow, role: 'owner', createdAt: new Date('2026-02-01T00:00:00.000Z'), updatedAt: new Date('2026-02-01T00:00:00.000Z') },
    ]);
    expect(await ownerOf(oid)).toBe(earlyHigh); // created_at is the primary key of the ordering
  });

  it.runIf(available)('returns null for an org with no owner (enqueue then skips, never fails a run)', async () => {
    const db = getSetupDb();
    const org = await db.insert(organizations).values({ name: 'NoOwner', slug: `no-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
    expect(await ownerOf(org[0]!.id)).toBeNull();
  });
});

describe('markNotificationRead — recipient-gated', () => {
  it.runIf(available)('the recipient can mark read; a non-recipient cannot', async () => {
    const runId = randomUUID();
    const id = await withTenant(ownerCtx, (tx) => enqueueNotification(tx, ownerCtx, input(runId)));
    // A non-recipient (admin2) is blocked by RLS → the update matches nothing → NotFound.
    await expect(withTenant(adminCtx, (tx) => markNotificationRead(tx, adminCtx, id!))).rejects.toBeInstanceOf(NotFoundError);
    // The recipient succeeds and the row is stamped read.
    await withTenant(ownerCtx, (tx) => markNotificationRead(tx, ownerCtx, id!));
    const row = await getSetupDb().select({ readAt: notificationEvents.readAt }).from(notificationEvents).where(eq(notificationEvents.id, id!));
    expect(row[0]!.readAt).not.toBeNull();
  });
});
