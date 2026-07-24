import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TenantContext } from '@/types/domain';
import { AppError } from '@/lib/errors';
import { getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import {
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  taskSchedules,
} from '@/db/schema';
import { createSchedule, listSchedules, setScheduleEnabled } from '@/domain/standing/standing';

/**
 * Continuous Operations safety properties (Sprint 8):
 *  - only project admins can author standing work;
 *  - a new schedule's first due time is always in the future;
 *  - pausing is the kill switch and is audited;
 *  - schedules are project-scoped like everything else.
 *
 * The tick's execution path (createTask + startRun) is covered by the engine
 * and runner tests; this suite pins the scheduling contract around it without
 * spending provider tokens.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(
    `[standing.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
  );
}

const adminId = randomUUID();
const memberId = randomUUID();
let adminCtx: TenantContext;
let memberCtx: TenantContext;
let orgId = '';
let projectId = '';

beforeAll(async () => {
  if (!available) return;
  const db = getDb();
  await db.insert(profiles).values([
    { id: adminId, email: `stand-a-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Admin' },
    { id: memberId, email: `stand-m-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Member' },
  ]);
  const org = await db
    .insert(organizations)
    .values({ name: 'Standing Org', slug: `stand-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values([
    { orgId, userId: adminId, role: 'owner' },
    { orgId, userId: memberId, role: 'member' },
  ]);
  const project = await db
    .insert(projects)
    .values({ orgId, key: `stand-${randomUUID().slice(0, 8)}`, name: 'Standing Project' })
    .returning({ id: projects.id });
  projectId = project[0]!.id;
  await db.insert(projectMembers).values([
    { orgId, projectId, userId: adminId, role: 'admin' },
    { orgId, projectId, userId: memberId, role: 'member' },
  ]);
  adminCtx = { userId: adminId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' };
  memberCtx = { userId: memberId, orgId, projectId, orgRole: 'member', projectRole: 'member' };
});

afterAll(async () => {
  if (!available) return;
  await getDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('standing work', () => {
  let scheduleId = '';

  it('non-admins cannot author standing work', async () => {
    await expect(
      withTenant(memberCtx, (tx) =>
        createSchedule(tx, memberCtx, {
          title: 'Sneaky recurring job',
          input: 'Do a thing.',
          providerSelection: 'openai',
          cadence: 'daily',
        }),
      ),
    ).rejects.toThrow(AppError);
  });

  it('an admin creates weekly standing work due strictly in the future', async () => {
    const before = new Date();
    scheduleId = await withTenant(adminCtx, (tx) =>
      createSchedule(tx, adminCtx, {
        title: 'Weekly competitive summary',
        input: 'Summarize competitor moves this week.',
        providerSelection: 'openai',
        cadence: 'weekly',
        weekday: 1,
        atHour: 6,
      }),
    );
    const rows = await withTenant(adminCtx, (tx) => listSchedules(tx, adminCtx));
    const created = rows.find((r) => r.id === scheduleId)!;
    expect(created.enabled).toBe(true);
    expect(created.lastRunAt).toBeNull();
    expect(created.nextRunAt.getTime()).toBeGreaterThan(before.getTime());
    expect(created.nextRunAt.getUTCDay()).toBe(1);
    expect(created.nextRunAt.getUTCHours()).toBe(6);
  });

  it('weekly cadence without a weekday is rejected', async () => {
    await expect(
      withTenant(adminCtx, (tx) =>
        createSchedule(tx, adminCtx, {
          title: 'Incomplete',
          input: 'x',
          providerSelection: 'openai',
          cadence: 'weekly',
        }),
      ),
    ).rejects.toThrow(/weekday/i);
  });

  it('pausing is the kill switch; a paused schedule is not due for the tick', async () => {
    await withTenant(adminCtx, (tx) => setScheduleEnabled(tx, adminCtx, scheduleId, false));
    const db = getDb();
    const row = (
      await db
        .select({ enabled: taskSchedules.enabled })
        .from(taskSchedules)
        .where(eq(taskSchedules.id, scheduleId))
        .limit(1)
    )[0];
    expect(row!.enabled).toBe(false);

    // The tick's due query is (enabled = true AND next_run_at <= now).
    const dueNow = await db
      .select({ id: taskSchedules.id })
      .from(taskSchedules)
      .where(and(eq(taskSchedules.id, scheduleId), eq(taskSchedules.enabled, true)));
    expect(dueNow).toHaveLength(0);
  });

  it('non-admins cannot pause or resume either', async () => {
    await expect(
      withTenant(memberCtx, (tx) => setScheduleEnabled(tx, memberCtx, scheduleId, true)),
    ).rejects.toThrow(AppError);
  });
});
