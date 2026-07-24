import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { getDb } from '@/db/client';
import { memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { upsertProfile } from '@/db/system';

/**
 * Regression for Sprint 1 known issue #2: the seed creates a placeholder
 * profile (random id) holding the owner's memberships; the first real sign-in
 * arrives with the SAME email under the auth user id. upsertProfile must adopt
 * the placeholder — move memberships, delete it, keep the email — instead of
 * dying on the email unique constraint.
 *
 * Runs against the real local Postgres (same requirement as tenancy tests).
 */

// Same infrastructure contract as tenancy.test.ts: default to the local
// Docker database and skip when it isn't reachable.
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
    `[profile-relink.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
  );
}

let db: ReturnType<typeof getDb>;

const email = `relink-${randomUUID().slice(0, 8)}@test.local`;
const placeholderId = randomUUID();
const authUserId = randomUUID();
let orgId = '';
let projectId = '';

beforeAll(async () => {
  if (!available) return;
  db = getDb();
  await db.insert(profiles).values({
    id: placeholderId,
    email,
    displayName: 'Placeholder Owner',
  });
  const org = await db
    .insert(organizations)
    .values({ name: 'Relink Test Org', slug: `relink-test-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId: placeholderId, role: 'owner' });
  const project = await db
    .insert(projects)
    .values({ orgId, key: fixtureKey('relink'), name: 'Relink Project' })
    .returning({ id: projects.id });
  projectId = project[0]!.id;
  await db
    .insert(projectMembers)
    .values({ orgId, projectId, userId: placeholderId, role: 'admin' });
});

afterAll(async () => {
  if (!available) return;
  // Cascades remove memberships/project rows hanging off these.
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(profiles).where(eq(profiles.id, authUserId));
  await db.delete(profiles).where(eq(profiles.id, placeholderId));
});

describe.skipIf(!available)('upsertProfile relink', () => {
  it('adopts a seed placeholder with the same email', async () => {
    await upsertProfile({ id: authUserId, email, displayName: 'Real Owner' });

    // The auth profile owns the email now…
    const self = await db.select().from(profiles).where(eq(profiles.id, authUserId));
    expect(self).toHaveLength(1);
    expect(self[0]!.email).toBe(email);

    // …the placeholder is gone…
    const ghost = await db.select().from(profiles).where(eq(profiles.id, placeholderId));
    expect(ghost).toHaveLength(0);

    // …and every membership followed.
    const orgRows = await db
      .select()
      .from(memberships)
      .where(eq(memberships.userId, authUserId));
    expect(orgRows).toHaveLength(1);
    expect(orgRows[0]!.orgId).toBe(orgId);

    const projRows = await db
      .select()
      .from(projectMembers)
      .where(eq(projectMembers.userId, authUserId));
    expect(projRows).toHaveLength(1);
    expect(projRows[0]!.projectId).toBe(projectId);
  });

  it('is idempotent: repeat sign-ins hit the plain upsert path', async () => {
    await upsertProfile({ id: authUserId, email, displayName: 'Real Owner' });
    const self = await db.select().from(profiles).where(eq(profiles.id, authUserId));
    expect(self).toHaveLength(1);
  });
});
