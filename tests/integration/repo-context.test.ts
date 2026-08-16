import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import {
  approveContextItem,
  archiveContextItem,
  importRepoFileAsPendingContext,
  listContextItems,
  loadApprovedContextForRun,
  MAX_CONTEXT_ITEM_CHARS,
} from '@/domain/github/content';
import { type TenantContext } from '@/types/domain';
import { fixtureKey } from '@tests/support/fixture-key';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[repo-context.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }
let ctx: TenantContext;

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `repo-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Repo Admin' });
  const [org] = await db.insert(organizations).values({ name: 'Repo Org', slug: fixtureKey('repo-org') }).returning({ id: organizations.id });
  await db.insert(memberships).values({ orgId: org!.id, userId, role: 'owner' });
  const [project] = await db.insert(projects).values({ orgId: org!.id, key: fixtureKey('repo'), name: 'Repo Workspace' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId: org!.id, projectId: project!.id, userId, role: 'admin' });
  ctx = { userId, orgId: org!.id, projectId: project!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.id, ctx.projectId));
});

describe.skipIf(!available)('repo context items: gate + consumption', { timeout: 15_000 }, () => {
  it('a pending import is invisible to runs until an admin approves it; archive removes it again', async () => {
    const id = await withTenant(ctx, (tx) =>
      importRepoFileAsPendingContext(tx, ctx, { repoFullName: 'acme/app', ref: 'main', path: 'docs/GUIDE.md', content: '# Guide\nreal content' }),
    );
    let forRun = await withTenant(ctx, (tx) => loadApprovedContextForRun(tx, ctx));
    expect(forRun.find((i) => i.title.includes('GUIDE.md'))).toBeUndefined();

    await withTenant(ctx, (tx) => approveContextItem(tx, ctx, id));
    forRun = await withTenant(ctx, (tx) => loadApprovedContextForRun(tx, ctx));
    const item = forRun.find((i) => i.title === 'github:acme/app@main:docs/GUIDE.md');
    expect(item).toBeDefined();
    expect(item!.content).toContain('real content');
    expect(item!.kind).toBe('Imported repository file');

    await withTenant(ctx, (tx) => archiveContextItem(tx, ctx, id));
    forRun = await withTenant(ctx, (tx) => loadApprovedContextForRun(tx, ctx));
    expect(forRun.find((i) => i.title.includes('GUIDE.md'))).toBeUndefined();

    const all = await withTenant(ctx, (tx) => listContextItems(tx, ctx));
    expect(all.find((i) => i.id === id)?.status).toBe('archived');
  });

  it('a non-admin cannot approve, and oversized content is truncated with an explicit marker', async () => {
    const id = await withTenant(ctx, (tx) =>
      importRepoFileAsPendingContext(tx, ctx, {
        repoFullName: 'acme/app',
        ref: 'main',
        path: 'big/FILE.txt',
        content: 'x'.repeat(MAX_CONTEXT_ITEM_CHARS + 5_000),
      }),
    );
    const member = { ...ctx, projectRole: 'member' as const };
    await expect(withTenant(member, (tx) => approveContextItem(tx, member, id))).rejects.toThrow(/admin/i);

    await withTenant(ctx, (tx) => approveContextItem(tx, ctx, id));
    const forRun = await withTenant(ctx, (tx) => loadApprovedContextForRun(tx, ctx));
    const item = forRun.find((i) => i.title === 'github:acme/app@main:big/FILE.txt');
    expect(item).toBeDefined();
    expect(item!.content.length).toBeLessThan(MAX_CONTEXT_ITEM_CHARS + 300);
    expect(item!.content).toContain('truncated');
  });
});
