import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { agents, auditLogs, knowledgeItems, memberships, organizations, profiles, projectMembers, projects } from '@/db/schema';
import { renameOrganization, MAX_ORG_NAME_CHARS } from '@/domain/organizations/organizations';
import { setWorkspaceArchiveState } from '@/domain/projects/settings';
import { verifyAuditChain } from '@/domain/audit/audit';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[company-activation.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

const orgIds: string[] = [];
const userIds: string[] = [];

interface Seed {
  orgId: string; projectId: string;
  ownerCtx: TenantContext; adminCtx: TenantContext; memberCtx: TenantContext;
  ownerId: string; adminId: string; memberId: string;
  enabledAgentId: string; dormantAgentId: string; knowledgeId: string;
}

async function seed(opts: { archived: boolean }): Promise<Seed> {
  const db = getSetupDb();
  const ownerId = randomUUID(), adminId = randomUUID(), memberId = randomUUID();
  for (const id of [ownerId, adminId, memberId]) {
    await db.insert(profiles).values({ id, email: `ca-${randomUUID().slice(0, 8)}@test.local`, displayName: 'U' });
    userIds.push(id);
  }
  const org = (await db.insert(organizations).values({ name: 'emperarecords\'s Company', slug: `ca-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!;
  const orgId = org.id; orgIds.push(orgId);
  await db.insert(memberships).values({ orgId, userId: ownerId, role: 'owner' });
  await db.insert(memberships).values({ orgId, userId: adminId, role: 'admin' });
  await db.insert(memberships).values({ orgId, userId: memberId, role: 'member' });
  const proj = (await db.insert(projects).values({ orgId, key: fixtureKey('ca'), name: 'Empera International', archived: opts.archived }).returning({ id: projects.id }))[0]!;
  const projectId = proj.id;
  await db.insert(projectMembers).values({ orgId, projectId, userId: ownerId, role: 'admin' });
  // child records that must survive an archive-state change
  const ea = (await db.insert(agents).values({ orgId, projectId, name: 'Enabled One', role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x', enabled: true }).returning({ id: agents.id }))[0]!;
  const da = (await db.insert(agents).values({ orgId, projectId, name: 'Dormant One', role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x', enabled: false }).returning({ id: agents.id }))[0]!;
  const ki = (await db.insert(knowledgeItems).values({ orgId, projectId, scope: 'project', kind: 'fact', title: 'O-23 historical', body: 'historical record', status: 'active', source: 'manual', createdBy: ownerId }).returning({ id: knowledgeItems.id }))[0]!;
  const base = { orgId, projectId };
  return {
    ...base, ownerId, adminId, memberId,
    ownerCtx: { ...base, userId: ownerId, orgRole: 'owner', projectRole: 'admin' },
    adminCtx: { ...base, userId: adminId, orgRole: 'admin', projectRole: 'admin' },
    memberCtx: { ...base, userId: memberId, orgRole: 'member', projectRole: 'viewer' },
    enabledAgentId: ea.id, dormantAgentId: da.id, knowledgeId: ki.id,
  };
}

const db = () => getSetupDb();
const auditCount = async (orgId: string, action: string) =>
  Number((await db().select({ n: sql<string>`count(*)` }).from(auditLogs).where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.action, action))))[0]!.n);
const orgName = async (orgId: string) => (await db().select({ name: organizations.name }).from(organizations).where(eq(organizations.id, orgId)))[0]!.name;
const orgSlug = async (orgId: string) => (await db().select({ slug: organizations.slug }).from(organizations).where(eq(organizations.id, orgId)))[0]!.slug;
const isArchived = async (projectId: string) => (await db().select({ a: projects.archived }).from(projects).where(eq(projects.id, projectId)))[0]!.a;

beforeAll(() => { /* per-test seeding */ });

afterAll(async () => {
  if (!available || orgIds.length === 0) return;
  const d = getSetupDb();
  await d.execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
  for (const o of orgIds) await d.delete(auditLogs).where(eq(auditLogs.orgId, o));
  await d.execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
  for (const o of orgIds) {
    await d.delete(knowledgeItems).where(eq(knowledgeItems.orgId, o));
    await d.delete(agents).where(eq(agents.orgId, o));
    await d.delete(projectMembers).where(eq(projectMembers.orgId, o));
    await d.delete(projects).where(eq(projects.orgId, o));
    await d.delete(memberships).where(eq(memberships.orgId, o));
    await d.delete(organizations).where(eq(organizations.id, o));
  }
  for (const u of userIds) await d.delete(profiles).where(eq(profiles.id, u));
});

describe('renameOrganization', () => {
  it('organization owner can rename; audit carries correct before/after + unchanged slug', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    const slugBefore = await orgSlug(s.orgId);
    const r = await db().transaction((tx) => renameOrganization(tx, s.ownerCtx, { newName: 'Empera International', reason: 'HQ activation' }));
    expect(r.from).toBe("emperarecords's Company");
    expect(r.to).toBe('Empera International');
    expect(await orgName(s.orgId)).toBe('Empera International');
    expect(await orgSlug(s.orgId)).toBe(slugBefore); // slug unchanged
    const ev = (await db().select().from(auditLogs).where(and(eq(auditLogs.orgId, s.orgId), eq(auditLogs.action, 'organization.renamed'))))[0]!;
    const detail = ev.detail as Record<string, unknown>;
    expect(detail.from).toBe("emperarecords's Company");
    expect(detail.to).toBe('Empera International');
    expect(detail.reason).toBe('HQ activation');
    expect(detail.slug).toBe(slugBefore);
    expect(detail.orgId).toBe(s.orgId);
    // org-level scope: entity is the organization, project_id is NULL, actor is the owner
    expect(ev.entityType).toBe('organization');
    expect(ev.entityId).toBe(s.orgId);
    expect(ev.orgId).toBe(s.orgId);
    expect(ev.projectId).toBeNull();
    expect(ev.actorId).toBe(s.ownerId);
  });

  it('organization admin (not owner) is rejected', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await expect(db().transaction((tx) => renameOrganization(tx, s.adminCtx, { newName: 'X', reason: 'r' }))).rejects.toThrow(/owner/i);
  });

  it('organization member is rejected', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await expect(db().transaction((tx) => renameOrganization(tx, s.memberCtx, { newName: 'X', reason: 'r' }))).rejects.toThrow(/owner/i);
  });

  it('empty name is rejected', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await expect(db().transaction((tx) => renameOrganization(tx, s.ownerCtx, { newName: '   ', reason: 'r' }))).rejects.toThrow(/name is required/i);
  });

  it('empty reason is rejected', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await expect(db().transaction((tx) => renameOrganization(tx, s.ownerCtx, { newName: 'Empera International', reason: '  ' }))).rejects.toThrow(/reason is required/i);
  });

  it('no-op rename is rejected', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await expect(db().transaction((tx) => renameOrganization(tx, s.ownerCtx, { newName: "emperarecords's Company", reason: 'r' }))).rejects.toThrow(/already has that name/i);
  });

  it('name-length limit is enforced', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    const tooLong = 'A'.repeat(MAX_ORG_NAME_CHARS + 1);
    await expect(db().transaction((tx) => renameOrganization(tx, s.ownerCtx, { newName: tooLong, reason: 'r' }))).rejects.toThrow(/too long/i);
  });

  it('org id and slug unchanged; memberships and projects unchanged', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    const slugBefore = await orgSlug(s.orgId);
    const memBefore = await db().select().from(memberships).where(eq(memberships.orgId, s.orgId));
    const projBefore = await db().select().from(projects).where(eq(projects.orgId, s.orgId));
    await db().transaction((tx) => renameOrganization(tx, s.ownerCtx, { newName: 'Empera International', reason: 'r' }));
    expect(await orgSlug(s.orgId)).toBe(slugBefore);
    const memAfter = await db().select().from(memberships).where(eq(memberships.orgId, s.orgId));
    const projAfter = await db().select().from(projects).where(eq(projects.orgId, s.orgId));
    expect(memAfter.length).toBe(memBefore.length);
    expect(projAfter.map((p) => `${p.id}:${p.key}:${p.archived}`).sort()).toEqual(projBefore.map((p) => `${p.id}:${p.key}:${p.archived}`).sort());
  });

  it('rename and audit are atomic (a throw after rename rolls both back)', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await expect(db().transaction(async (tx) => {
      await renameOrganization(tx, s.ownerCtx, { newName: 'Empera International', reason: 'r' });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await orgName(s.orgId)).toBe("emperarecords's Company");
    expect(await auditCount(s.orgId, 'organization.renamed')).toBe(0);
  });

  it('reversal works through the same operation', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await db().transaction((tx) => renameOrganization(tx, s.ownerCtx, { newName: 'Empera International', reason: 'activate' }));
    await db().transaction((tx) => renameOrganization(tx, s.ownerCtx, { newName: "emperarecords's Company", reason: 'revert' }));
    expect(await orgName(s.orgId)).toBe("emperarecords's Company");
    expect(await auditCount(s.orgId, 'organization.renamed')).toBe(2);
  });
});

describe('setWorkspaceArchiveState', () => {
  it('admin can restore an archived workspace; audit has before/after + reason', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    const r = await db().transaction((tx) => setWorkspaceArchiveState(tx, s.ownerCtx, { archived: false, reason: 'HQ activation' }));
    expect(r.from).toBe(true); expect(r.to).toBe(false);
    expect(await isArchived(s.projectId)).toBe(false);
    const ev = (await db().select().from(auditLogs).where(and(eq(auditLogs.orgId, s.orgId), eq(auditLogs.action, 'workspace.restored'))))[0]!;
    const detail = ev.detail as Record<string, unknown>;
    expect(detail.from).toBe(true); expect(detail.to).toBe(false);
    expect(detail.reason).toBe('HQ activation');
    expect(detail.workspaceId).toBe(s.projectId);
    expect(detail.orgId).toBe(s.orgId);
  });

  it('unauthorized (non-admin) is rejected', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await expect(db().transaction((tx) => setWorkspaceArchiveState(tx, s.memberCtx, { archived: false, reason: 'r' }))).rejects.toThrow(/admin/i);
  });

  it('empty reason is rejected', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await expect(db().transaction((tx) => setWorkspaceArchiveState(tx, s.ownerCtx, { archived: false, reason: ' ' }))).rejects.toThrow(/reason is required/i);
  });

  it('no-op restore is rejected', async () => {
    if (!available) return;
    const s = await seed({ archived: false });
    await expect(db().transaction((tx) => setWorkspaceArchiveState(tx, s.ownerCtx, { archived: false, reason: 'r' }))).rejects.toThrow(/not archived/i);
  });

  it('re-archiving produces workspace.archived with before/after', async () => {
    if (!available) return;
    const s = await seed({ archived: false });
    await db().transaction((tx) => setWorkspaceArchiveState(tx, s.ownerCtx, { archived: true, reason: 'archive it' }));
    expect(await isArchived(s.projectId)).toBe(true);
    const ev = (await db().select().from(auditLogs).where(and(eq(auditLogs.orgId, s.orgId), eq(auditLogs.action, 'workspace.archived'))))[0]!;
    const detail = ev.detail as Record<string, unknown>;
    expect(detail.from).toBe(false); expect(detail.to).toBe(true);
  });

  it('historical child records and employee enabled/dormant states are unchanged', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await db().transaction((tx) => setWorkspaceArchiveState(tx, s.ownerCtx, { archived: false, reason: 'r' }));
    const en = (await db().select({ enabled: agents.enabled }).from(agents).where(eq(agents.id, s.enabledAgentId)))[0]!;
    const dm = (await db().select({ enabled: agents.enabled }).from(agents).where(eq(agents.id, s.dormantAgentId)))[0]!;
    const ki = (await db().select({ title: knowledgeItems.title, body: knowledgeItems.body }).from(knowledgeItems).where(eq(knowledgeItems.id, s.knowledgeId)))[0]!;
    expect(en.enabled).toBe(true);
    expect(dm.enabled).toBe(false);
    expect(ki.title).toBe('O-23 historical');
    expect(ki.body).toBe('historical record');
  });

  it('restore and audit are atomic (a throw after restore rolls both back)', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await expect(db().transaction(async (tx) => {
      await setWorkspaceArchiveState(tx, s.ownerCtx, { archived: false, reason: 'r' });
      throw new Error('boom');
    })).rejects.toThrow('boom');
    expect(await isArchived(s.projectId)).toBe(true);
    expect(await auditCount(s.orgId, 'workspace.restored')).toBe(0);
  });
});

describe('combined company activation (rename + restore in one transaction)', () => {
  it('rename and restore commit together, using two trusted contexts, with correct audit scopes', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    // Two contexts inside ONE transaction: org-owner context (no project) for the rename,
    // workspace-admin context (projectId = HQ) for the restore.
    const orgCtx = { orgId: s.orgId, userId: s.ownerId }; // organization scope; projectId omitted → audit project_id NULL
    await db().transaction(async (tx) => {
      await renameOrganization(tx, orgCtx, { newName: 'Empera International', reason: 'activate HQ' });
      await setWorkspaceArchiveState(tx, s.ownerCtx, { archived: false, reason: 'activate HQ' });
    });
    expect(await orgName(s.orgId)).toBe('Empera International');
    expect(await isArchived(s.projectId)).toBe(false);
    expect(await auditCount(s.orgId, 'organization.renamed')).toBe(1);
    expect(await auditCount(s.orgId, 'workspace.restored')).toBe(1);

    // organization.renamed — organization scope, project_id NULL
    const renamed = (await db().select().from(auditLogs).where(and(eq(auditLogs.orgId, s.orgId), eq(auditLogs.action, 'organization.renamed'))))[0]!;
    expect(renamed.entityType).toBe('organization');
    expect(renamed.entityId).toBe(s.orgId);
    expect(renamed.orgId).toBe(s.orgId);
    expect(renamed.projectId).toBeNull();
    expect(renamed.actorId).toBe(s.ownerId);

    // workspace.restored — project scope, project_id = HQ workspace
    const restored = (await db().select().from(auditLogs).where(and(eq(auditLogs.orgId, s.orgId), eq(auditLogs.action, 'workspace.restored'))))[0]!;
    expect(restored.entityType).toBe('project');
    expect(restored.entityId).toBe(s.projectId);
    expect(restored.projectId).toBe(s.projectId);
    expect(restored.orgId).toBe(s.orgId);
    expect(restored.actorId).toBe(s.ownerId);
  });

  it('a forced failure AFTER rename rolls back BOTH changes', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await expect(db().transaction(async (tx) => {
      await renameOrganization(tx, s.ownerCtx, { newName: 'Empera International', reason: 'r' });
      throw new Error('boom-after-rename');
    })).rejects.toThrow('boom-after-rename');
    expect(await orgName(s.orgId)).toBe("emperarecords's Company");
    expect(await isArchived(s.projectId)).toBe(true);
    expect(await auditCount(s.orgId, 'organization.renamed')).toBe(0);
    expect(await auditCount(s.orgId, 'workspace.restored')).toBe(0);
  });

  it('a forced failure AFTER restore rolls back BOTH changes', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await expect(db().transaction(async (tx) => {
      await renameOrganization(tx, s.ownerCtx, { newName: 'Empera International', reason: 'r' });
      await setWorkspaceArchiveState(tx, s.ownerCtx, { archived: false, reason: 'r' });
      throw new Error('boom-after-restore');
    })).rejects.toThrow('boom-after-restore');
    expect(await orgName(s.orgId)).toBe("emperarecords's Company");
    expect(await isArchived(s.projectId)).toBe(true);
    expect(await auditCount(s.orgId, 'organization.renamed')).toBe(0);
    expect(await auditCount(s.orgId, 'workspace.restored')).toBe(0);
  });

  it('audit-chain verification remains valid after activation', async () => {
    if (!available) return;
    const s = await seed({ archived: true });
    await db().transaction(async (tx) => {
      await renameOrganization(tx, s.ownerCtx, { newName: 'Empera International', reason: 'r' });
      await setWorkspaceArchiveState(tx, s.ownerCtx, { archived: false, reason: 'r' });
    });
    const v = await db().transaction((tx) => verifyAuditChain(tx, s.ownerCtx));
    expect(v.overallStatus).toBe('clean');
    expect(v.missingPredecessors).toBe(0);
    expect(v.unknownDivergences).toBe(0);
    expect(v.linearLinkFailures).toBe(0);
  });

  it('a recognized historical fork stays recognized and byte-unchanged across an activation', async () => {
    if (!available) return;
    const KNOWN = '6b48a209-229c-4b75-ab6f-638e9fcb8345'; // a documented historical fork id
    const s = await seed({ archived: true });
    // craft a tiny chain + one recognized fork (bypass the append-only trigger only for this fixture insert)
    await db().execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
    await db().insert(auditLogs).values({ orgId: s.orgId, projectId: s.projectId, actorId: s.ownerId, action: 'crafted', entityType: 'x', entityId: null, detail: {}, prevHash: 'G', rowHash: 'H1' } as never);
    await db().insert(auditLogs).values({ orgId: s.orgId, projectId: s.projectId, actorId: s.ownerId, action: 'crafted', entityType: 'x', entityId: null, detail: {}, prevHash: 'H1', rowHash: 'H2' } as never);
    await db().insert(auditLogs).values({ id: KNOWN, orgId: s.orgId, projectId: s.projectId, actorId: s.ownerId, action: 'crafted', entityType: 'x', entityId: null, detail: {}, prevHash: 'H1', rowHash: 'H3' } as never);
    await db().execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
    const forkBefore = (await db().select({ prevHash: auditLogs.prevHash, rowHash: auditLogs.rowHash }).from(auditLogs).where(eq(auditLogs.id, KNOWN)))[0]!;
    // a real activation appends live events off the current head
    await db().transaction(async (tx) => {
      await renameOrganization(tx, s.ownerCtx, { newName: 'Empera International', reason: 'r' });
      await setWorkspaceArchiveState(tx, s.ownerCtx, { archived: false, reason: 'r' });
    });
    const v = await db().transaction((tx) => verifyAuditChain(tx, s.ownerCtx));
    expect(v.overallStatus).toBe('recognized_historical_forks');
    expect(v.recognizedHistoricalForks).toBe(1);
    expect(v.affectedRowIds.recognizedHistoricalForks).toContain(KNOWN);
    expect(v.missingPredecessors).toBe(0);
    expect(v.unknownDivergences).toBe(0);
    const forkAfter = (await db().select({ prevHash: auditLogs.prevHash, rowHash: auditLogs.rowHash }).from(auditLogs).where(eq(auditLogs.id, KNOWN)))[0]!;
    expect(forkAfter).toEqual(forkBefore); // fork row never rewritten
  });
});
