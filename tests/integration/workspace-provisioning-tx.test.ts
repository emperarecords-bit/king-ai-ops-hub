import { randomUUID } from 'node:crypto';
import { and, eq, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { agents, auditLogs, knowledgeItems, memberships, organizations, profiles, projectMembers, projects, spendLimits } from '@/db/schema';
import { createWorkspaceWithStaff } from '@/domain/projects/provision';
import { createEmployeeWithConfig } from '@/domain/agents/org';
import { updateAgent } from '@/domain/agents/agents';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[workspace-provisioning-tx.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let userId = '', memberUserId = '', orgId = '', org2Id = '';

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  memberUserId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `wp-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  await db.insert(profiles).values({ id: memberUserId, email: `wp-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Member' });
  const org = (await db.insert(organizations).values({ name: 'Org', slug: `wp-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!;
  orgId = org.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  await db.insert(memberships).values({ orgId, userId: memberUserId, role: 'member' });
  const org2 = (await db.insert(organizations).values({ name: 'Org2', slug: `wp2-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!;
  org2Id = org2.id; // userId is NOT a member of org2
});

afterAll(async () => {
  if (!available || !orgId) return;
  const db = getSetupDb();
  await db.execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
  for (const o of [orgId, org2Id]) await db.delete(auditLogs).where(eq(auditLogs.orgId, o));
  await db.execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
  for (const o of [orgId, org2Id]) {
    await db.delete(knowledgeItems).where(eq(knowledgeItems.orgId, o));
    await db.delete(spendLimits).where(eq(spendLimits.orgId, o));
    await db.delete(agents).where(eq(agents.orgId, o));
    await db.delete(projectMembers).where(eq(projectMembers.orgId, o));
    await db.delete(projects).where(eq(projects.orgId, o));
    await db.delete(memberships).where(eq(memberships.orgId, o));
    await db.delete(organizations).where(eq(organizations.id, o));
  }
  await db.delete(profiles).where(eq(profiles.id, userId));
  await db.delete(profiles).where(eq(profiles.id, memberUserId));
});

const actor = () => ({ userId, orgId });

describe('createWorkspaceWithStaff', () => {
  it('provisions workspace + 4 staff + charter + spend-limit + workspace.created atomically; returned IDs match stored', async () => {
    if (!available) return;
    const db = getSetupDb();
    const ws = await db.transaction((tx) => createWorkspaceWithStaff(tx, actor(), { name: 'Alpha WS', reason: 'test' }));
    expect(ws.projectKey).toBe('alpha-ws');
    const proj = (await db.select().from(projects).where(eq(projects.id, ws.projectId)))[0]!;
    expect(proj.key).toBe('alpha-ws');
    const staff = await db.select({ id: agents.id, name: agents.name }).from(agents).where(eq(agents.projectId, ws.projectId));
    expect(staff.length).toBe(4);
    const byName = new Map(staff.map((s) => [s.name, s.id]));
    expect(byName.get('Lead Engineer')).toBe(ws.leadEngineerId);
    expect(byName.get('Principal Reviewer')).toBe(ws.principalReviewerId);
    const spend = (await db.select().from(spendLimits).where(eq(spendLimits.id, ws.spendLimitId)))[0]!;
    expect(spend.projectId).toBe(ws.projectId);
    const charter = (await db.select().from(knowledgeItems).where(eq(knowledgeItems.id, ws.charterKnowledgeId)))[0]!;
    expect(charter.title).toBe('Workspace charter');
    const ev = (await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, ws.projectId), eq(auditLogs.action, 'workspace.created'))))[0]!;
    const d = ev.detail as Record<string, unknown>;
    expect(d.defaultStaffCount).toBe(4);
    expect((d.defaultStaffIds as Record<string, string>).leadEngineerId).toBe(ws.leadEngineerId);
    expect(d.charterKnowledgeId).toBe(ws.charterKnowledgeId);
    expect(d.spendLimitId).toBe(ws.spendLimitId);
  });

  it('composes with createEmployeeWithConfig (reportsTo = returned Lead Engineer) and updateAgent dormancy in ONE transaction', async () => {
    if (!available) return;
    const db = getSetupDb();
    const out = await db.transaction(async (tx) => {
      const ws = await createWorkspaceWithStaff(tx, actor(), { name: 'Beta WS', reason: 'test' });
      const ctx: TenantContext = { userId, orgId, projectId: ws.projectId, orgRole: 'owner', projectRole: 'admin' };
      const emp = await createEmployeeWithConfig(tx, ctx, { name: 'Data Engineer', role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'You build data.', reportsToAgentId: ws.leadEngineerId, reason: 'r' });
      await updateAgent(tx, ctx, ws.seniorEngineerId, { enabled: false });
      return { ws, empId: emp.employeeId };
    });
    const emp = (await db.select().from(agents).where(eq(agents.id, out.empId)))[0]!;
    expect(emp.reportsToId).toBe(out.ws.leadEngineerId);
    const senior = (await db.select({ enabled: agents.enabled }).from(agents).where(eq(agents.id, out.ws.seniorEngineerId)))[0]!;
    expect(senior.enabled).toBe(false);
  });

  it('a forced failure rolls back the ENTIRE workspace batch (no project, staff, or audit persist)', async () => {
    if (!available) return;
    const db = getSetupDb();
    await expect(db.transaction(async (tx) => {
      const ws = await createWorkspaceWithStaff(tx, actor(), { name: 'Rollback WS', reason: 'r' });
      const ctx: TenantContext = { userId, orgId, projectId: ws.projectId, orgRole: 'owner', projectRole: 'admin' };
      await createEmployeeWithConfig(tx, ctx, { name: 'Temp', role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x', reason: 'r' });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    // whole batch rolled back: no project, and no workspace.created audit event for it
    expect((await db.select().from(projects).where(and(eq(projects.orgId, orgId), eq(projects.key, 'rollback-ws')))).length).toBe(0);
    expect((await db.select().from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, 'workspace.created'), sql`(detail->>'key') = 'rollback-ws'`))).length).toBe(0);
  });

  it('rejects a duplicate normalized key with NO suffix, and case variants map to the same key', async () => {
    if (!available) return;
    const db = getSetupDb();
    await db.transaction((tx) => createWorkspaceWithStaff(tx, actor(), { name: 'Dup WS', reason: 'r' }));
    await expect(db.transaction((tx) => createWorkspaceWithStaff(tx, actor(), { name: 'Dup WS', reason: 'r' }))).rejects.toThrow(/already exists/i);
    await expect(db.transaction((tx) => createWorkspaceWithStaff(tx, actor(), { name: 'DUP WS', reason: 'r' }))).rejects.toThrow(/already exists/i);
    await expect(db.transaction((tx) => createWorkspaceWithStaff(tx, actor(), { name: 'dup ws', reason: 'r' }))).rejects.toThrow(/already exists/i);
    const rows = await db.select().from(projects).where(and(eq(projects.orgId, orgId), like(projects.key, 'dup-ws%')));
    expect(rows.length).toBe(1); // no dup-ws-2 created
  });

  it('rejects an unauthorized actor (org member, not owner/admin)', async () => {
    if (!available) return;
    const db = getSetupDb();
    await expect(db.transaction((tx) => createWorkspaceWithStaff(tx, { userId: memberUserId, orgId }, { name: 'NoAuth WS', reason: 'r' }))).rejects.toThrow(/owner or admin/i);
  });

  it('rejects cross-organization provisioning (actor not a member of the target org)', async () => {
    if (!available) return;
    const db = getSetupDb();
    await expect(db.transaction((tx) => createWorkspaceWithStaff(tx, { userId, orgId: org2Id }, { name: 'Cross WS', reason: 'r' }))).rejects.toThrow(/not a member/i);
  });
});
