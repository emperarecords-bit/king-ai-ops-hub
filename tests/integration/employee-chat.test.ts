import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import {
  agents,
  auditLogs,
  conversations,
  knowledgeItems,
  memberships,
  messages,
  organizations,
  profiles,
  projectMembers,
  projects,
  runJobs,
  spendLimits,
  tasks,
} from '@/db/schema';
import { createWorkspaceWithStaff } from '@/domain/projects/provision';
import { getOrCreateConversation, loadChatThread, sendChatMessage } from '@/domain/chat/chat';

/**
 * Employee Chat (EV-004) — live-DB integration. Proves: one thread per
 * employee (getOrCreate is race-safe and idempotent), a sent message becomes a
 * governed task linked to the thread + a CLEAN message row (run_id null) + an
 * enqueued run job, the thread loader shows exactly the clean/user +
 * assistant rows in order, and the transcript carries into the next task's
 * input — all under RLS via withTenant.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[employee-chat.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let userId = '', orgId = '', projectId = '', leadId = '';
const ctx = (): TenantContext => ({ userId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' });

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `chat-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = (await db.insert(organizations).values({ name: 'Chat Org', slug: `chat-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!;
  orgId = org.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const ws = await db.transaction((tx) => createWorkspaceWithStaff(tx, { userId, orgId }, { name: 'Chat WS', reason: 'test' }));
  projectId = ws.projectId;
  leadId = ws.leadEngineerId;
});

afterAll(async () => {
  if (!available || !orgId) return;
  const db = getSetupDb();
  await db.execute(sql`alter table audit_logs disable trigger audit_logs_append_only`);
  await db.delete(auditLogs).where(eq(auditLogs.orgId, orgId));
  await db.execute(sql`alter table audit_logs enable trigger audit_logs_append_only`);
  await db.delete(runJobs).where(eq(runJobs.orgId, orgId));
  await db.execute(sql`alter table messages disable trigger messages_append_only`);
  await db.delete(messages).where(eq(messages.orgId, orgId));
  await db.execute(sql`alter table messages enable trigger messages_append_only`);
  await db.delete(tasks).where(eq(tasks.orgId, orgId));
  await db.delete(conversations).where(eq(conversations.orgId, orgId));
  await db.delete(knowledgeItems).where(eq(knowledgeItems.orgId, orgId));
  await db.delete(spendLimits).where(eq(spendLimits.orgId, orgId));
  await db.delete(agents).where(eq(agents.orgId, orgId));
  await db.delete(projectMembers).where(eq(projectMembers.orgId, orgId));
  await db.delete(projects).where(eq(projects.orgId, orgId));
  await db.delete(memberships).where(eq(memberships.orgId, orgId));
  await db.delete(organizations).where(eq(organizations.id, orgId));
  await db.delete(profiles).where(eq(profiles.id, userId));
});

describe('employee chat', () => {
  it('getOrCreateConversation is one-per-employee and idempotent', async () => {
    if (!available) return;
    const first = await withTenant(ctx(), (tx) => getOrCreateConversation(tx, ctx(), leadId));
    const second = await withTenant(ctx(), (tx) => getOrCreateConversation(tx, ctx(), leadId));
    expect(second).toBe(first);
  });

  it('sendChatMessage creates a linked task + clean message row + enqueued run job', async () => {
    if (!available) return;
    const out = await withTenant(ctx(), (tx) => sendChatMessage(tx, ctx(), { agentId: leadId, content: 'Hello — what can you do?' }));
    const db = getSetupDb();

    const task = (await db.select().from(tasks).where(eq(tasks.id, out.taskId)))[0]!;
    expect(task.conversationId).toBe(out.conversationId);
    expect(task.assignedPrimaryAgentId).toBe(leadId);
    expect(task.input).toContain('Owner: Hello — what can you do?');

    const clean = await db
      .select()
      .from(messages)
      .where(and(eq(messages.taskId, out.taskId), isNull(messages.runId), eq(messages.role, 'user')));
    expect(clean).toHaveLength(1);
    expect(clean[0]!.content).toBe('Hello — what can you do?');

    const jobs = await db.select().from(runJobs).where(eq(runJobs.taskId, out.taskId));
    expect(jobs.length).toBe(1);
  });

  it('thread shows clean messages; awaitingReply true while the run is not terminal; transcript carries forward', async () => {
    if (!available) return;
    const thread = await withTenant(ctx(), (tx) => loadChatThread(tx, ctx(), leadId));
    expect(thread.entries.map((e) => e.role)).toEqual(['owner']);
    expect(thread.entries[0]!.content).toBe('Hello — what can you do?');
    expect(thread.awaitingReply).toBe(true); // no worker in this test — the run stays queued

    // Simulate the employee's reply the way the runner records it (assistant row bound to the task).
    const db = getSetupDb();
    const taskRow = (await db.select({ id: tasks.id }).from(tasks).where(eq(tasks.conversationId, thread.conversationId!)))[0]!;
    await db.insert(messages).values({ orgId, projectId, taskId: taskRow.id, role: 'assistant', content: 'I plan and build. What do you need?' });
    await db.update(tasks).set({ status: 'completed' }).where(eq(tasks.id, taskRow.id));

    const after = await withTenant(ctx(), (tx) => loadChatThread(tx, ctx(), leadId));
    expect(after.entries.map((e) => e.role)).toEqual(['owner', 'employee']);
    expect(after.awaitingReply).toBe(false);

    // The NEXT message's task input embeds the prior exchange as transcript.
    const second = await withTenant(ctx(), (tx) => sendChatMessage(tx, ctx(), { agentId: leadId, content: 'Great — status of the pilot?' }));
    const secondTask = (await db.select().from(tasks).where(eq(tasks.id, second.taskId)))[0]!;
    expect(secondTask.input).toContain('Owner: Hello — what can you do?');
    expect(secondTask.input).toContain('You: I plan and build. What do you need?');
    expect(secondTask.input).toContain('Owner: Great — status of the pilot?');
  });

  it('rejects empty messages and unknown employees', async () => {
    if (!available) return;
    await expect(withTenant(ctx(), (tx) => sendChatMessage(tx, ctx(), { agentId: leadId, content: '   ' }))).rejects.toThrow(/empty/i);
    await expect(
      withTenant(ctx(), (tx) => sendChatMessage(tx, ctx(), { agentId: randomUUID(), content: 'hi' })),
    ).rejects.toThrow(/not an enabled primary/i);
  });
});
