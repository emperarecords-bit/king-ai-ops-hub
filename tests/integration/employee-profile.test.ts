import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, knowledgeItems, memberships, organizations, profiles, projectContextItems, projectMembers, projects, tasks } from '@/db/schema';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { employeeProfile } from '@/domain/agents/profile';
import { type TenantContext } from '@/types/domain';
import { fixtureKey } from '@tests/support/fixture-key';

/** Employee Profile — the "what this employee knows" + track-record read. */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[employee-profile.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let ctx: TenantContext;
let gmId: string;
let workerId: string;

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `ep-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const [org] = await db.insert(organizations).values({ name: 'EP Org', slug: fixtureKey('ep-org') }).returning({ id: organizations.id });
  const [project] = await db.insert(projects).values({ orgId: org!.id, key: fixtureKey('ep'), name: 'EP Workspace' }).returning({ id: projects.id });
  await db.insert(memberships).values({ orgId: org!.id, userId, role: 'owner' });
  await db.insert(projectMembers).values({ orgId: org!.id, projectId: project!.id, userId, role: 'admin' });
  ctx = { userId, orgId: org!.id, projectId: project!.id, orgRole: 'owner', projectRole: 'admin' };

  gmId = (
    await db.insert(agents).values({ orgId: org!.id, projectId: project!.id, name: 'GM', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'gm', enabled: true }).returning({ id: agents.id })
  )[0]!.id;
  workerId = (
    await db.insert(agents).values({ orgId: org!.id, projectId: project!.id, name: 'Worker', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'w', enabled: true }).returning({ id: agents.id })
  )[0]!.id;
  await db.update(projects).set({ ownerAgentId: gmId }).where(eq(projects.id, project!.id));

  await db.insert(tasks).values({ orgId: org!.id, projectId: project!.id, title: 'Worker task one', input: 'x', providerSelection: 'openai', createdBy: userId, status: 'completed', assignedPrimaryAgentId: workerId });
  await db.insert(knowledgeItems).values({ orgId: org!.id, projectId: project!.id, scope: 'project', kind: 'fact', title: 'Pricing sheet', body: 'b', status: 'active', source: 'manual', createdBy: userId });
  await db.insert(knowledgeItems).values({ orgId: org!.id, projectId: project!.id, scope: 'project', kind: 'fact', title: 'Old draft', body: 'b', status: 'draft', source: 'manual', createdBy: userId });
  await db.insert(projectContextItems).values({ orgId: org!.id, projectId: project!.id, title: 'README.md', content: 'c', status: 'approved', createdBy: userId });
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.id, ctx.projectId));
});

describe.skipIf(!available)('employee profile', { timeout: 15_000 }, () => {
  it('reports GM identity, recent work, and the visible knowledge/context surface', async () => {
    const worker = await withTenant(ctx, (tx) => employeeProfile(tx, ctx, workerId));
    expect(worker.isGeneralManager).toBe(false);
    expect(worker.recentTasks.map((t) => t.title)).toContain('Worker task one');
    expect(worker.knowledge.activeCount).toBe(1); // drafts never counted
    expect(worker.knowledge.titles).toEqual(['Pricing sheet']);
    expect(worker.sharedContext.approvedCount).toBe(1);
    expect(worker.sharedContext.titles).toEqual(['README.md']);

    const gm = await withTenant(ctx, (tx) => employeeProfile(tx, ctx, gmId));
    expect(gm.isGeneralManager).toBe(true);
    expect(gm.recentTasks).toHaveLength(0);
  });
});
