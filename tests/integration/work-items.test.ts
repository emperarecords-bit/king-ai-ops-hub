import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, memberships, objectives, organizations, profiles, projectMembers, projects, tasks, workItems } from '@/db/schema';
import { createWorkItem, finishWorkItem, getWorkItem, listWorkItems, stopWorkItem, updateWorkItem } from '@/domain/work/work-items';
import { cancelTask } from '@/domain/tasks/tasks';
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

  it('edits condition, notes, and stage in place (the reason it exists vs a task)', async () => {
    const id = await withTenant(ctxA, (tx) => createWorkItem(tx, ctxA, { title: 'ACME HVAC', stage: 'Sourced' }));
    await withTenant(ctxA, (tx) =>
      updateWorkItem(tx, ctxA, id, { title: 'ACME HVAC', condition: 'waiting', waitingOn: 'callback', stage: 'Demo booked', notes: 'wants Thursday' }),
    );
    const items = await withTenant(ctxA, (tx) => listWorkItems(tx, ctxA));
    const it = items.find((w) => w.id === id)!;
    expect(it.condition).toBe('waiting');
    expect(it.waitingOn).toBe('callback');
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

  it('stopping requires a reason, and the reason survives (institutional memory)', async () => {
    const id = await withTenant(ctxA, (tx) => createWorkItem(tx, ctxA, { title: 'Stop me' }));
    await expect(withTenant(ctxA, (tx) => stopWorkItem(tx, ctxA, id, '   '))).rejects.toThrow(/reason is required/i);
    await withTenant(ctxA, (tx) => stopWorkItem(tx, ctxA, id, 'superseded by new flow'));
    const row = await getSetupDb().select({ c: workItems.condition, r: workItems.closureReason, by: workItems.closedBy }).from(workItems).where(eq(workItems.id, id));
    expect(row[0]!.c).toBe('stopped');
    expect(row[0]!.r).toBe('superseded by new flow');
    expect(row[0]!.by).toBe(userId);
  });

  it('finished and stopped are distinct, and a closed item is frozen', async () => {
    const fin = await withTenant(ctxA, (tx) => createWorkItem(tx, ctxA, { title: 'Finish me' }));
    await withTenant(ctxA, (tx) => finishWorkItem(tx, ctxA, fin));
    const frow = await getSetupDb().select({ c: workItems.condition }).from(workItems).where(eq(workItems.id, fin));
    expect(frow[0]!.c).toBe('finished');
    // frozen: ordinary edits and re-closing are rejected once terminal.
    await expect(
      withTenant(ctxA, (tx) => updateWorkItem(tx, ctxA, fin, { title: 'x', condition: 'moving', waitingOn: '', stage: 'y', notes: '' })),
    ).rejects.toThrow(/closed|frozen/i);
    await expect(withTenant(ctxA, (tx) => stopWorkItem(tx, ctxA, fin, 'again'))).rejects.toThrow(/closed/i);
  });

  it('an AI task cancellation preserves the operator reason', async () => {
    const t = await getSetupDb()
      .insert(tasks)
      .values({ orgId, projectId: ctxA.projectId, title: 'Cancel me', input: 'x', providerSelection: 'openai', status: 'pending', createdBy: userId })
      .returning({ id: tasks.id });
    await withTenant(ctxA, (tx) => cancelTask(tx, ctxA, t[0]!.id, 'no longer needed'));
    const row = await getSetupDb().select({ s: tasks.status, r: tasks.cancelReason }).from(tasks).where(eq(tasks.id, t[0]!.id));
    expect(row[0]!.s).toBe('cancelled');
    expect(row[0]!.r).toBe('no longer needed');
  });

  // 2c shared-detail: the canonical detail read (getWorkItem) is what the detail page assesses.
  it('getWorkItem carries only an owner — never a separate performer — for human work', async () => {
    const id = await withTenant(ctxA, (tx) => createWorkItem(tx, ctxA, { title: 'Owned detail', objectiveId: objId }));
    await withTenant(ctxA, (tx) => setOwner(tx, ctxA, 'work_item', id, empId));
    const w = await withTenant(ctxA, (tx) => getWorkItem(tx, ctxA, id));
    expect(w.ownerName).toBe('Rep');
    expect(w.objectiveTitle).toBe('Pipeline');
    // There is no performer field distinct from the owner: a human item can never claim a
    // performer the model doesn't know. The detail page passes performer={null} on this basis.
    expect('performer' in w).toBe(false);
  });

  it('getWorkItem keeps an unestablished condition Unknown (null), not a defaulted value', async () => {
    const id = await withTenant(ctxA, (tx) => createWorkItem(tx, ctxA, { title: 'No condition set' }));
    // Legacy/unestablished items carry a null condition until an operator sets one.
    await getSetupDb().update(workItems).set({ condition: null }).where(eq(workItems.id, id));
    const w = await withTenant(ctxA, (tx) => getWorkItem(tx, ctxA, id));
    expect(w.condition).toBeNull();
  });

  it('getWorkItem exposes the frozen closure record for a terminal item', async () => {
    const id = await withTenant(ctxA, (tx) => createWorkItem(tx, ctxA, { title: 'Closes with a record' }));
    await withTenant(ctxA, (tx) => stopWorkItem(tx, ctxA, id, 'client went dark'));
    const w = await withTenant(ctxA, (tx) => getWorkItem(tx, ctxA, id));
    expect(w.condition).toBe('stopped');
    expect(w.closureReason).toBe('client went dark');
    expect(w.closedByName).toBe('Owner'); // resolved from the profile, not a raw id
    expect(w.closedAt).toBeInstanceOf(Date);
  });

  it('filters by objective and isolates across workspaces', async () => {
    const inObj = await withTenant(ctxA, (tx) => listWorkItems(tx, ctxA, objId));
    expect(inObj.every((w) => w.objectiveTitle === 'Pipeline')).toBe(true);
    // Nothing created in workspace B → its list is empty even though A has items.
    const bItems = await withTenant(ctxB, (tx) => listWorkItems(tx, ctxB));
    expect(bItems.length).toBe(0);
  });
});
