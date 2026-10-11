import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { linkVercelProject, unlinkVercelProject, listVercelProjectLinks } from '@/domain/vercel/links';
import { type TenantContext } from '@/types/domain';
import { fixtureKey } from '@tests/support/fixture-key';

/**
 * Phase 2D — vercel_project_links lifecycle + RLS tenant isolation. One admin, two workspaces in one org:
 * a project linked under A must be invisible under B (RLS confines by project_id), admin-only, idempotent.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[vercel-links.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let ctxA: TenantContext;
let ctxB: TenantContext;

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `vl-${randomUUID().slice(0, 8)}@test.local`, displayName: 'VL Admin' });
  const [org] = await db.insert(organizations).values({ name: 'VL Org', slug: fixtureKey('vl-org') }).returning({ id: organizations.id });
  await db.insert(memberships).values({ orgId: org!.id, userId, role: 'owner' });
  const [pA] = await db.insert(projects).values({ orgId: org!.id, key: fixtureKey('vl-a'), name: 'VL Workspace A' }).returning({ id: projects.id });
  const [pB] = await db.insert(projects).values({ orgId: org!.id, key: fixtureKey('vl-b'), name: 'VL Workspace B' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId: org!.id, projectId: pA!.id, userId, role: 'admin' });
  await db.insert(projectMembers).values({ orgId: org!.id, projectId: pB!.id, userId, role: 'admin' });
  ctxA = { userId, orgId: org!.id, projectId: pA!.id, orgRole: 'owner', projectRole: 'admin' };
  ctxB = { userId, orgId: org!.id, projectId: pB!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.id, ctxA.projectId));
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.id, ctxB.projectId));
});

describe.skipIf(!available)('vercel_project_links — lifecycle + RLS isolation', { timeout: 15_000 }, () => {
  it('links under A, is visible under A, and is INVISIBLE under B (RLS by project)', async () => {
    const vid = 'prj_accuratebids0001xyz';
    const id = await withTenant(ctxA, (tx) => linkVercelProject(tx, ctxA, { vercelProjectId: vid, label: 'AccurateBids' }));
    expect(typeof id).toBe('string');

    const underA = await withTenant(ctxA, (tx) => listVercelProjectLinks(tx, ctxA));
    expect(underA.map((l) => l.vercelProjectId)).toContain(vid);

    const underB = await withTenant(ctxB, (tx) => listVercelProjectLinks(tx, ctxB));
    expect(underB.find((l) => l.vercelProjectId === vid)).toBeUndefined();

    expect(await withTenant(ctxA, (tx) => unlinkVercelProject(tx, ctxA, id))).toBe(true);
    expect(await withTenant(ctxA, (tx) => unlinkVercelProject(tx, ctxA, id))).toBe(false);
    const afterUnlink = await withTenant(ctxA, (tx) => listVercelProjectLinks(tx, ctxA));
    expect(afterUnlink.find((l) => l.vercelProjectId === vid)).toBeUndefined();
  });

  it('a non-admin member cannot link', async () => {
    const memberCtx: TenantContext = { ...ctxA, projectRole: 'member' };
    await expect(withTenant(memberCtx, (tx) => linkVercelProject(tx, memberCtx, { vercelProjectId: 'prj_second0002abcdef' }))).rejects.toThrow();
  });
});
