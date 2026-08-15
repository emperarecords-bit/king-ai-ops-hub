import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withOrg } from '@/db/tenant';
import {
  agents,
  auditLogs,
  departments,
  knowledgeItems,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  spendLimits,
} from '@/db/schema';
import { getToolDefinition } from '@/domain/mcp/tools';
import { getPositionTemplate } from '@/domain/agents/position-templates';

/**
 * MCP provisioning tools (create_workspace / staff_positions) — the voice-partner
 * path. Exercises the real org-scope → workspace-scope transition the server
 * performs (withOrg + handler stamps app.project_id mid-transaction), against a
 * live database with RLS enforced.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[mcp-provisioning.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let ownerId = '', memberId = '', orgId = '';

const ownerCtx = (): TenantContext => ({
  // The server passes the token's project-bound ctx; org tools use only userId/orgId
  // and derive everything else themselves, so a random projectId here proves that.
  userId: ownerId,
  orgId,
  projectId: randomUUID(),
  orgRole: 'owner',
  projectRole: 'admin',
});

async function callOrgTool(name: string, ctx: TenantContext, args: unknown): Promise<unknown> {
  const def = getToolDefinition(name)!;
  expect(def.scope).toBe('org');
  return withOrg({ userId: ctx.userId, orgId: ctx.orgId }, (tx) => def.handler(tx, ctx, args));
}

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  ownerId = randomUUID();
  memberId = randomUUID();
  await db.insert(profiles).values({ id: ownerId, email: `mp-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  await db.insert(profiles).values({ id: memberId, email: `mp-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Member' });
  const org = (
    await db.insert(organizations).values({ name: 'MCP Prov Org', slug: `mp-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id })
  )[0]!;
  orgId = org.id;
  await db.insert(memberships).values({ orgId, userId: ownerId, role: 'owner' });
  await db.insert(memberships).values({ orgId, userId: memberId, role: 'member' });
});

afterAll(async () => {
  if (!available || !orgId) return;
  const db = getSetupDb();
  await db.execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
  await db.delete(auditLogs).where(eq(auditLogs.orgId, orgId));
  await db.execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
  await db.delete(knowledgeItems).where(eq(knowledgeItems.orgId, orgId));
  await db.delete(spendLimits).where(eq(spendLimits.orgId, orgId));
  await db.delete(agents).where(eq(agents.orgId, orgId));
  await db.delete(projectMembers).where(eq(projectMembers.orgId, orgId));
  await db.delete(projects).where(eq(projects.orgId, orgId));
  await db.delete(departments).where(eq(departments.orgId, orgId));
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(profiles).where(eq(profiles.id, ownerId));
  await db.delete(profiles).where(eq(profiles.id, memberId));
});

describe('create_workspace tool', () => {
  it('provisions workspace + default staff + requested positions in ONE transaction, with correct departments and AI configs', async () => {
    if (!available) return;
    const out = (await callOrgTool('create_workspace', ownerCtx(), {
      name: 'Bakery Test',
      description: 'A neighborhood bakery.',
      positions: [{ position: 'operations_manager' }, { position: 'marketing_lead' }, { position: 'quality_reviewer' }],
      reason: 'integration test — voice provisioning',
    })) as { projectId: string; projectKey: string; defaultStaff: number; hires: Array<{ position: string; employeeId: string; created: boolean }> };

    expect(out.projectKey).toBe('bakery-test');
    expect(out.defaultStaff).toBe(4);
    expect(out.hires).toHaveLength(3);
    expect(out.hires.every((h) => h.created)).toBe(true);

    const db = getSetupDb();
    const staff = await db
      .select({ name: agents.name, title: agents.title, provider: agents.provider, model: agents.model, role: agents.role, departmentId: agents.departmentId })
      .from(agents)
      .where(eq(agents.projectId, out.projectId));
    expect(staff).toHaveLength(7); // 4 default engineers + 3 hires

    const om = staff.find((s) => s.title === 'Operations Manager')!;
    const omTemplate = getPositionTemplate('operations_manager')!;
    expect(om.provider).toBe(omTemplate.provider);
    expect(om.model).toBe(omTemplate.model);
    const opsDept = (
      await db.select({ id: departments.id }).from(departments).where(eq(departments.orgId, orgId)).then((rows) => rows)
    );
    expect(opsDept.map((d) => d.id)).toContain(om.departmentId);

    const reviewer = staff.find((s) => s.title === 'Quality Reviewer')!;
    expect(reviewer.role).toBe('reviewer');
  });

  it('rejects a non-admin org member', async () => {
    if (!available) return;
    const ctx: TenantContext = { userId: memberId, orgId, projectId: randomUUID(), orgRole: 'member', projectRole: 'member' };
    await expect(
      callOrgTool('create_workspace', ctx, { name: 'Nope WS', reason: 'should fail' }),
    ).rejects.toThrow(/owner or admin/i);
  });
});

describe('staff_positions tool', () => {
  it('hires into an existing workspace by key; a byte-identical retry is an idempotent no-op', async () => {
    if (!available) return;
    const first = (await callOrgTool('staff_positions', ownerCtx(), {
      projectKey: 'bakery-test',
      positions: [{ position: 'customer_support' }],
      reason: 'integration test — staffing',
    })) as { hires: Array<{ employeeId: string; created: boolean }> };
    expect(first.hires[0]!.created).toBe(true);

    const retry = (await callOrgTool('staff_positions', ownerCtx(), {
      projectKey: 'bakery-test',
      positions: [{ position: 'customer_support' }],
      reason: 'integration test — staffing',
    })) as { hires: Array<{ employeeId: string; created: boolean }> };
    expect(retry.hires[0]!.created).toBe(false);
    expect(retry.hires[0]!.employeeId).toBe(first.hires[0]!.employeeId);
  });

  it('honors per-hire provider/model overrides through the catalog gate', async () => {
    if (!available) return;
    const out = (await callOrgTool('staff_positions', ownerCtx(), {
      projectKey: 'bakery-test',
      businessName: 'Bakery Test',
      positions: [{ position: 'researcher', name: 'Premium Researcher', provider: 'anthropic', model: 'claude-sonnet-5' }],
      reason: 'integration test — override',
    })) as { hires: Array<{ employeeId: string }> };
    const db = getSetupDb();
    const row = (
      await db.select({ provider: agents.provider, model: agents.model }).from(agents).where(eq(agents.id, out.hires[0]!.employeeId))
    )[0]!;
    expect(row.provider).toBe('anthropic');
    expect(row.model).toBe('claude-sonnet-5');

    await expect(
      callOrgTool('staff_positions', ownerCtx(), {
        projectKey: 'bakery-test',
        positions: [{ position: 'researcher', name: 'Broken Hire', provider: 'google', model: 'gpt-5.4' }],
        reason: 'cross-vendor must fail',
      }),
    ).rejects.toThrow(/not available for provider/i);
  });

  it('404s on a workspace outside the org and refuses archived targets', async () => {
    if (!available) return;
    await expect(
      callOrgTool('staff_positions', ownerCtx(), {
        projectKey: 'does-not-exist-anywhere',
        positions: [{ position: 'researcher' }],
        reason: 'should 404',
      }),
    ).rejects.toThrow(/not found/i);
  });
});
