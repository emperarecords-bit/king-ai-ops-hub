import { createHash, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import {
  agents,
  approvals,
  auditLogs,
  knowledgeItems,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  spendLimits,
  tasks,
} from '@/db/schema';
import { createWorkspaceWithStaff } from '@/domain/projects/provision';
import { createTask } from '@/domain/tasks/tasks';
import { decideApproval } from '@/domain/approvals/approvals';
import { ownerInbox } from '@/domain/inbox/inbox';

/**
 * Owner Inbox (EV-011 follow-up) — live-DB integration. Proves the cross-
 * workspace aggregation: pending approvals from MULTIPLE workspaces appear in
 * one oldest-first stack (each read under its own tenant scope), and deciding
 * one through the ordinary decideApproval path removes it from the stack.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[owner-inbox.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let userId = '', orgId = '';
interface Ws { projectId: string; key: string; name: string; leadId: string }
let wsA: Ws, wsB: Ws;

const ctxFor = (ws: Ws): TenantContext => ({ userId, orgId, projectId: ws.projectId, orgRole: 'owner', projectRole: 'admin' });
const accessRecords = () => [wsA, wsB].map((w) => ({
  projectId: w.projectId, orgId, key: w.key, name: w.name, description: '', projectRole: 'admin' as const,
}));
const orgRoles = () => new Map([[orgId, 'owner' as const]]);

async function seedPendingApproval(ws: Ws, summary: string): Promise<string> {
  const taskId = await withTenant(ctxFor(ws), (tx) =>
    createTask(tx, ctxFor(ws), {
      title: 'Inbox test task — ' + summary,
      input: 'test',
      providerSelection: 'openai',
      reviewEnabled: false,
      modelTier: 'standard',
      flagshipCategory: null,
      objectiveId: null,
      scheduleId: null,
      primaryAgentId: ws.leadId,
      reviewerAgentId: null,
    }),
  );
  const payload = { kind: 'test', summary };
  const inserted = await getSetupDb()
    .insert(approvals)
    .values({
      orgId,
      projectId: ws.projectId,
      taskId,
      actionType: 'file_write',
      payload,
      payloadSha256: createHash('sha256').update(JSON.stringify(payload)).digest('hex'),
      summary,
      status: 'pending',
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    })
    .returning({ id: approvals.id });
  return inserted[0]!.id;
}

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `inbox-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = (await db.insert(organizations).values({ name: 'Inbox Org', slug: `inbox-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!;
  orgId = org.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const a = await db.transaction((tx) => createWorkspaceWithStaff(tx, { userId, orgId }, { name: 'Inbox WS A', reason: 'test' }));
  const b = await db.transaction((tx) => createWorkspaceWithStaff(tx, { userId, orgId }, { name: 'Inbox WS B', reason: 'test' }));
  wsA = { projectId: a.projectId, key: a.projectKey, name: 'Inbox WS A', leadId: a.leadEngineerId };
  wsB = { projectId: b.projectId, key: b.projectKey, name: 'Inbox WS B', leadId: b.leadEngineerId };
});

afterAll(async () => {
  if (!available || !orgId) return;
  const db = getSetupDb();
  await db.execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
  await db.delete(auditLogs).where(eq(auditLogs.orgId, orgId));
  await db.execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
  await db.delete(approvals).where(eq(approvals.orgId, orgId));
  await db.delete(tasks).where(eq(tasks.orgId, orgId));
  await db.delete(knowledgeItems).where(eq(knowledgeItems.orgId, orgId));
  await db.delete(spendLimits).where(eq(spendLimits.orgId, orgId));
  await db.delete(agents).where(eq(agents.orgId, orgId));
  await db.delete(projectMembers).where(eq(projectMembers.orgId, orgId));
  await db.delete(projects).where(eq(projects.orgId, orgId));
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(profiles).where(eq(profiles.id, userId));
});

describe('owner inbox', () => {
  it('aggregates pending approvals across workspaces, oldest first, with workspace identity attached', async () => {
    if (!available) return;
    const firstId = await seedPendingApproval(wsA, 'Publish the launch post');
    await new Promise((r) => setTimeout(r, 25)); // deterministic ordering
    await seedPendingApproval(wsB, 'Send the supplier outreach email');

    const inbox = await ownerInbox(userId, accessRecords(), orgRoles());
    expect(inbox.items).toHaveLength(2);
    expect(inbox.workspacesWithPending).toBe(2);
    expect(inbox.items[0]!.approvalId).toBe(firstId); // oldest first
    expect(inbox.items.map((i) => i.workspaceName).sort()).toEqual(['Inbox WS A', 'Inbox WS B']);
    expect(inbox.items[0]!.employeeName).toBe('Lead Engineer');
    expect(inbox.items[0]!.projectKey).toBe(wsA.key);
  });

  it('deciding through the ordinary path removes the item from the stack', async () => {
    if (!available) return;
    const before = await ownerInbox(userId, accessRecords(), orgRoles());
    const target = before.items[0]!;
    await withTenant(ctxFor(wsA), (tx) => decideApproval(tx, ctxFor(wsA), target.approvalId, 'approved'));
    const after = await ownerInbox(userId, accessRecords(), orgRoles());
    expect(after.items.map((i) => i.approvalId)).not.toContain(target.approvalId);
    expect(after.items).toHaveLength(before.items.length - 1);
  });

  it('an empty stack reports the workspaces it checked', async () => {
    if (!available) return;
    const inbox = await ownerInbox(userId, [], orgRoles());
    expect(inbox.items).toHaveLength(0);
    expect(inbox.workspacesChecked).toBe(0);
  });
});
