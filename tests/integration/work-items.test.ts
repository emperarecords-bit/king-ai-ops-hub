import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, memberships, objectives, organizations, profiles, projectMembers, projects, workItems } from '@/db/schema';
import { createWorkItem, listWorkItems, updateWorkItem } from '@/domain/work/work-items';
import { setOwner } from '@/domain/agents/org';

/**
 * Work items (Slice 1 follow-up) — human-owned, editable tracking items. The
 * point vs. a task: no AI run, and the notes/stage are mutable over time.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[work-items.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let empId = '';
let objId = '';
let ctxA: TenantContext;
let ctxB: TenantContext;

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `wi-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = await db.insert(organizations).values({ name: 'Org', slug: `wi-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const pA = await db.insert(projects).values({ orgId, key: fixtureKey('wiA'), name: 'A' }).returning({ id: projects.id });
  const pB = await db.insert(projects).values({ orgId, key: fixtureKey('wiB'), name: 'B' }).returning({ id: projects.id });
  await db.insert(projectMembers).values([
    { orgId, projectId: pA[0]!.id, userId, role: 'admin' },
    { orgId, projectId: pB[0]!.id, userId, role: 'admin' },
  ]);
  ctxA = { userId, orgId, projectId: pA[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  ctxB = { userId, orgId, projectId: pB[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  const emp = await db.insert(agents).values({
    orgId, projectId: ctxA.projectId, name: 'Rep', role: 'primary', provider: 'openai',
    model: 'gpt-5.4-mini-2026-03-17', systemPrompt: 'template',
  }).returning({ id: agents.id });
  empId = emp[0]!.id;
  const o = await db.insert(objectives).values({ orgId, projectId: ctxA.projectId, title: 'Pipeline', status: 'draft', createdBy: userId }).returning({ id: objectives.id });
  objId = o[0]!.id;
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('work items — create, list, edit, own', () => {
  it('creates a work item under an objective and lists it with resolved names', async () => {
    const id = await withTenant(ctxA, (tx) =>
      createWorkItem(tx, ctxA, { title: 'L&N Mechanical – Nick', stage: 'Sourced', notes: 'old-school', objectiveId: objId }),
    );
    const items = await withTenant(ctxA, (tx) => listWorkItems(tx, ctxA));
    const it = items.find((w) => w.id === id)!;
    expect(it.title).toBe('L&N Mechanical – Nick');
    expect(it.stage).toBe('Sourced');
    expect(it.objectiveTitle).toBe('Pipeline');
  });

  it('edits notes and stage in place (the reason it exists vs a task)', async () => {
    const id = await withTenant(ctxA, (tx) => createWorkItem(tx, ctxA, { title: 'ACME HVAC', stage: 'Sourced' }));
    await withTenant(ctxA, (tx) => updateWorkItem(tx, ctxA, id, { title: 'ACME HVAC', stage: 'Demo booked', notes: 'wants Thursday' }));
    const items = await withTenant(ctxA, (tx) => listWorkItems(tx, ctxA));
    const it = items.find((w) => w.id === id)!;
    expect(it.stage).toBe('Demo booked');
    expect(it.notes).toBe('wants Thursday');
  });

  it('assigns an employee owner via the shared ownership path', async () => {
    const id = await withTenant(ctxA, (tx) => createWorkItem(tx, ctxA, { title: 'Owned item' }));
    await withTenant(ctxA, (tx) => setOwner(tx, ctxA, 'work_item', id, empId));
    const row = await getSetupDb().select({ o: workItems.ownerAgentId }).from(workItems).where(eq(workItems.id, id));
    expect(row[0]!.o).toBe(empId);
    const items = await withTenant(ctxA, (tx) => listWorkItems(tx, ctxA));
    expect(items.find((w) => w.id === id)!.ownerName).toBe('Rep');
  });

  it('filters by objective and isolates across workspaces', async () => {
    const inObj = await withTenant(ctxA, (tx) => listWorkItems(tx, ctxA, objId));
    expect(inObj.every((w) => w.objectiveTitle === 'Pipeline')).toBe(true);
    // Nothing created in workspace B → its list is empty even though A has items.
    const bItems = await withTenant(ctxB, (tx) => listWorkItems(tx, ctxB));
    expect(bItems.length).toBe(0);
  });
});
