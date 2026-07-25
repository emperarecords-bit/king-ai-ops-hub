import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { memberships, organizations, profiles, projectMembers, projects, tasks } from '@/db/schema';
import {
  acceptDecision,
  assembleDecisionMemory,
  createDecision,
  listDecisions,
  objectiveTaskIds,
} from '@/domain/decisions/decisions';

/**
 * Decision Memory (O-19) acceptance scenarios + supersession + isolation.
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
  console.warn(`[decisions.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let ctxA: TenantContext;
let ctxB: TenantContext;

async function makeWorkspace(): Promise<TenantContext> {
  const db = getDb();
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('dec'), name: 'Dec Project' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  return { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
}

async function mkTask(ctx: TenantContext, title: string): Promise<string> {
  const t = await getDb()
    .insert(tasks)
    .values({ orgId, projectId: ctx.projectId, title, input: 'x', providerSelection: 'openai', status: 'completed', createdBy: userId })
    .returning({ id: tasks.id });
  return t[0]!.id;
}

const noArgs = (taskId: string) => ({ currentTaskId: taskId, objectiveTaskIds: [], docPaths: new Set<string>() });

beforeAll(async () => {
  if (!available) return;
  const db = getDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `dec-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = await db.insert(organizations).values({ name: 'Dec Org', slug: `dec-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  ctxA = await makeWorkspace();
  ctxB = await makeWorkspace();
});

afterAll(async () => {
  if (!available) return;
  await getDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('decision memory', () => {
  it('Test 4 — no decisions: no memory block, no hallucinated memory', async () => {
    const t = await mkTask(ctxA, 'T4 task');
    const mem = await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(t)));
    expect(mem.contextItem).toBeNull();
    expect(mem.manifest).toEqual([]);
  });

  it('proposed decisions are NOT retrieved — only accepted are', async () => {
    const t = await mkTask(ctxA, 'gate task');
    await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', { title: 'Not yet approved', summary: 'pending' }),
    );
    const mem = await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(t)));
    // The proposed decision must not appear.
    expect(mem.contextItem?.content ?? '').not.toContain('Not yet approved');
  });

  it('Test 1 — an accepted decision is present in the memory block', async () => {
    const t = await mkTask(ctxA, 'runtime task');
    const id = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', {
        title: 'Episode runtime fixed at 22:00',
        summary: 'All Season 1 episodes target a 22:00 runtime.',
        decisionType: 'creative',
      }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, id));
    const mem = await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(t)));
    expect(mem.contextItem?.content).toContain('Episode runtime fixed at 22:00');
    expect(mem.contextItem?.content).toMatch(/do not contradict an accepted decision/i);
    expect(mem.manifest.some((m) => m.source === 'decision_memory')).toBe(true);
  });

  it('Test 2 — supersession: B replaces A; A becomes historical, B current', async () => {
    const t = await mkTask(ctxA, 'super task');
    const a = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', { title: 'Runtime 22 minutes', summary: '22 min', decisionType: 'creative' }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, a));
    const b = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', {
        title: 'Runtime 24 minutes',
        summary: '24 min',
        decisionType: 'creative',
        supersedesId: a,
      }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, b));

    // A is now superseded; B is accepted.
    const all = await withTenant(ctxA, (tx) => listDecisions(tx, ctxA));
    expect(all.find((d) => d.id === a)!.status).toBe('superseded');
    expect(all.find((d) => d.id === b)!.status).toBe('accepted');

    const mem = await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(t)));
    const content = mem.contextItem?.content ?? '';
    // B is present as current; A appears only as the superseded historical note.
    expect(content).toContain('Runtime 24 minutes');
    expect(content).toMatch(/supersedes.*"Runtime 22 minutes".*historical/i);
    // A is NOT retrieved as its own active decision line.
    const activeLines = content.split('\n').filter((l) => l.startsWith('- ['));
    expect(activeLines.some((l) => l.includes('"Runtime 22 minutes"') && !l.includes('supersedes'))).toBe(false);
  });

  it('ranking — a decision from the current task outranks an unrelated one', async () => {
    const t = await mkTask(ctxA, 'rank task');
    const near = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', { title: 'Near decision', summary: 's', originatingTaskId: t }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, near));
    const mem = await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(t)));
    const lines = (mem.contextItem?.content ?? '').split('\n').filter((l) => l.startsWith('- ['));
    expect(lines[0]).toContain('Near decision');
  });

  it('objectiveTaskIds is tenant-scoped and returns attached task ids', async () => {
    // Sanity for the ranking input; no cross-tenant leakage.
    const ids = await withTenant(ctxB, (tx) => objectiveTaskIds(tx, ctxB, null));
    expect(ids).toEqual([]);
  });

  it('ISOLATION: workspace B never sees workspace A decisions', async () => {
    const tB = await mkTask(ctxB, 'B task');
    const mem = await withTenant(ctxB, (tx) => assembleDecisionMemory(tx, ctxB, noArgs(tB)));
    // A has several accepted decisions by now; none may appear in B.
    expect(mem.contextItem?.content ?? '').not.toMatch(/Episode runtime|Runtime 24|Near decision/);
    const listB = await withTenant(ctxB, (tx) => listDecisions(tx, ctxB));
    expect(listB.every((d) => d.title !== 'Episode runtime fixed at 22:00')).toBe(true);
  });
});
