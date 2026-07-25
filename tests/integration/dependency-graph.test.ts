import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { ConflictError } from '@/lib/errors';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { memberships, organizations, profiles, projectMembers, projects, tasks } from '@/db/schema';
import { addDependency, buildTaskGraph } from '@/domain/dependencies/dependencies';
import { assembleTaskGraph } from '@/domain/dependencies/graph-context';

/**
 * Task dependency graph (O-18) — the four acceptance scenarios plus isolation,
 * against real Postgres so the bounded traversal, cycle guard, and I1 scoping
 * are exercised for real.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ??
  process.env.TEST_DATABASE_URL ??
  'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[dependency-graph.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let ctxA: TenantContext;
let ctxB: TenantContext;

async function makeWorkspace(): Promise<TenantContext> {
  const db = getSetupDb();
  const p = await db
    .insert(projects)
    .values({ orgId, key: fixtureKey('dep'), name: 'Dep Project' })
    .returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  return { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
}

async function mkTask(ctx: TenantContext, title: string, status = 'pending'): Promise<string> {
  const db = getSetupDb();
  const t = await db
    .insert(tasks)
    .values({
      orgId,
      projectId: ctx.projectId,
      title,
      input: 'x',
      providerSelection: 'openai',
      status: status as 'pending',
      createdBy: userId,
    })
    .returning({ id: tasks.id });
  return t[0]!.id;
}

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `dep-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = await db.insert(organizations).values({ name: 'Dep Org', slug: `dep-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  ctxA = await makeWorkspace();
  ctxB = await makeWorkspace();
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('dependency graph', () => {
  it('Test 1 — chain A→B→C: running B sees prerequisite A, unlocks C', async () => {
    const a = await mkTask(ctxA, 'Chain A', 'completed');
    const b = await mkTask(ctxA, 'Chain B');
    const c = await mkTask(ctxA, 'Chain C');
    await withTenant(ctxA, (tx) => addDependency(tx, ctxA, { dependentTaskId: b, prerequisiteTaskId: a }));
    await withTenant(ctxA, (tx) => addDependency(tx, ctxA, { dependentTaskId: c, prerequisiteTaskId: b }));

    const g = await withTenant(ctxA, (tx) => buildTaskGraph(tx, ctxA, b));
    expect(g!.prerequisites.map((n) => n.title)).toEqual(['Chain A']);
    expect(g!.dependents.map((n) => n.title)).toEqual(['Chain C']);
    // A is complete, so B is NOT blocked; completing B unlocks C.
    expect(g!.blockers).toEqual([]);
    expect(g!.unlockedOnCompletion.map((n) => n.title)).toEqual(['Chain C']);
    expect(g!.cycle).toBe(false);

    const ctxItem = (await withTenant(ctxA, (tx) => assembleTaskGraph(tx, ctxA, b))).contextItem!;
    expect(ctxItem.content).toContain('Immediate prerequisites: "Chain A"');
    expect(ctxItem.content).toContain('Unlocked by completing this task: "Chain C"');
  });

  it('Test 1b — an incomplete prerequisite is reported as a blocker', async () => {
    const a = await mkTask(ctxA, 'Blk A', 'running'); // not complete
    const b = await mkTask(ctxA, 'Blk B');
    await withTenant(ctxA, (tx) => addDependency(tx, ctxA, { dependentTaskId: b, prerequisiteTaskId: a }));
    const g = await withTenant(ctxA, (tx) => buildTaskGraph(tx, ctxA, b));
    expect(g!.blockers.map((n) => n.title)).toEqual(['Blk A']);
    const content = (await withTenant(ctxA, (tx) => assembleTaskGraph(tx, ctxA, b))).contextItem!.content;
    expect(content).toMatch(/this task is BLOCKED until they finish/i);
  });

  it('Test 2 — parallel work: B and C share prerequisite A; C is parallel, not blocking B', async () => {
    const a = await mkTask(ctxA, 'Par A', 'completed');
    const b = await mkTask(ctxA, 'Par B');
    const c = await mkTask(ctxA, 'Par C');
    await withTenant(ctxA, (tx) => addDependency(tx, ctxA, { dependentTaskId: b, prerequisiteTaskId: a }));
    await withTenant(ctxA, (tx) => addDependency(tx, ctxA, { dependentTaskId: c, prerequisiteTaskId: a }));
    const g = await withTenant(ctxA, (tx) => buildTaskGraph(tx, ctxA, b));
    expect(g!.siblings.map((n) => n.title)).toContain('Par C');
    expect(g!.blockers).toEqual([]); // A is complete → not blocked
    const content = (await withTenant(ctxA, (tx) => assembleTaskGraph(tx, ctxA, b))).contextItem!.content;
    expect(content).toMatch(/Parallel work.*"Par C"/);
  });

  it('Test 3 — cycle A→B→C→A is detected and traversal is bounded', async () => {
    const a = await mkTask(ctxA, 'Cyc A');
    const b = await mkTask(ctxA, 'Cyc B');
    const c = await mkTask(ctxA, 'Cyc C');
    await withTenant(ctxA, (tx) => addDependency(tx, ctxA, { dependentTaskId: b, prerequisiteTaskId: a }));
    await withTenant(ctxA, (tx) => addDependency(tx, ctxA, { dependentTaskId: c, prerequisiteTaskId: b }));
    // Closing the loop C→A must be refused (would create a cycle)...
    await expect(
      withTenant(ctxA, (tx) => addDependency(tx, ctxA, { dependentTaskId: a, prerequisiteTaskId: c })),
    ).rejects.toBeInstanceOf(ConflictError);

    // ...so to TEST cycle *detection/reporting*, insert the back-edge directly.
    const db = getSetupDb();
    const { taskDependencies } = await import('@/db/schema');
    await db.insert(taskDependencies).values({ orgId, projectId: ctxA.projectId, prerequisiteTaskId: c, dependentTaskId: a });

    const g = await withTenant(ctxA, (tx) => buildTaskGraph(tx, ctxA, b));
    expect(g!.cycle).toBe(true);
    expect(g!.criticalChain).toEqual([]); // no chain reported on a cycle
    const content = (await withTenant(ctxA, (tx) => assembleTaskGraph(tx, ctxA, b))).contextItem!.content;
    expect(content).toMatch(/Dependency cycle detected/i);
  });

  it('a task with no edges is reported as independent, not blocked', async () => {
    const solo = await mkTask(ctxA, 'Solo');
    const ctxItem = (await withTenant(ctxA, (tx) => assembleTaskGraph(tx, ctxA, solo))).contextItem!;
    expect(ctxItem.content).toMatch(/No dependency information available/i);
    expect(ctxItem.content).toMatch(/independent work/i);
  });

  it('ISOLATION: a graph never crosses into another workspace', async () => {
    const aA = await mkTask(ctxA, 'Iso A');
    const bA = await mkTask(ctxA, 'Iso B');
    await withTenant(ctxA, (tx) => addDependency(tx, ctxA, { dependentTaskId: bA, prerequisiteTaskId: aA }));
    // Workspace B cannot build a graph for A's task, nor add cross-workspace edges.
    const g = await withTenant(ctxB, (tx) => buildTaskGraph(tx, ctxB, bA));
    expect(g).toBeNull();
    const bB = await mkTask(ctxB, 'Iso B-in-B');
    await expect(
      withTenant(ctxB, (tx) => addDependency(tx, ctxB, { dependentTaskId: bB, prerequisiteTaskId: aA })),
    ).rejects.toBeTruthy(); // aA is not a task in workspace B
  });
});
