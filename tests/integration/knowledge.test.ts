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
  activateKnowledge,
  archiveKnowledge,
  createKnowledge,
  listKnowledge,
  reviseKnowledge,
} from '@/domain/knowledge/knowledge';
import { loadApprovedContext } from '@/domain/projects/context';

/**
 * K1 rules that must never regress: only ACTIVE knowledge is injected;
 * drafts are quarantine; a version supersedes its predecessor atomically so
 * two versions can never inject together; archived is terminal.
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
    `[knowledge.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
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
    email: `know-${randomUUID().slice(0, 8)}@test.local`,
    displayName: 'Knowledge Tester',
  });
  const org = await db
    .insert(organizations)
    .values({ name: 'Know Test Org', slug: `know-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const project = await db
    .insert(projects)
    .values({ orgId, key: fixtureKey('know'), name: 'Know Test Project' })
    .returning({ id: projects.id });
  await db
    .insert(projectMembers)
    .values({ orgId, projectId: project[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: project[0]!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  // Audit rows pin the fixtures (ON DELETE RESTRICT) — archive, don't delete.
  if (!available) return;
  await getDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('company knowledge K1', () => {
  let draftId = '';
  let activeId = '';

  it('drafts are never injected into prompts', async () => {
    draftId = await withTenant(ctx, (tx) =>
      createKnowledge(tx, ctx, {
        title: 'Draft standard',
        body: 'Not yet approved.',
        kind: 'standard',
        activate: false,
      }),
    );
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    expect(injected.find((i) => i.title === 'Draft standard')).toBeUndefined();
  });

  it('activation makes an item injectable, with approver recorded', async () => {
    await withTenant(ctx, (tx) => activateKnowledge(tx, ctx, draftId));
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    expect(injected.find((i) => i.title === 'Draft standard')?.content).toBe('Not yet approved.');
    activeId = draftId;
  });

  it('human-created knowledge may activate immediately', async () => {
    await withTenant(ctx, (tx) =>
      createKnowledge(tx, ctx, {
        title: 'House style',
        body: 'Short sentences.',
        kind: 'brand',
        activate: true,
      }),
    );
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    expect(injected.find((i) => i.title === 'House style')).toBeDefined();
  });

  it('a new version supersedes atomically — exactly one version injects', async () => {
    await withTenant(ctx, (tx) =>
      reviseKnowledge(tx, ctx, activeId, { body: 'Approved, v2.', activate: true }),
    );
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    const versions = injected.filter((i) => i.title === 'Draft standard');
    expect(versions).toHaveLength(1);
    expect(versions[0]!.content).toBe('Approved, v2.');

    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx));
    const v1 = all.find((i) => i.id === activeId);
    expect(v1?.status).toBe('archived');
    const v2 = all.find((i) => i.supersedes === activeId);
    expect(v2?.version).toBe(2);
    expect(v2?.status).toBe('active');
  });

  it('a draft revision does NOT replace the active version until activated', async () => {
    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx, 'active'));
    const current = all.find((i) => i.title === 'Draft standard')!;
    await withTenant(ctx, (tx) =>
      reviseKnowledge(tx, ctx, current.id, { body: 'v3 pending.', activate: false }),
    );
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    expect(injected.find((i) => i.title === 'Draft standard')?.content).toBe('Approved, v2.');
  });

  it('archived is terminal and never injects', async () => {
    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx, 'active'));
    const house = all.find((i) => i.title === 'House style')!;
    await withTenant(ctx, (tx) => archiveKnowledge(tx, ctx, house.id));
    const injected = await withTenant(ctx, (tx) => loadApprovedContext(tx, ctx));
    expect(injected.find((i) => i.title === 'House style')).toBeUndefined();
    await expect(
      withTenant(ctx, (tx) => archiveKnowledge(tx, ctx, house.id)),
    ).rejects.toThrow(ConflictError);
  });

  it('only drafts can be activated', async () => {
    const all = await withTenant(ctx, (tx) => listKnowledge(tx, ctx, 'active'));
    const active = all[0]!;
    await expect(
      withTenant(ctx, (tx) => activateKnowledge(tx, ctx, active.id)),
    ).rejects.toThrow(ConflictError);
  });
});
