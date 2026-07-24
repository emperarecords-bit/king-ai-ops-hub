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
  objectives,
  organizations,
  profiles,
  projectMembers,
  projects,
  runs,
  tasks,
} from '@/db/schema';
import {
  assembleProjectState,
  selectObjectiveProgress,
  selectPendingReviews,
  selectRelatedTasks,
} from '@/domain/state/project-state';

/**
 * Project State context (O-15). The test that matters most is the last one:
 * a workspace's operational state must never surface another workspace's
 * tasks, approvals, or objective — this feeds the prompt, so a leak is the I1
 * violation the product exists to prevent.
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
    `[project-state.test] SKIPPING — database not reachable: ${err instanceof Error ? err.message : err}`,
  );
}

let orgId = '';
let userId = '';
let ctxA: TenantContext;
let ctxB: TenantContext;
let objectiveA = '';

async function makeWorkspace(): Promise<TenantContext> {
  const db = getDb();
  const project = await db
    .insert(projects)
    .values({ orgId, key: fixtureKey('state'), name: 'State Project' })
    .returning({ id: projects.id });
  const projectId = project[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId, userId, role: 'admin' });
  return { userId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' };
}

beforeAll(async () => {
  if (!available) return;
  const db = getDb();
  userId = randomUUID();
  await db
    .insert(profiles)
    .values({ id: userId, email: `state-${randomUUID().slice(0, 8)}@test.local`, displayName: 'Owner' });
  const org = await db
    .insert(organizations)
    .values({ name: 'State Org', slug: `state-${randomUUID().slice(0, 8)}` })
    .returning({ id: organizations.id });
  orgId = org[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });

  ctxA = await makeWorkspace();
  ctxB = await makeWorkspace();

  // Workspace A: an objective with mixed criteria and a spread of task states.
  const objA = await db
    .insert(objectives)
    .values({
      orgId,
      projectId: ctxA.projectId,
      title: 'Finish the thing',
      status: 'active',
      successCriteria: [
        { label: 'a', metric: 'a', target: 1, unit: '', source: 'manual', status: 'met', verifiedBy: null, verifiedAt: null },
        { label: 'b', metric: 'b', target: 1, unit: '', source: 'manual', status: 'unmet', verifiedBy: null, verifiedAt: null },
      ],
      createdBy: userId,
    })
    .returning({ id: objectives.id });
  objectiveA = objA[0]!.id;

  const mk = async (title: string, status: string, attach: boolean) => {
    const t = await db
      .insert(tasks)
      .values({
        orgId,
        projectId: ctxA.projectId,
        title,
        input: 'x',
        providerSelection: 'openai',
        status: status as 'completed',
        objectiveId: attach ? objectiveA : null,
        createdBy: userId,
      })
      .returning({ id: tasks.id });
    return t[0]!.id;
  };
  const doneId = await mk('Locked the script', 'completed', true);
  await mk('Rendering the trailer', 'running', true);
  await mk('Draft the poster', 'pending', true);
  await mk('Export master', 'failed', true);
  await mk('Publish teaser', 'awaiting_approval', true);

  // A completed run with a result → recent-outcome summary + owner.
  const agent = await db
    .insert(agents)
    .values({
      orgId,
      projectId: ctxA.projectId,
      name: 'Editor',
      role: 'primary',
      provider: 'openai',
      model: 'gpt-5.4-mini',
      systemPrompt: 'x',
    })
    .returning({ id: agents.id });
  await db.insert(runs).values({
    orgId,
    projectId: ctxA.projectId,
    taskId: doneId,
    status: 'completed',
    primaryAgentId: agent[0]!.id,
    consolidatedResult: 'The script is locked and continuity-checked.',
  });

  // A pending approval → pending review.
  await db.insert(approvals).values({
    orgId,
    projectId: ctxA.projectId,
    taskId: doneId,
    actionType: 'git_commit',
    payload: {},
    payloadSha256: 'x',
    summary: 'Commit the locked script',
    status: 'pending',
    expiresAt: new Date(Date.now() + 86_400_000),
  });
});

afterAll(async () => {
  if (!available) return;
  await getDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

describe.skipIf(!available)('project state', () => {
  it('objective progress reflects criteria and attached-task completion', async () => {
    const p = await withTenant(ctxA, (tx) => selectObjectiveProgress(tx, ctxA, objectiveA));
    expect(p?.criteriaMet).toBe(1);
    expect(p?.criteriaTotal).toBe(2);
    expect(p?.tasksTotal).toBe(5);
    expect(p?.tasksComplete).toBe(1);
  });

  it('classifies tasks into blockers / active / recent with owner and detail', async () => {
    const r = await withTenant(ctxA, (tx) => selectRelatedTasks(tx, ctxA, objectiveA, null));
    expect(r.blockers.map((t) => t.status).sort()).toEqual(['awaiting_approval', 'failed']);
    expect(r.active.map((t) => t.status).sort()).toEqual(['pending', 'running']);
    expect(r.recent[0]?.title).toBe('Locked the script');
    expect(r.recent[0]?.owner).toBe('Editor');
    expect(r.recent[0]?.detail).toContain('continuity-checked');
  });

  it('the assembled block reports objective, active, blockers, outcomes, reviews', async () => {
    const pkg = await withTenant(ctxA, (tx) => assembleProjectState(tx, ctxA, objectiveA, null));
    const text = pkg.contextItem?.content ?? '';
    expect(text).toContain('Finish the thing');
    expect(text).toContain('Blockers:');
    expect(text).toContain('Commit the locked script');
    const sources = new Set(pkg.manifest.map((m) => m.source));
    expect(sources).toContain('objective_progress');
    expect(sources).toContain('blocker');
    expect(sources).toContain('recent_outcome');
    expect(sources).toContain('pending_review');
  });

  it('excludes the current task from its own state', async () => {
    const r = await withTenant(ctxA, (tx) => selectRelatedTasks(tx, ctxA, objectiveA, null));
    const runningId = r.active.find((t) => t.status === 'running')!.taskId;
    const r2 = await withTenant(ctxA, (tx) => selectRelatedTasks(tx, ctxA, objectiveA, runningId));
    expect(r2.active.every((t) => t.taskId !== runningId)).toBe(true);
  });

  it('ISOLATION: workspace B state contains none of workspace A records', async () => {
    const r = await withTenant(ctxB, (tx) => selectRelatedTasks(tx, ctxB, null, null));
    expect(r.blockers).toEqual([]);
    expect(r.active).toEqual([]);
    expect(r.recent).toEqual([]);

    const reviews = await withTenant(ctxB, (tx) => selectPendingReviews(tx, ctxB));
    expect(reviews).toEqual([]);

    // B cannot even read A's objective progress.
    const p = await withTenant(ctxB, (tx) => selectObjectiveProgress(tx, ctxB, objectiveA));
    expect(p).toBeNull();

    const pkg = await withTenant(ctxB, (tx) => assembleProjectState(tx, ctxB, null, null));
    expect(pkg.contextItem).toBeNull();
    expect(pkg.manifest).toEqual([]);
  });
});
