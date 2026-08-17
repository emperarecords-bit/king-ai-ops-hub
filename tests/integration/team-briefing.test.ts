import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, conversations, memberships, messages, organizations, profiles, projectMembers, projects, tasks } from '@/db/schema';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { assembleTeamBriefing } from '@/domain/tasks/team-briefing';
import { type TenantContext } from '@/types/domain';
import { fixtureKey } from '@tests/support/fixture-key';

/** Team Briefing — the GM's live sight of its own team's recent work. */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[team-briefing.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let ctx: TenantContext;
let currentTaskId: string;

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `tb-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const [org] = await db.insert(organizations).values({ name: 'TB Org', slug: fixtureKey('tb-org') }).returning({ id: organizations.id });
  const [project] = await db.insert(projects).values({ orgId: org!.id, key: fixtureKey('tb'), name: 'TB Workspace' }).returning({ id: projects.id });
  await db.insert(memberships).values({ orgId: org!.id, userId, role: 'owner' });
  await db.insert(projectMembers).values({ orgId: org!.id, projectId: project!.id, userId, role: 'admin' });
  ctx = { userId, orgId: org!.id, projectId: project!.id, orgRole: 'owner', projectRole: 'admin' };

  const [worker] = await db
    .insert(agents)
    .values({ orgId: org!.id, projectId: project!.id, name: 'Analyst Ada', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'work', enabled: true })
    .returning({ id: agents.id });

  // Completed real work with a report.
  const [done] = await db
    .insert(tasks)
    .values({ orgId: org!.id, projectId: project!.id, title: 'Market scan', input: 'scan', providerSelection: 'openai', createdBy: userId, status: 'completed', assignedPrimaryAgentId: worker!.id })
    .returning({ id: tasks.id });
  await db.insert(messages).values({ orgId: org!.id, projectId: project!.id, taskId: done!.id, role: 'assistant', content: 'Scan finished: three suppliers shortlisted. UNIQUE-SCAN-MARKER' });

  // Work in flight.
  await db.insert(tasks).values({ orgId: org!.id, projectId: project!.id, title: 'Draft outreach', input: 'draft', providerSelection: 'openai', createdBy: userId, status: 'running', assignedPrimaryAgentId: worker!.id });

  // A chat thread — owner conversation, must be EXCLUDED.
  const [conv] = await db.insert(conversations).values({ orgId: org!.id, projectId: project!.id, agentId: worker!.id, createdBy: userId }).returning({ id: conversations.id });
  await db.insert(tasks).values({ orgId: org!.id, projectId: project!.id, conversationId: conv!.id, title: 'Chat: Analyst Ada', input: 'hello', providerSelection: 'openai', createdBy: userId, status: 'completed' });

  // The GM's OWN current task — must be excluded from its own briefing.
  const [current] = await db
    .insert(tasks)
    .values({ orgId: org!.id, projectId: project!.id, title: 'Daily standup', input: 'standup', providerSelection: 'openai', createdBy: userId, status: 'running' })
    .returning({ id: tasks.id });
  currentTaskId = current!.id;
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.id, ctx.projectId));
});

describe.skipIf(!available)('team briefing', { timeout: 15_000 }, () => {
  it('lists recent real work with excerpts, excludes chats and the current task', async () => {
    const briefing = await withTenant(ctx, (tx) => assembleTeamBriefing(tx, ctx, { excludeTaskId: currentTaskId }));
    expect(briefing).toBeTruthy();
    expect(briefing!).toContain('"Market scan" (Analyst Ada) — COMPLETED');
    expect(briefing!).toContain('UNIQUE-SCAN-MARKER');
    expect(briefing!).toContain('"Draft outreach" (Analyst Ada) — running');
    expect(briefing!).toContain('CHECK THIS BEFORE DELEGATING');
    expect(briefing!).not.toContain('Chat: Analyst Ada');
    expect(briefing!).not.toContain('Daily standup');
  });

  it('an idle workspace yields no briefing at all (honest null, no empty header)', async () => {
    const db = getSetupDb();
    const [empty] = await db.insert(projects).values({ orgId: ctx.orgId, key: fixtureKey('tb-empty'), name: 'Empty WS' }).returning({ id: projects.id });
    await db.insert(projectMembers).values({ orgId: ctx.orgId, projectId: empty!.id, userId: ctx.userId, role: 'admin' });
    const emptyCtx = { ...ctx, projectId: empty!.id };
    const briefing = await withTenant(emptyCtx, (tx) => assembleTeamBriefing(tx, emptyCtx));
    expect(briefing).toBeNull();
    await db.update(projects).set({ archived: true }).where(eq(projects.id, empty!.id));
  });
});
