import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { agents, approvals, auditLogs, memberships, organizations, profiles, projectMembers, projects, runJobs, tasks } from '@/db/schema';
import { getSetupDb } from '@/db/client';
import { executeApprovedIfEligible } from '@/domain/execution/execute-on-approval';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { type TenantContext } from '@/types/domain';
import { fixtureKey } from '@tests/support/fixture-key';

/**
 * Cross-workspace delegation v2 (owner directive 2026-08-16): an approved `org_delegation` becomes
 * a REAL queued task for the TARGET workspace's General Manager — and nothing happens without that
 * approval. These tests exercise the executor through the real dispatch choke point.
 */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[org-delegation-executor.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let hqCtx: TenantContext;
let targetProjectId: string;
let targetKey: string;
let gmAgentId: string;

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `orgdel-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Org Owner' });
  const [org] = await db.insert(organizations).values({ name: 'OrgDelegation Org', slug: fixtureKey('orgdel') }).returning({ id: organizations.id });
  await db.insert(memberships).values({ orgId: org!.id, userId, role: 'owner' });

  const [hq] = await db.insert(projects).values({ orgId: org!.id, key: fixtureKey('orgdel-hq'), name: 'Headquarters' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId: org!.id, projectId: hq!.id, userId, role: 'admin' });

  targetKey = fixtureKey('orgdel-target');
  const [target] = await db.insert(projects).values({ orgId: org!.id, key: targetKey, name: 'Target Business' }).returning({ id: projects.id });
  targetProjectId = target!.id;
  await db.insert(projectMembers).values({ orgId: org!.id, projectId: targetProjectId, userId, role: 'admin' });
  gmAgentId = (
    await db
      .insert(agents)
      .values({ orgId: org!.id, projectId: targetProjectId, name: 'General Manager', role: 'primary', provider: 'openai', model: 'gpt-5.2', systemPrompt: 'GM of the target business.', temperatureMilli: 300, maxOutputTokens: 2048, enabled: true })
      .returning({ id: agents.id })
  )[0]!.id;
  await db.update(projects).set({ ownerAgentId: gmAgentId }).where(eq(projects.id, targetProjectId));

  hqCtx = { userId, orgId: org!.id, projectId: hq!.id, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  await db.update(projects).set({ archived: true }).where(eq(projects.id, hqCtx.projectId));
});

async function approvedDelegation(payload: Record<string, unknown>) {
  const db = getSetupDb();
  const [task] = await db.insert(tasks).values({ orgId: hqCtx.orgId, projectId: hqCtx.projectId, title: 'CoS directive', input: 'delegate', providerSelection: 'openai', createdBy: hqCtx.userId, status: 'completed' }).returning({ id: tasks.id });
  const [approval] = await db.insert(approvals).values({ orgId: hqCtx.orgId, projectId: hqCtx.projectId, taskId: task!.id, actionType: 'org_delegation', payload, payloadSha256: sha256Hex(canonicalJson(payload)), summary: 'Delegate', status: 'approved', decidedBy: hqCtx.userId, decidedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }).returning({ id: approvals.id });
  return approval!.id;
}

describe.skipIf(!available)('org_delegation executor (cross-workspace delegation v2)', { timeout: 20_000 }, () => {
  it('an approved delegation creates a queued task for the target GM, exactly once', async () => {
    const payload = { targetProjectKey: targetKey, title: 'Kick off spring campaign', instructions: 'Plan and delegate the spring campaign across your team.' };
    const approvalId = await approvedDelegation(payload);

    const first = await executeApprovedIfEligible(hqCtx, approvalId, { enabledExecutorIds: ['org_delegation'] });
    expect(first).toMatchObject({ attempted: true, outcome: 'succeeded' });
    expect(first.message).toContain('Target Business');

    const db = getSetupDb();
    const created = await db
      .select({ id: tasks.id, title: tasks.title, primary: tasks.assignedPrimaryAgentId, input: tasks.input, status: tasks.status })
      .from(tasks)
      .where(and(eq(tasks.projectId, targetProjectId), eq(tasks.title, 'Kick off spring campaign')));
    expect(created).toHaveLength(1);
    expect(created[0]!.primary).toBe(gmAgentId);
    expect(created[0]!.input).toContain('Directive from headquarters');
    const queued = await db.select({ status: runJobs.status }).from(runJobs).where(eq(runJobs.taskId, created[0]!.id));
    expect(queued).toEqual([{ status: 'queued' }]);

    // Cross-workspace provenance is audited IN THE TARGET workspace.
    const audit = await db.select({ action: auditLogs.action, projectId: auditLogs.projectId }).from(auditLogs).where(and(eq(auditLogs.entityId, created[0]!.id), eq(auditLogs.action, 'task.delegated')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.projectId).toBe(targetProjectId);

    // At-most-once: a second Okay can never create a second task.
    const again = await executeApprovedIfEligible(hqCtx, approvalId, { enabledExecutorIds: ['org_delegation'] });
    expect(again.outcome).toBe('blocked');
    const stillOne = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, targetProjectId), eq(tasks.title, 'Kick off spring campaign')));
    expect(stillOne).toHaveLength(1);
  });

  it('fails closed: disabled executor, unknown workspace, and no partial writes on failure', async () => {
    // Disabled (the default) — nothing happens.
    const p1 = { targetProjectKey: targetKey, title: 'Never runs', instructions: 'x' };
    const disabled = await executeApprovedIfEligible(hqCtx, await approvedDelegation(p1), { enabledExecutorIds: [] });
    expect(disabled).toMatchObject({ attempted: true, outcome: 'blocked' });

    // Unknown target workspace — blocked, no task anywhere.
    const p2 = { targetProjectKey: 'no-such-workspace', title: 'Nowhere', instructions: 'x' };
    const missing = await executeApprovedIfEligible(hqCtx, await approvedDelegation(p2), { enabledExecutorIds: ['org_delegation'] });
    expect(missing.outcome).toBe('blocked');
    expect(missing.message).toContain('not found');

    // Self-targeting is refused — HQ cannot "cross" into itself.
    const hqKeyRow = await getSetupDb().select({ key: projects.key }).from(projects).where(eq(projects.id, hqCtx.projectId));
    const p3 = { targetProjectKey: hqKeyRow[0]!.key, title: 'Self', instructions: 'x' };
    const self = await executeApprovedIfEligible(hqCtx, await approvedDelegation(p3), { enabledExecutorIds: ['org_delegation'] });
    expect(self.outcome).toBe('blocked');

    // Malformed payload (extra key) — blocked at the executor's strict parse.
    const p4 = { targetProjectKey: targetKey, title: 'Bad', instructions: 'x', sneaky: true };
    const malformed = await executeApprovedIfEligible(hqCtx, await approvedDelegation(p4), { enabledExecutorIds: ['org_delegation'] });
    expect(malformed.outcome).toBe('blocked');

    const strays = await getSetupDb().select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, targetProjectId), eq(tasks.title, 'Never runs')));
    expect(strays).toHaveLength(0);
  });

  it('a workspace without an installed General Manager is refused', async () => {
    const db = getSetupDb();
    const orphanKey = fixtureKey('orgdel-nogm');
    const [orphan] = await db.insert(projects).values({ orgId: hqCtx.orgId, key: orphanKey, name: 'No GM Business' }).returning({ id: projects.id });
    await db.insert(projectMembers).values({ orgId: hqCtx.orgId, projectId: orphan!.id, userId: hqCtx.userId, role: 'admin' });
    const p = { targetProjectKey: orphanKey, title: 'Unroutable', instructions: 'x' };
    const refused = await executeApprovedIfEligible(hqCtx, await approvedDelegation(p), { enabledExecutorIds: ['org_delegation'] });
    expect(refused.outcome).toBe('blocked');
    expect(refused.message).toContain('General Manager');
  });
});
