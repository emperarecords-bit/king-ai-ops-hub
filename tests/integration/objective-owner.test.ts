import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, auditLogs, memberships, objectives, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { createObjective, getObjective, listObjectives, setObjectiveOwner } from '@/domain/objectives/objectives';
import { setOwner } from '@/domain/agents/org';

/**
 * HUB-005 — objective-owner persistence. The canonical field is the single `objectives.accountable_agent_id`.
 * Assignment persists, displays even when the employee is later disabled, is idempotent, admin-gated,
 * same-workspace, and emits distinct append-only audit events.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[objective-owner.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let ctx: TenantContext; // workspace A, admin
let ctx2: TenantContext; // workspace B, admin — for cross-workspace rejection

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `oo-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Admin' });
  const org = await db.insert(organizations).values({ name: 'Org', slug: `oo-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('oo'), name: 'A' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  const p2 = await db.insert(projects).values({ orgId, key: fixtureKey('oo2'), name: 'B' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p2[0]!.id, userId, role: 'admin' });
  ctx2 = { userId, orgId, projectId: p2[0]!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

// ---- helpers -------------------------------------------------------------
async function objective(title = 'An objective', project = ctx): Promise<string> {
  return withTenant(project, (tx) =>
    createObjective(tx, project, { title, description: '', successCriteria: [{ label: 'One', metric: 'm', target: 1, unit: '' }] }),
  );
}
async function employee(name: string, project = ctx): Promise<string> {
  // Insert an agent directly (createEmployee clones an existing employee's AI config; a raw insert keeps
  // this fixture self-contained). Defaults mirror a normal employee: primary role, enabled.
  const r = await getSetupDb()
    .insert(agents)
    .values({ orgId, projectId: project.projectId, name, provider: 'openai', model: 'gpt-x', systemPrompt: 'x' })
    .returning({ id: agents.id });
  return r[0]!.id;
}
async function ownerOf(objId: string): Promise<string | null> {
  const r = await getSetupDb().select({ o: objectives.accountableAgentId }).from(objectives).where(eq(objectives.id, objId));
  return r[0]!.o;
}
async function disable(agentId: string): Promise<void> {
  await getSetupDb().update(agents).set({ enabled: false }).where(eq(agents.id, agentId));
}
async function ownerEvents(objId: string, action: string): Promise<number> {
  const r = await getSetupDb().select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityId, objId), eq(auditLogs.action, action)));
  return r.length;
}

describe.skipIf(!available)('HUB-005 objective-owner persistence', () => {
  it('assigns an owner: persists the canonical FK + emits objective.owner_assigned', async () => {
    const objId = await objective('Assignable');
    const emp = await employee('Owner A');
    await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, emp));
    expect(await ownerOf(objId)).toBe(emp);
    expect(await ownerEvents(objId, 'objective.owner_assigned')).toBe(1);
    // Read-back through the canonical read (what every surface uses) reflects it.
    const detail = await withTenant(ctx, (tx) => getObjective(tx, ctx, objId));
    expect(detail.accountableAgentId).toBe(emp);
    expect(detail.accountableEmployee).toBe('Owner A');
  });

  it('changes an owner: emits objective.owner_changed', async () => {
    const objId = await objective('Changeable');
    const a = await employee('First');
    const b = await employee('Second');
    await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, a));
    await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, b));
    expect(await ownerOf(objId)).toBe(b);
    expect(await ownerEvents(objId, 'objective.owner_changed')).toBe(1);
  });

  it('clears an owner: emits objective.owner_cleared', async () => {
    const objId = await objective('Clearable');
    const a = await employee('Temp');
    await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, a));
    await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, null));
    expect(await ownerOf(objId)).toBeNull();
    expect(await ownerEvents(objId, 'objective.owner_cleared')).toBe(1);
  });

  it('is idempotent: repeating the same assignment writes no second event', async () => {
    const objId = await objective('Idempotent');
    const a = await employee('Same');
    await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, a));
    await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, a));
    await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, a));
    expect(await ownerOf(objId)).toBe(a);
    expect(await ownerEvents(objId, 'objective.owner_assigned')).toBe(1);
  });

  it('rejects a cross-workspace employee', async () => {
    const objId = await objective('Cross');
    const foreign = await employee('Foreign', ctx2);
    await expect(withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, foreign))).rejects.toThrow(/not an employee in this workspace/i);
    expect(await ownerOf(objId)).toBeNull();
  });

  it('rejects a missing employee', async () => {
    const objId = await objective('Missing');
    await expect(withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, randomUUID()))).rejects.toThrow(/not an employee/i);
  });

  it('refuses assigning a DISABLED employee as a new owner', async () => {
    const objId = await objective('Disabled-guard');
    const emp = await employee('Benched');
    await disable(emp);
    await expect(withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, emp))).rejects.toThrow(/disabled/i);
    expect(await ownerOf(objId)).toBeNull();
  });

  it('keeps historical ownership visible if the owner is disabled AFTER assignment', async () => {
    const objId = await objective('History');
    const emp = await employee('Was Active');
    await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, emp));
    await disable(emp); // later disabled
    // The canonical read still resolves the owner + name (the join has no enabled filter) → the UI can
    // render it (the objective page unions the current owner into the picker options).
    const detail = await withTenant(ctx, (tx) => getObjective(tx, ctx, objId));
    expect(detail.accountableAgentId).toBe(emp);
    expect(detail.accountableEmployee).toBe('Was Active');
    // Re-assigning to the SAME (now-disabled) owner is an idempotent no-op, not a rejected new assignment.
    await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, emp));
    expect(await ownerOf(objId)).toBe(emp);
  });

  it('requires admin authority (a member is refused)', async () => {
    const objId = await objective('Admin-only');
    const emp = await employee('Wannabe');
    const member = { ...ctx, projectRole: 'member' as const };
    await expect(withTenant(member, (tx) => setObjectiveOwner(tx, member, objId, emp))).rejects.toThrow(/admin/i);
    expect(await ownerOf(objId)).toBeNull();
  });

  it('persists across a fresh read and stays consistent between objective list and detail', async () => {
    const objId = await objective('Consistent');
    const emp = await employee('Consistent Owner');
    await withTenant(ctx, (tx) => setObjectiveOwner(tx, ctx, objId, emp));
    // Fresh detail read (simulates refresh / new request).
    const detail = await withTenant(ctx, (tx) => getObjective(tx, ctx, objId));
    // List read (feeds objectives list + Dashboard/briefing progress views).
    const list = await withTenant(ctx, (tx) => listObjectives(tx, ctx));
    const row = list.find((o) => o.id === objId)!;
    expect(detail.accountableEmployee).toBe('Consistent Owner');
    expect(row.accountableEmployee).toBe('Consistent Owner');
  });

  it('setOwner("objective", …) routes through the canonical function (one write path)', async () => {
    const objId = await objective('Routed');
    const emp = await employee('Routed Owner');
    await withTenant(ctx, (tx) => setOwner(tx, ctx, 'objective', objId, emp));
    expect(await ownerOf(objId)).toBe(emp);
    // It emits the distinct HUB-005 event, not the generic ownership.assigned.
    expect(await ownerEvents(objId, 'objective.owner_assigned')).toBe(1);
    expect(await ownerEvents(objId, 'ownership.assigned')).toBe(0);
  });
});
