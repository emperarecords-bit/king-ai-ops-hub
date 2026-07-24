import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import {
  agents,
  approvals,
  memberships,
  organizations,
  profiles,
  projectMembers,
  projects,
  runs,
  tasks,
  usageEvents,
} from '@/db/schema';
import { createObjective, setObjectiveStatus } from '@/domain/objectives/objectives';
import { computeInsights } from '@/domain/insights/insights';

/**
 * Management Insights (Sprint 9). What these tests pin:
 *  - insights are COMPOSITE (money + progress, time + blocked work), never
 *    activity counters;
 *  - they are deterministic: same data in, identical sentences out;
 *  - every insight carries evidence, so any claim is traceable;
 *  - quiet, healthy workspaces produce NO insights (no noise manufacturing).
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(
    `[insights.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
  );
}

const userId = randomUUID();
let ctx: TenantContext;
let orgId = '';
let projectKey = '';
let agentId = '';

beforeAll(async () => {
  if (!available) return;
  const db = getDb();
  await db.insert(profiles).values({
    id: userId,
    email: `insight-${randomUUID().slice(0, 8)}@test.local`,
    displayName: 'Insight Tester',
  });
  const org = await db
    .insert(organizations)
    .values({ name: 'Insight Org', slug: `insight-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  projectKey = fixtureKey('insight');
  const project = await db
    .insert(projects)
    .values({ orgId, key: projectKey, name: 'Insight Project' })
    .returning({ id: projects.id });
  const projectId = project[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId, userId, role: 'admin' });
  const agent = await db
    .insert(agents)
    .values({
      orgId,
      projectId,
      name: 'Lead Engineer',
      role: 'primary',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      systemPrompt: 'test',
    })
    .returning({ id: agents.id });
  agentId = agent[0]!.id;
  ctx = { userId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (!available) return;
  await getDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('management insights', () => {
  it('a quiet workspace produces no insights — no noise manufacturing', async () => {
    const insights = await withTenant(ctx, (tx) => computeInsights(tx, ctx, projectKey));
    expect(insights).toEqual([]);
  });

  it('names money spent without progress — cost joined to criteria, not a run count', async () => {
    const objectiveId = await withTenant(ctx, (tx) =>
      createObjective(tx, ctx, {
        title: 'Expensive objective',
        successCriteria: [
          { label: 'Ship it', metric: 'shipped', target: 1, unit: '' },
          { label: 'Users happy', metric: 'csat', target: 90, unit: '%' },
        ],
      }),
    );
    await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objectiveId, 'active'));

    // Two tasks, real spend, zero criteria closed.
    const db = getDb();
    for (let i = 0; i < 2; i += 1) {
      const task = await db
        .insert(tasks)
        .values({
          orgId,
          projectId: ctx.projectId,
          objectiveId,
          title: `Work ${i}`,
          input: 'x',
          providerSelection: 'openai',
          status: 'completed',
          createdBy: userId,
        })
        .returning({ id: tasks.id });
      await db.insert(usageEvents).values({
        orgId,
        projectId: ctx.projectId,
        taskId: task[0]!.id,
        provider: 'openai',
        model: 'gpt-5.4-mini',
        inputTokens: 1000,
        outputTokens: 500,
        costMicros: 5_000_000n, // $5 each
        pricingVersion: 'test',
      });
    }

    const insights = await withTenant(ctx, (tx) => computeInsights(tx, ctx, projectKey));
    const found = insights.find((i) => i.key === `cost-no-progress:${objectiveId}`);
    expect(found).toBeDefined();
    expect(found!.severity).toBe('critical');
    expect(found!.headline).toContain('$10.00');
    expect(found!.headline).toContain('2 tasks');
    // Traceable: the evidence carries the numbers behind the sentence.
    expect(found!.evidence.criteriaMet).toBe('0 of 2');
    expect(found!.evidence.spent).toBe('$10.00');
  });

  it('is deterministic: identical data yields identical output', async () => {
    const first = await withTenant(ctx, (tx) => computeInsights(tx, ctx, projectKey));
    const second = await withTenant(ctx, (tx) => computeInsights(tx, ctx, projectKey));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('identifies when the owner is the blocker — decision state joined to objective progress', async () => {
    const db = getDb();
    const objectiveId = await withTenant(ctx, (tx) =>
      createObjective(tx, ctx, {
        title: 'Blocked objective',
        successCriteria: [{ label: 'Approve the thing', metric: 'approved', target: 1, unit: '' }],
      }),
    );
    await withTenant(ctx, (tx) => setObjectiveStatus(tx, ctx, objectiveId, 'active'));
    const task = await db
      .insert(tasks)
      .values({
        orgId,
        projectId: ctx.projectId,
        objectiveId,
        title: 'Proposal awaiting decision',
        input: 'x',
        providerSelection: 'openai',
        status: 'awaiting_approval',
        createdBy: userId,
      })
      .returning({ id: tasks.id });
    const run = await db
      .insert(runs)
      .values({
        orgId,
        projectId: ctx.projectId,
        taskId: task[0]!.id,
        status: 'completed',
        primaryAgentId: agentId,
      })
      .returning({ id: runs.id });
    await db.insert(approvals).values({
      orgId,
      projectId: ctx.projectId,
      taskId: task[0]!.id,
      runId: run[0]!.id,
      actionType: 'file_write',
      payload: { path: 'x' },
      payloadSha256: 'abc',
      summary: 'Write a file',
      status: 'pending',
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const insights = await withTenant(ctx, (tx) => computeInsights(tx, ctx, projectKey));
    const blocked = insights.find((i) => i.key === `stalled-awaiting-you:${objectiveId}`);
    expect(blocked).toBeDefined();
    expect(blocked!.headline).toContain('waiting on you');
    expect(blocked!.evidence.awaitingDecisions).toBe(1);
  });

  it('ranks by consequence: critical findings come first', async () => {
    const insights = await withTenant(ctx, (tx) => computeInsights(tx, ctx, projectKey));
    expect(insights.length).toBeGreaterThan(1);
    const severities = insights.map((i) => i.severity);
    const rank = { critical: 0, attention: 1, opportunity: 2, positive: 3 } as const;
    for (let i = 1; i < severities.length; i += 1) {
      expect(rank[severities[i]!]).toBeGreaterThanOrEqual(rank[severities[i - 1]!]);
    }
  });

  it('every insight carries an action, a link, and evidence', async () => {
    const insights = await withTenant(ctx, (tx) => computeInsights(tx, ctx, projectKey));
    for (const insight of insights) {
      expect(insight.headline.length).toBeGreaterThan(20);
      expect(insight.action.length).toBeGreaterThan(10);
      expect(insight.href).toContain(projectKey);
      expect(Object.keys(insight.evidence).length).toBeGreaterThan(0);
    }
  });
});
