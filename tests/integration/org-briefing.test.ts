import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, approvals, memberships, messages, objectives, organizations, profiles, projectMembers, projects, tasks } from '@/db/schema';
import { getSetupDb } from '@/db/client';
import { assembleOrgBriefing, resolveHqProjectKey } from '@/domain/org/briefing';
import { fixtureKey } from '@tests/support/fixture-key';

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
let available = false;
try { await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1); available = true; }
catch (err) { console.warn(`[org-briefing.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`); }

let userId: string;
let orgId: string;
const projectIds: string[] = [];

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `hq-${randomUUID().slice(0, 8)}@test.local`, displayName: 'HQ Owner' });
  const [org] = await db.insert(organizations).values({ name: 'HQ Org', slug: fixtureKey('hq-org') }).returning({ id: organizations.id });
  orgId = org!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });

  for (const key of ['alpha', 'beta']) {
    const [project] = await db.insert(projects).values({ orgId, key: fixtureKey(key), name: `Biz ${key}` }).returning({ id: projects.id });
    projectIds.push(project!.id);
    await db.insert(projectMembers).values({ orgId, projectId: project!.id, userId, role: 'admin' });
    const [gm] = await db
      .insert(agents)
      .values({ orgId, projectId: project!.id, name: `GM ${key}`, role: 'primary', provider: 'google', model: 'gemini-3.1-flash-lite', systemPrompt: 'You run this business.', enabled: true })
      .returning({ id: agents.id });
    await db.update(projects).set({ ownerAgentId: gm!.id }).where(eq(projects.id, project!.id));
    await db.insert(objectives).values({ orgId, projectId: project!.id, title: `Grow ${key}`, description: 'grow', status: 'active', createdBy: userId });
  }

  // One business has a completed task with a report, and a pending approval.
  const [task] = await db
    .insert(tasks)
    .values({ orgId, projectId: projectIds[0]!, title: 'Weekly report alpha', input: 'report', providerSelection: 'google', createdBy: userId, status: 'completed' })
    .returning({ id: tasks.id });
  await db.insert(messages).values({ orgId, projectId: projectIds[0]!, taskId: task!.id, role: 'assistant', content: 'Alpha is on track: revenue grew and the pipeline is healthy.' });
  await db
    .insert(approvals)
    .values({ orgId, projectId: projectIds[0]!, taskId: task!.id, actionType: 'email_send', payload: {}, payloadSha256: 'a'.repeat(64), summary: 'Send the weekly email', status: 'pending', expiresAt: new Date(Date.now() + 60_000) });
});

afterAll(async () => {
  if (!available) return;
  for (const id of projectIds) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.id, id));
});

describe.skipIf(!available)('Chief of Staff org briefing', { timeout: 15_000 }, () => {
  it('assembles a read-only briefing across every workspace in the org', async () => {
    const briefing = await assembleOrgBriefing(userId, orgId);
    expect(briefing).toBeTruthy();
    expect(briefing!).toContain('Biz alpha');
    expect(briefing!).toContain('Biz beta');
    expect(briefing!).toContain('GM alpha');
    expect(briefing!).toContain('Grow alpha');
    expect(briefing!).toContain('Pending owner approvals: 1');
    expect(briefing!).toContain('Alpha is on track');
    // The other business honestly reports no completed work.
    expect(briefing!).toContain('Latest completed work: none yet');
  });

  it('HQ designation fails closed without server config', () => {
    expect(resolveHqProjectKey({})).toBeNull();
    expect(resolveHqProjectKey({ ORG_HQ_PROJECT_KEY: '  ' })).toBeNull();
    expect(resolveHqProjectKey({ ORG_HQ_PROJECT_KEY: 'empera-international' })).toBe('empera-international');
  });
});
