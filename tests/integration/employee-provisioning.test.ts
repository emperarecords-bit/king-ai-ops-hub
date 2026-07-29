import { randomUUID } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { sha256Hex } from '@/lib/crypto';
import { agents, auditLogs, departments, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { createEmployeeWithConfig, type CreateEmployeeWithConfigInput } from '@/domain/agents/org';

/**
 * Audited full-config employee provisioning (createEmployeeWithConfig). Typed, admin-gated, transactional,
 * with deterministic ON CONFLICT idempotency and a prompt-hash-only audit payload.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[employee-provisioning.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let ctx: TenantContext; // workspace A, admin
let ctx2: TenantContext; // workspace B, admin
let deptId = '';
let managerAId = ''; // an employee in A (valid manager)
let agentBId = ''; // an employee in B (cross-workspace manager reject)

const base = (over: Partial<CreateEmployeeWithConfigInput> = {}): CreateEmployeeWithConfigInput => ({
  name: `E-${randomUUID().slice(0, 8)}`,
  title: 'Some Title',
  role: 'primary',
  provider: 'openai',
  model: 'gpt-5.4-mini',
  systemPrompt: 'You are a test employee. Work only from provided context.',
  reason: 'test provisioning',
  ...over,
});

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `ep-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Admin' });
  const org = await db.insert(organizations).values({ name: 'Org', slug: `ep-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const pA = await db.insert(projects).values({ orgId, key: fixtureKey('ep-a'), name: 'A' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: pA[0]!.id, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: pA[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  const pB = await db.insert(projects).values({ orgId, key: fixtureKey('ep-b'), name: 'B' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: pB[0]!.id, userId, role: 'admin' });
  ctx2 = { userId, orgId, projectId: pB[0]!.id, orgRole: 'owner', projectRole: 'admin' };
  const dept = await db.insert(departments).values({ orgId, key: 'engineering', name: 'Engineering' }).returning({ id: departments.id });
  deptId = dept[0]!.id;

  managerAId = (await withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'Manager A', role: 'primary' })))).employeeId;
  agentBId = (await withTenant(ctx2, (tx) => createEmployeeWithConfig(tx, ctx2, base({ name: 'Agent B' })))).employeeId;
});

afterAll(async () => {
  if (!available || !orgId) return;
  const db = getSetupDb();
  await db.execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
  await db.delete(auditLogs).where(eq(auditLogs.orgId, orgId));
  await db.execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
  await db.delete(agents).where(eq(agents.orgId, orgId));
  await db.delete(departments).where(eq(departments.orgId, orgId));
  await db.delete(projectMembers).where(eq(projectMembers.orgId, orgId));
  await db.delete(projects).where(eq(projects.orgId, orgId));
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(profiles).where(eq(profiles.id, userId));
});

describe('createEmployeeWithConfig', () => {
  it('creates an OpenAI primary and an Anthropic reviewer with exact stored config', async () => {
    if (!available) return;
    const db = getSetupDb();
    const prim = await withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'Prim1', role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', departmentId: deptId, temperatureMilli: 640, maxOutputTokens: 2048 })));
    const rev = await withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'Rev1', role: 'reviewer', provider: 'anthropic', model: 'claude-sonnet-5' })));
    expect(prim.created).toBe(true);
    expect(rev.created).toBe(true);
    const p = (await db.select().from(agents).where(eq(agents.id, prim.employeeId)))[0]!;
    expect({ provider: p.provider, model: p.model, role: p.role, temp: p.temperatureMilli, max: p.maxOutputTokens, cls: p.classification, enabled: p.enabled, dept: p.departmentId }).toEqual({ provider: 'openai', model: 'gpt-5.4-mini', role: 'primary', temp: 640, max: 2048, cls: 'live', enabled: true, dept: deptId });
    const r = (await db.select().from(agents).where(eq(agents.id, rev.employeeId)))[0]!;
    expect(r.provider).toBe('anthropic');
    expect(r.model).toBe('claude-sonnet-5');
    expect(r.role).toBe('reviewer');
  });

  it('audit employee.created carries a prompt hash, never the prompt text', async () => {
    if (!available) return;
    const db = getSetupDb();
    const secret = 'UNIQUE-MISSION-SECRET-9f3a: verify contractor invoicing.';
    const res = await withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'Audited1', systemPrompt: `You are Audited1. ${secret}` })));
    const ev = (await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, res.employeeId), eq(auditLogs.action, 'employee.created'))))[0]!;
    const detail = ev.detail as Record<string, unknown>;
    expect(detail.promptHash).toBe(sha256Hex(`You are Audited1. ${secret}`));
    expect(JSON.stringify(detail)).not.toContain(secret);
    expect(detail.provider).toBe('openai');
    expect(detail.classification).toBe('live');
  });

  it('identical retry returns the same id with created:false and writes NO second audit', async () => {
    if (!available) return;
    const db = getSetupDb();
    const input = base({ name: 'Idem1', title: 'T', role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', temperatureMilli: 700, maxOutputTokens: 4096 });
    const first = await withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, input));
    const second = await withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, input));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.employeeId).toBe(first.employeeId);
    const n = (await db.select({ n: count() }).from(auditLogs).where(and(eq(auditLogs.entityId, first.employeeId), eq(auditLogs.action, 'employee.created'))))[0]!.n;
    expect(Number(n)).toBe(1);
  });

  it('rejects a same-name request with a different title / prompt / limits (no silent overwrite)', async () => {
    if (!available) return;
    const nm = 'Collide1';
    await withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: nm, title: 'A', temperatureMilli: 700, maxOutputTokens: 4096, systemPrompt: 'prompt one' })));
    await expect(withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: nm, title: 'DIFFERENT' })))).rejects.toThrow(/already exists/i);
    await expect(withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: nm, title: 'A', systemPrompt: 'prompt two' })))).rejects.toThrow(/already exists/i);
    await expect(withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: nm, title: 'A', systemPrompt: 'prompt one', maxOutputTokens: 8192 })))).rejects.toThrow(/already exists/i);
  });

  it('conflict path does NOT abort the transaction — a later insert in the same tx still succeeds', async () => {
    if (!available) return;
    const out = await withTenant(ctx, async (tx) => {
      const x = await createEmployeeWithConfig(tx, ctx, base({ name: 'TxX', systemPrompt: 'x' }));
      const dup = await createEmployeeWithConfig(tx, ctx, base({ name: 'TxX', systemPrompt: 'x' })); // conflict → no-op
      const y = await createEmployeeWithConfig(tx, ctx, base({ name: 'TxY', systemPrompt: 'y' })); // must still work
      return { x, dup, y };
    });
    expect(out.x.created).toBe(true);
    expect(out.dup.created).toBe(false);
    expect(out.y.created).toBe(true);
  });

  it('rejects provider/model mismatch and unknown model', async () => {
    if (!available) return;
    await expect(withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'Bad1', provider: 'anthropic', model: 'gpt-5.4-mini' })))).rejects.toThrow(/not available for provider/i);
    await expect(withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'Bad2', model: 'not-a-real-model' })))).rejects.toThrow(/Unknown model/i);
  });

  it('rejects non-admin, cross-workspace manager, invalid department', async () => {
    if (!available) return;
    const member: TenantContext = { ...ctx, projectRole: 'member' };
    await expect(withTenant(member, (tx) => createEmployeeWithConfig(tx, member, base({ name: 'NoAdmin' })))).rejects.toThrow(/admin/i);
    await expect(withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'CrossMgr', reportsToAgentId: agentBId })))).rejects.toThrow(/not an employee in this workspace/i);
    await expect(withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'BadDept', departmentId: randomUUID() })))).rejects.toThrow(/not in this workspace/i);
  });

  it('accepts a valid same-workspace manager', async () => {
    if (!available) return;
    const r = await withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'Reports1', reportsToAgentId: managerAId })));
    expect(r.created).toBe(true);
  });

  it('rejects empty name, prompt, or reason', async () => {
    if (!available) return;
    await expect(withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: '   ' })))).rejects.toThrow(/name is required/i);
    await expect(withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'EP1', systemPrompt: '   ' })))).rejects.toThrow(/prompt is required/i);
    await expect(withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'EP2', reason: '  ' })))).rejects.toThrow(/reason is required/i);
  });

  it('enforces workspace isolation — a name created in A can still be created in B', async () => {
    if (!available) return;
    const a = await withTenant(ctx, (tx) => createEmployeeWithConfig(tx, ctx, base({ name: 'IsoName', systemPrompt: 'a' })));
    const b = await withTenant(ctx2, (tx) => createEmployeeWithConfig(tx, ctx2, base({ name: 'IsoName', systemPrompt: 'b' })));
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.employeeId).not.toBe(b.employeeId);
  });

  it('the org audit chain remains valid (prev_hash linkage) after provisioning', async () => {
    if (!available) return;
    const db = getSetupDb();
    const rows = await db.select({ seq: auditLogs.seq, prevHash: auditLogs.prevHash, rowHash: auditLogs.rowHash }).from(auditLogs).where(eq(auditLogs.orgId, orgId)).orderBy(auditLogs.seq);
    let breaks = 0;
    for (let i = 1; i < rows.length; i++) if (rows[i]!.prevHash !== rows[i - 1]!.rowHash) breaks++;
    expect(breaks).toBe(0);
    expect(rows.length).toBeGreaterThan(0);
  });
});
