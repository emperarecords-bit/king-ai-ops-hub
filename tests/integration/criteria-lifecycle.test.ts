import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { ConflictError } from '@/lib/errors';
import { getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { auditLogs, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import {
  addCriterion,
  createObjective,
  getObjective,
  removeCriterion,
  setCriterionStatus,
  setObjectiveStatus,
  updateCriterion,
  updateObjectiveDetails,
} from '@/domain/objectives/objectives';

/**
 * The ownership half of the objective lifecycle (LIFECYCLE-AUDIT, critical
 * gap). Written in the shape the audit says was missing everywhere else:
 * create → edit → remove → verify it still behaves, rather than
 * create → assert it exists.
 *
 * The rule under test that keeps D-017 honest: correcting a criterion is
 * allowed, but changing WHAT IS MEASURED invalidates any verification of it.
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
    `[criteria-lifecycle.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
  );
}

const userId = randomUUID();
let ctx: TenantContext;
let orgId = '';

beforeAll(async () => {
  if (!available) return;
  const db = getDb();
  await db
    .insert(profiles)
    .values({ id: userId, email: `crit-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = await db
    .insert(organizations)
    .values({ name: 'Criteria Org', slug: `crit-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const project = await db
    .insert(projects)
    .values({ orgId, key: fixtureKey('crit'), name: 'Criteria Project' })
    .returning({ id: projects.id });
  const projectId = project[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId, userId, role: 'admin' });
  ctx = { userId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (!available) return;
  await getDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

async function newObjective(criteria: Array<{ label: string; target: number; unit: string }>) {
  return withTenant(ctx, (tx) =>
    createObjective(tx, ctx, {
      title: 'Test objective',
      description: '',
      successCriteria: criteria.map((c) => ({ ...c, metric: c.label })),
    }),
  );
}

describe.skipIf(!available)('criteria lifecycle', () => {
  it('the O-11 scenario is now recoverable: a bad target can be corrected', async () => {
    // Exactly the state the owner was stuck in — a criterion generated with
    // target 0, on an objective that could not be edited or deleted.
    const id = await newObjective([
      { label: 'Number of AI sources connected', target: 0, unit: 'count' },
    ]);

    await withTenant(ctx, (tx) =>
      updateCriterion(tx, ctx, id, 0, {
        label: 'Number of AI sources connected',
        target: 5,
        unit: 'count',
      }),
    );

    const after = await withTenant(ctx, (tx) => getObjective(tx, ctx, id));
    expect(after.successCriteria[0]!.target).toBe(5);
  });

  it('changing the measure reopens a met criterion', async () => {
    const id = await newObjective([{ label: 'Signups', target: 10, unit: 'users' }]);
    await withTenant(ctx, (tx) => setCriterionStatus(tx, ctx, id, 0, 'met'));

    await withTenant(ctx, (tx) =>
      updateCriterion(tx, ctx, id, 0, { label: 'Signups', target: 100, unit: 'users' }),
    );

    const after = await withTenant(ctx, (tx) => getObjective(tx, ctx, id));
    expect(after.successCriteria[0]!.status).toBe('unmet');
    expect(after.successCriteria[0]!.verifiedBy).toBeNull();
  });

  it('fixing only the wording keeps the verification', async () => {
    const id = await newObjective([{ label: 'Signupz', target: 10, unit: 'users' }]);
    await withTenant(ctx, (tx) => setCriterionStatus(tx, ctx, id, 0, 'met'));

    await withTenant(ctx, (tx) =>
      updateCriterion(tx, ctx, id, 0, { label: 'Signups', target: 10, unit: 'users' }),
    );

    const after = await withTenant(ctx, (tx) => getObjective(tx, ctx, id));
    expect(after.successCriteria[0]!.label).toBe('Signups');
    expect(after.successCriteria[0]!.status).toBe('met');
  });

  it('criteria can be added and removed, and the metric is slugified', async () => {
    const id = await newObjective([{ label: 'First', target: 1, unit: 'count' }]);
    await withTenant(ctx, (tx) =>
      addCriterion(tx, ctx, id, {
        label: 'Uptime across chat/api surfaces',
        target: 99.5,
        unit: '%',
      }),
    );

    let after = await withTenant(ctx, (tx) => getObjective(tx, ctx, id));
    expect(after.successCriteria).toHaveLength(2);
    expect(after.successCriteria[1]!.metric).not.toContain('/');

    await withTenant(ctx, (tx) => removeCriterion(tx, ctx, id, 0));
    after = await withTenant(ctx, (tx) => getObjective(tx, ctx, id));
    expect(after.successCriteria).toHaveLength(1);
    expect(after.successCriteria[0]!.label).toContain('Uptime');
  });

  it('an active objective cannot lose its last criterion', async () => {
    const id = await newObjective([{ label: 'Only one', target: 1, unit: 'count' }]);
    await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, id, 'active'));

    await expect(
      withTenant(ctx, (tx) => removeCriterion(tx, ctx, id, 0)),
    ).rejects.toBeInstanceOf(ConflictError);

    // ...but it may lose one it can spare.
    await withTenant(ctx, (tx) =>
      addCriterion(tx, ctx, id, { label: 'Spare', target: 2, unit: 'count' }),
    );
    await withTenant(ctx, (tx) => removeCriterion(tx, ctx, id, 1));
    const after = await withTenant(ctx, (tx) => getObjective(tx, ctx, id));
    expect(after.successCriteria).toHaveLength(1);
  });

  it('a closed objective is frozen', async () => {
    const id = await newObjective([{ label: 'Done', target: 1, unit: 'count' }]);
    await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, id, 'active'));
    await withTenant(ctx, (tx) => setCriterionStatus(tx, ctx, id, 0, 'met'));
    await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, id, 'completed'));

    await expect(
      withTenant(ctx, (tx) =>
        updateCriterion(tx, ctx, id, 0, { label: 'Rewritten', target: 9, unit: 'count' }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      withTenant(ctx, (tx) =>
        updateObjectiveDetails(tx, ctx, id, { title: 'Rewritten', description: '' }),
      ),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('every correction is audited', async () => {
    const id = await newObjective([{ label: 'Audited', target: 1, unit: 'count' }]);
    await withTenant(ctx, (tx) =>
      updateCriterion(tx, ctx, id, 0, { label: 'Audited', target: 7, unit: 'count' }),
    );
    await withTenant(ctx, (tx) =>
      updateObjectiveDetails(tx, ctx, id, { title: 'Renamed objective', description: 'why' }),
    );

    const rows = await getDb()
      .select({ action: auditLogs.action, detail: auditLogs.detail })
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, id)));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('objective.criterion_edited');
    expect(actions).toContain('objective.details_edited');

    const edit = rows.find((r) => r.action === 'objective.criterion_edited')!;
    const detail = edit.detail as { from?: { target: number }; to?: { target: number } };
    expect(detail.from?.target).toBe(1);
    expect(detail.to?.target).toBe(7);
  });
});
