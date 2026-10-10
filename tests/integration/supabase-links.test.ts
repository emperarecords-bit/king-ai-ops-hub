import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { linkSupabaseProject, unlinkSupabaseProject, listSupabaseProjectLinks } from '@/domain/supabase/links';
import { type TenantContext } from '@/types/domain';
import { fixtureKey } from '@tests/support/fixture-key';

/**
 * Phase 2C — supabase_project_links lifecycle + RLS tenant isolation. One admin, two workspaces in one org:
 * a project linked under A must be invisible under B (RLS confines by project_id), admin-only, idempotent.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[supabase-links.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let ctxA: TenantContext;
let ctxB: TenantContext;

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `sb-${randomUUID().slice(0, 8)}@test.local`, displayName: 'SB Admin' });
  const [org] = await db.insert(organizations).values({ name: 'SB Org', slug: fixtureKey('sb-org') }).returning({ id: organizations.id });
  await db.insert(memberships).values({ orgId: org!.id, userId, role: 'owner' });
  const [pA] = await db.insert(projects).values({ orgId: org!.id, key: fixtureKey('sb-a'), name: 'SB Workspace A' }).returning({ id: projects.id });
  const [pB] = await db.insert(projects).values({ orgId: org!.id, key: fixtureKey('sb-b'), name: 'SB Workspace B' }).returning({ id: projects.id });
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

describe.skipIf(!available)('supabase_project_links — lifecycle + RLS isolation', { timeout: 15_000 }, () => {
  it('links under A, is visible under A, and is INVISIBLE under B (RLS by project)', async () => {
    const ref = 'bblnywrcdsfdasytkzps';
    const id = await withTenant(ctxA, (tx) => linkSupabaseProject(tx, ctxA, { projectRef: ref, label: 'AccurateBids' }));
    expect(typeof id).toBe('string');

    const underA = await withTenant(ctxA, (tx) => listSupabaseProjectLinks(tx, ctxA));
    expect(underA.map((l) => l.projectRef)).toContain(ref);

    // Same user, same org, DIFFERENT workspace → the row is confined to workspace A by RLS.
    const underB = await withTenant(ctxB, (tx) => listSupabaseProjectLinks(tx, ctxB));
    expect(underB.find((l) => l.projectRef === ref)).toBeUndefined();

    // Unlink is idempotent + removes it.
    expect(await withTenant(ctxA, (tx) => unlinkSupabaseProject(tx, ctxA, id))).toBe(true);
    expect(await withTenant(ctxA, (tx) => unlinkSupabaseProject(tx, ctxA, id))).toBe(false);
    const afterUnlink = await withTenant(ctxA, (tx) => listSupabaseProjectLinks(tx, ctxA));
    expect(afterUnlink.find((l) => l.projectRef === ref)).toBeUndefined();
  });

  it('a non-admin member cannot link', async () => {
    const memberCtx: TenantContext = { ...ctxA, projectRole: 'member' };
    await expect(withTenant(memberCtx, (tx) => linkSupabaseProject(tx, memberCtx, { projectRef: 'vdquqzfyrlhywovdtxjf' }))).rejects.toThrow();
  });
});
