import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, departments, memberships, objectives, organizations, profiles, projectMembers, projects, tasks } from '@/db/schema';
import { createEmployee, listEmployees, setOwner, updateEmployee, workOwnedBy } from '@/domain/agents/org';

/**
 * Organizational model (Slice 1) — employees, reporting line, and ownership.
 * Descriptive only: no routing is asserted, only that the org data is correct
 * and tenant-isolated.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[org-model.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let deptId = '';
let ctxA: TenantContext;
let ctxB: TenantContext;
let bTemplateAgentId = '';
let taskAId = '';
let objAId = '';

async function seedTemplateAgent(projectId: string, name: string): Promise<string> {
  const r = await getSetupDb().insert(agents).values({
    orgId, projectId, name, role: 'primary', provider: 'openai',
    model: 'gpt-5.4-mini-2026-03-17', systemPrompt: 'template',
  }).returning({ id: agents.id });
  return r[0]!.id;
}

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `org-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = await db.insert(organizations).values({ name: 'Org', slug: `org-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const pA = await db.insert(projects).values({ orgId, key: fixtureKey('orgA'), name: 'A' }).returning({ id: projects.id });
  const pB = await db.insert(projects).values({ orgId, key: fixtureKey('orgB'), name: 'B' }).returning({ id: projects.id });
  await db.insert(projectMembers).values([
    { orgId, projectId: pA[0]!.id, userId, role: 'admin' },
    { orgId, projectId: pB[0]!.id, userId, role: 'admin' },
  ]);
  ctxA = { userId, orgId, projectId: pA[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  ctxB = { userId, orgId, projectId: pB[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  await seedTemplateAgent(ctxA.projectId, 'Template A');
  bTemplateAgentId = await seedTemplateAgent(ctxB.projectId, 'Template B');
  const dept = await db.insert(departments).values({ orgId, key: `mkt-${randomUUID().slice(0, 6)}`, name: 'Marketing' }).returning({ id: departments.id });
  deptId = dept[0]!.id;
  const t = await db.insert(tasks).values({ orgId, projectId: ctxA.projectId, title: 'T', input: 'x', providerSelection: 'openai', status: 'pending', createdBy: userId }).returning({ id: tasks.id });
  taskAId = t[0]!.id;
  const o = await db.insert(objectives).values({ orgId, projectId: ctxA.projectId, title: 'O', status: 'draft', createdBy: userId }).returning({ id: objectives.id });
  objAId = o[0]!.id;
});

afterAll(async () => {
  if (!available) return;
  // Fixture workspaces (zz-fixture-*) are excluded from operational reads; archive
  // rather than delete (audit_logs is append-only and references the org).
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('org model — employees, reporting, ownership', () => {
  it('creates employees with title + department, and resolves the manager name', async () => {
    const aliceId = await withTenant(ctxA, (tx) => createEmployee(tx, ctxA, { name: 'Alice', title: 'CMO', departmentId: deptId }));
    await withTenant(ctxA, (tx) => createEmployee(tx, ctxA, { name: 'Bob', title: 'SDR', reportsToId: aliceId }));
    const emps = await withTenant(ctxA, (tx) => listEmployees(tx, ctxA));
    const alice = emps.find((e) => e.name === 'Alice')!;
    const bob = emps.find((e) => e.name === 'Bob')!;
    expect(alice.title).toBe('CMO');
    expect(alice.departmentName).toBe('Marketing');
    expect(bob.reportsToId).toBe(aliceId);
    expect(bob.managerName).toBe('Alice'); // manager resolved in-process
  });

  it('rejects self-report and an immediate circular reporting line', async () => {
    const x = await withTenant(ctxA, (tx) => createEmployee(tx, ctxA, { name: 'X' }));
    const y = await withTenant(ctxA, (tx) => createEmployee(tx, ctxA, { name: 'Y', reportsToId: x }));
    await expect(withTenant(ctxA, (tx) => updateEmployee(tx, ctxA, x, { reportsToId: x }))).rejects.toThrow(/report to themselves/i);
    // X reports to Y while Y already reports to X → 2-cycle refused.
    await expect(withTenant(ctxA, (tx) => updateEmployee(tx, ctxA, x, { reportsToId: y }))).rejects.toThrow(/circular/i);
  });

  it('assigns ownership on a task and an objective', async () => {
    const owner = await withTenant(ctxA, (tx) => createEmployee(tx, ctxA, { name: 'Owner1' }));
    await withTenant(ctxA, (tx) => setOwner(tx, ctxA, 'task', taskAId, owner));
    await withTenant(ctxA, (tx) => setOwner(tx, ctxA, 'objective', objAId, owner));
    const t = await getSetupDb().select({ o: tasks.ownerAgentId }).from(tasks).where(eq(tasks.id, taskAId));
    const o = await getSetupDb().select({ o: objectives.accountableAgentId }).from(objectives).where(eq(objectives.id, objAId));
    expect(t[0]!.o).toBe(owner);
    expect(o[0]!.o).toBe(owner);
    const owned = await withTenant(ctxA, (tx) => workOwnedBy(tx, ctxA, owner));
    expect(owned.tasks).toBe(1);
    expect(owned.objectives).toBe(1);
  });

  it('refuses a cross-workspace owner and a cross-workspace object', async () => {
    // Owner from workspace B cannot own a task in workspace A.
    await expect(withTenant(ctxA, (tx) => setOwner(tx, ctxA, 'task', taskAId, bTemplateAgentId))).rejects.toThrow(/not an employee in this workspace/i);
    // A task in workspace A is invisible when acting in workspace B → NotFound.
    await expect(withTenant(ctxB, (tx) => setOwner(tx, ctxB, 'task', taskAId, null))).rejects.toThrow();
  });
});
