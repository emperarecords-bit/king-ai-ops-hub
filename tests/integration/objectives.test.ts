import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { ConflictError } from '@/lib/errors';
import { getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import {
  addMilestone,
  createObjective,
  getObjective,
  listObjectives,
  setCriterionStatus,
  setObjectiveStatus,
} from '@/domain/objectives/objectives';

/**
 * The Sprint 4 business rule that must never regress: an objective CANNOT
 * complete while any success criterion is unmet — criteria are met or
 * explicitly waived by a human, and closed objectives are immutable.
 * Runs against the real local Postgres; skips when unreachable.
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
    `[objectives.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
  );
}

const userId = randomUUID();
let ctx: TenantContext;
let orgId = '';

beforeAll(async () => {
  if (!available) return;
  const db = getDb();
  await db.insert(profiles).values({
    id: userId,
    email: `objtest-${randomUUID().slice(0, 8)}@test.local`,
    displayName: 'Objective Tester',
  });
  const org = await db
    .insert(organizations)
    .values({ name: 'Obj Test Org', slug: `obj-test-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const project = await db
    .insert(projects)
    .values({ orgId, key: fixtureKey('obj'), name: 'Obj Test Project' })
    .returning({ id: projects.id });
  const projectId = project[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId, userId, role: 'admin' });
  ctx = { userId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  // No cleanup possible, by design: the objective mutations wrote audit rows,
  // and audit_logs reference org/project with ON DELETE RESTRICT — history
  // pins its subjects. Fixtures use random slugs/keys so re-runs never
  // collide; archive the project so it can't appear in any picker.
  if (!available) return;
  const db = getDb();
  await db.update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('objective completion gate', () => {
  let objectiveId = '';

  it('creates a draft objective with unmet criteria', async () => {
    objectiveId = await withTenant(ctx, (tx) =>
      createObjective(tx, ctx, {
        title: 'Ship the beta',
        description: 'Test objective',
        successCriteria: [
          { label: '100 beta users', metric: 'beta_users', target: 100, unit: 'users' },
          { label: '95% uptime', metric: 'uptime', target: 95, unit: '%' },
        ],
      }),
    );
    const detail = await withTenant(ctx, (tx) => getObjective(tx, ctx, objectiveId));
    expect(detail.status).toBe('draft');
    expect(detail.successCriteria).toHaveLength(2);
    expect(detail.successCriteria.every((c) => c.status === 'unmet')).toBe(true);
    expect(detail.progress.percent).toBe(0);
  });

  it('an objective with NO criteria cannot be activated (executive decision 2026-07-24)', async () => {
    const bare = await withTenant(ctx, (tx) =>
      createObjective(tx, ctx, { title: 'Vague ambition', successCriteria: [] }),
    );
    await expect(
      withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, bare, 'active')),
    ).rejects.toThrow(/at least one success criterion/i);

    // Drafts may still EXIST without criteria — thinking can be unfinished.
    const detail = await withTenant(ctx, (tx) => getObjective(tx, ctx, bare));
    expect(detail.status).toBe('draft');
  });

  it('cannot jump from draft to completed', async () => {
    await expect(
      withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objectiveId, 'completed')),
    ).rejects.toThrow(ConflictError);
  });

  it('activates, then REFUSES completion while criteria are unmet', async () => {
    await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objectiveId, 'active'));
    await expect(
      withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objectiveId, 'completed')),
    ).rejects.toThrow(/unmet/);
  });

  it('meets one criterion, waives the other — recording who and when', async () => {
    await withTenant(ctx, (tx) => setCriterionStatus(tx, ctx, objectiveId, 0, 'met'));
    await withTenant(ctx, (tx) => setCriterionStatus(tx, ctx, objectiveId, 1, 'waived'));
    const detail = await withTenant(ctx, (tx) => getObjective(tx, ctx, objectiveId));
    expect(detail.successCriteria[0]!.status).toBe('met');
    expect(detail.successCriteria[0]!.verifiedBy).toBe(userId);
    expect(detail.successCriteria[0]!.verifiedAt).toBeTruthy();
    expect(detail.successCriteria[1]!.status).toBe('waived');
    expect(detail.progress.percent).toBe(100); // criteria-based (no tasks attached)
  });

  it('completes once every criterion is satisfied', async () => {
    await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objectiveId, 'completed'));
    const detail = await withTenant(ctx, (tx) => getObjective(tx, ctx, objectiveId));
    expect(detail.status).toBe('completed');
  });

  it('a closed objective is immutable: criteria, milestones, and status are locked', async () => {
    await expect(
      withTenant(ctx, (tx) => setCriterionStatus(tx, ctx, objectiveId, 0, 'unmet')),
    ).rejects.toThrow(ConflictError);
    await expect(
      withTenant(ctx, (tx) => addMilestone(tx, ctx, objectiveId, { title: 'too late' })),
    ).rejects.toThrow(ConflictError);
    await expect(
      withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objectiveId, 'cancelled')),
    ).rejects.toThrow(ConflictError);
  });

  it('shows up in the list with progress rolled up', async () => {
    const rows = await withTenant(ctx, (tx) => listObjectives(tx, ctx));
    const row = rows.find((r) => r.id === objectiveId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('completed');
    expect(row!.progress.criteriaSatisfied).toBe(2);
  });
});
