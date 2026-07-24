import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '@/db/client';
import {
  agents,
  departments,
  knowledgeItems,
  memberships,
  organizations,
  profiles,
  projects,
  spendLimits,
} from '@/db/schema';
import { createWorkspace } from '@/domain/projects/provision';
import { DEFAULT_STAFF } from '@/domain/projects/default-staff';

/**
 * Workspace provisioning (Sprint 5, "The Front Door"): a new workspace must
 * arrive fully staffed — employees, departments, budget, charter — for both
 * the existing-org path and the brand-new-user path (org bootstrap).
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
    `[provision.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
  );
}

const ownerUser = {
  id: randomUUID(),
  email: `prov-owner-${randomUUID().slice(0, 8)}@test.local`,
  displayName: 'Provision Owner',
};
const freshUser = {
  id: randomUUID(),
  email: `prov-fresh-${randomUUID().slice(0, 8)}@test.local`,
  displayName: 'Fresh User',
};
let existingOrgId = '';

beforeAll(async () => {
  if (!available) return;
  const db = getDb();
  await db.insert(profiles).values([ownerUser, freshUser].map((u) => ({ ...u })));
  const org = await db
    .insert(organizations)
    .values({ name: 'Prov Org', slug: `prov-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  existingOrgId = org[0]!.id;
  await db
    .insert(memberships)
    .values({ orgId: existingOrgId, userId: ownerUser.id, role: 'owner' });
});

afterAll(async () => {
  // Provisioning writes audit rows, which pin org/project (ON DELETE
  // RESTRICT). Archive instead of delete; random slugs prevent collisions.
  if (!available) return;
  const db = getDb();
  await db.update(projects).set({ archived: true }).where(eq(projects.orgId, existingOrgId));
  const freshOrgs = await db
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(eq(memberships.userId, freshUser.id));
  for (const { orgId } of freshOrgs) {
    await db.update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
  }
});

describe.skipIf(!available)('workspace provisioning', () => {
  it('stands up a fully staffed workspace in an existing org', async () => {
    const { projectKey } = await createWorkspace(ownerUser, {
      name: 'ZZ Fixture Prov Workspace',
      description: 'A test venture.',
    });
    const db = getDb();
    const project = (
      await db
        .select()
        .from(projects)
        .where(and(eq(projects.orgId, existingOrgId), eq(projects.key, projectKey)))
        .limit(1)
    )[0];
    expect(project).toBeDefined();

    const staff = await db.select().from(agents).where(eq(agents.projectId, project!.id));
    expect(staff).toHaveLength(DEFAULT_STAFF.length);
    expect(new Set(staff.map((s) => s.name))).toEqual(new Set(DEFAULT_STAFF.map((s) => s.name)));
    expect(staff.every((s) => s.departmentId != null)).toBe(true);

    const budget = await db
      .select()
      .from(spendLimits)
      .where(eq(spendLimits.projectId, project!.id));
    expect(budget).toHaveLength(1);
    expect(budget[0]!.monthlyLimitMicros).toBe(25_000_000n);

    // The charter is company knowledge now (K1), active from creation.
    const charter = await db
      .select()
      .from(knowledgeItems)
      .where(eq(knowledgeItems.projectId, project!.id));
    expect(charter).toHaveLength(1);
    expect(charter[0]!.status).toBe('active');
    expect(charter[0]!.approvedBy).toBe(ownerUser.id);
  });

  it('key collisions get numbered suffixes', async () => {
    const second = await createWorkspace(ownerUser, { name: 'ZZ Fixture Prov Workspace' });
    expect(second.projectKey).toBe('zz-fixture-prov-workspace-2');
  });

  it('a brand-new user gets an org of their own, as owner, with departments', async () => {
    const { projectKey } = await createWorkspace(freshUser, { name: 'ZZ Fixture First Venture' });
    const db = getDb();
    const m = await db
      .select({ orgId: memberships.orgId, role: memberships.role })
      .from(memberships)
      .where(eq(memberships.userId, freshUser.id));
    expect(m).toHaveLength(1);
    expect(m[0]!.role).toBe('owner');

    const project = (
      await db
        .select()
        .from(projects)
        .where(and(eq(projects.orgId, m[0]!.orgId), eq(projects.key, projectKey)))
        .limit(1)
    )[0];
    expect(project).toBeDefined();

    const depts = await db
      .select()
      .from(departments)
      .where(eq(departments.orgId, m[0]!.orgId));
    expect(depts).toHaveLength(8);
  });
});
