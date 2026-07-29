import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { withTenant } from '@/db/tenant';
import { agents, decisions, memberships, objectives, organizations, profiles, projectMembers, projects, runs, tasks } from '@/db/schema';
import {
  acceptDecision,
  assembleDecisionMemory,
  createDecision,
  detectSharedApplicability,
  getDecisionDetail,
  getDecisionLifecycle,
  listDecisions,
  listInjectionsForDecision,
  logDecisionInjections,
  objectiveTaskIds,
  retireDecision,
} from '@/domain/decisions/decisions';
import { type TaskStatus } from '@/types/domain';

/**
 * Decision Memory (O-19) acceptance scenarios + supersession + isolation.
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
  console.warn(`[decisions.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

let orgId = '';
let userId = '';
let ctxA: TenantContext;
let ctxB: TenantContext;

async function makeWorkspace(): Promise<TenantContext> {
  const db = getSetupDb();
  const p = await db.insert(projects).values({ orgId, key: fixtureKey('dec'), name: 'Dec Project' }).returning({ id: projects.id });
  await db.insert(projectMembers).values({ orgId, projectId: p[0]!.id, userId, role: 'admin' });
  return { userId, orgId, projectId: p[0]!.id, orgRole: 'owner', projectRole: 'admin' };
}

async function mkTask(ctx: TenantContext, title: string, status: TaskStatus = 'completed'): Promise<string> {
  const t = await getSetupDb()
    .insert(tasks)
    .values({ orgId, projectId: ctx.projectId, title, input: 'x', providerSelection: 'openai', status, createdBy: userId })
    .returning({ id: tasks.id });
  return t[0]!.id;
}

async function mkObjective(ctx: TenantContext, title: string, status: 'draft' | 'active' | 'completed' | 'cancelled' = 'active'): Promise<string> {
  const o = await getSetupDb()
    .insert(objectives)
    .values({ orgId, projectId: ctx.projectId, title, status, createdBy: userId })
    .returning({ id: objectives.id });
  return o[0]!.id;
}

/** A run row for injection-trail tests (needs a primary agent). */
async function mkRun(ctx: TenantContext, taskId: string): Promise<string> {
  const a = await getSetupDb()
    .insert(agents)
    .values({ orgId, projectId: ctx.projectId, name: `A-${randomUUID().slice(0, 6)}`, role: 'primary', provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'x' })
    .returning({ id: agents.id });
  const r = await getSetupDb()
    .insert(runs)
    .values({ classification: 'live', orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: a[0]!.id })
    .returning({ id: runs.id });
  return r[0]!.id;
}

const noArgs = (taskId: string) => ({ currentTaskId: taskId, currentObjectiveId: null, objectiveTaskIds: [], docPaths: new Set<string>() });

beforeAll(async () => {
  if (!available) return;
  const db = getSetupDb();
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
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
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

  it('Test 1 — an accepted decision related to the run is present in the memory block', async () => {
    const t = await mkTask(ctxA, 'runtime task');
    const id = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', {
        title: 'Episode runtime fixed at 22:00',
        summary: 'All Season 1 episodes target a 22:00 runtime.',
        decisionType: 'creative',
        originatingTaskId: t, // structural relationship → eligible for this run
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
      createDecision(tx, ctxA, 'Owner', { title: 'Runtime 22 minutes', summary: '22 min', decisionType: 'creative', originatingTaskId: t }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, a));
    const b = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', {
        title: 'Runtime 24 minutes',
        summary: '24 min',
        decisionType: 'creative',
        originatingTaskId: t, // related to the run → eligible; A is excluded as superseded
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

  it('eligibility — an UNRELATED accepted decision is not injected, even as the only candidate', async () => {
    // Recency may rank applicable memory; it may not create applicability.
    const originTask = await mkTask(ctxA, 'unrelated origin task');
    const runTask = await mkTask(ctxA, 'run with no relationship');
    const d = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', { title: 'Unrelated conclusion', summary: 's', originatingTaskId: originTask }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, d));
    // runTask shares no task, no objective, no supporting reference with the decision. Even though it
    // is accepted, recent, and there are far fewer than ten candidates, it must NOT be injected.
    const mem = await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(runTask)));
    expect(mem.contextItem?.content ?? '').not.toContain('Unrelated conclusion');
  });

  it('eligibility — a shared supporting reference makes a decision eligible (not only task match)', async () => {
    const originTask = await mkTask(ctxA, 'doc-origin task');
    const runTask = await mkTask(ctxA, 'doc-run task');
    const d = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', {
        title: 'Doc-grounded conclusion',
        summary: 's',
        scope: 'workspace', // workspace scope lets a shared doc reference count as relevance
        originatingTaskId: originTask, // NOT the run task
        supportingRefs: ['canon/bible.md'],
      }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, d));
    // The run references the same document → structural relationship established.
    const mem = await withTenant(ctxA, (tx) =>
      assembleDecisionMemory(tx, ctxA, { currentTaskId: runTask, currentObjectiveId: null, objectiveTaskIds: [], docPaths: new Set(['canon/bible.md']) }),
    );
    expect(mem.contextItem?.content ?? '').toContain('Doc-grounded conclusion');
  });

  it('applicability — a record-only decision is preserved but never injected', async () => {
    const t = await mkTask(ctxA, 'record-only task');
    const d = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', { title: 'Historical: sample too small', summary: 's', applicability: 'record', originatingTaskId: t }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, d));
    const mem = await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(t)));
    // Related and accepted, but record-only → never applied as guidance.
    expect(mem.contextItem?.content ?? '').not.toContain('sample too small');
    // Still preserved as a legitimate record.
    const all = await withTenant(ctxA, (tx) => listDecisions(tx, ctxA));
    expect(all.find((x) => x.id === d)!.applicability).toBe('record');
  });

  it('validity — an expired decision is historical, not active; a future one is still active', async () => {
    const t = await mkTask(ctxA, 'validity task');
    const past = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', { title: 'Freeze deploys (lapsed)', summary: 's', originatingTaskId: t, effectiveUntil: new Date('2020-01-01') }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, past));
    const future = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', { title: 'Freeze deploys (active)', summary: 's', originatingTaskId: t, effectiveUntil: new Date('2099-01-01') }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, future));
    const content = (await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(t)))).contextItem?.content ?? '';
    expect(content).not.toContain('lapsed');
    expect(content).toContain('active');
  });

  it('scope — a concrete target is required; malformed scope combinations are rejected', async () => {
    // Task scope without a task id, objective scope without an objective id → rejected.
    await expect(
      withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'x', summary: 's', scope: 'task', applicability: 'guidance' })),
    ).rejects.toThrow(/must name the task/i);
    await expect(
      withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'x', summary: 's', scope: 'objective', applicability: 'guidance' })),
    ).rejects.toThrow(/must name the objective/i);
    // A scope target from another workspace is rejected.
    const foreignTask = await mkTask(ctxB, 'B task', 'running');
    await expect(
      withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'x', summary: 's', scope: 'task', scopeTaskId: foreignTask })),
    ).rejects.toThrow(/not in this workspace/i);
  });

  it('scope — task guidance reaches its own live task, not a sibling', async () => {
    const owningTask = await mkTask(ctxA, 'scope owner', 'running');
    const siblingTask = await mkTask(ctxA, 'scope sibling', 'running');
    const d = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', { title: 'Task-only convention', summary: 's', scope: 'task', scopeTaskId: owningTask }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, d));
    const sibling = await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(siblingTask)));
    expect(sibling.contextItem?.content ?? '').not.toContain('Task-only convention');
    const own = await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(owningTask)));
    expect(own.contextItem?.content ?? '').toContain('Task-only convention');
  });

  it('lifecycle — task guidance is not injected once its task is completed or cancelled', async () => {
    const doneTask = await mkTask(ctxA, 'completed scope task', 'completed');
    const cancelledTask = await mkTask(ctxA, 'cancelled scope task', 'cancelled');
    const dDone = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'For a completed task', summary: 's', scope: 'task', scopeTaskId: doneTask }));
    const dCancelled = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'For a cancelled task', summary: 's', scope: 'task', scopeTaskId: cancelledTask }));
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, dDone));
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, dCancelled));
    const m1 = await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(doneTask)));
    const m2 = await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(cancelledTask)));
    expect(m1.contextItem?.content ?? '').not.toContain('For a completed task');
    expect(m2.contextItem?.content ?? '').not.toContain('For a cancelled task');
    // The records are preserved, not deleted or rejected.
    const all = await withTenant(ctxA, (tx) => listDecisions(tx, ctxA));
    expect(all.find((x) => x.id === dDone)!.status).toBe('accepted');
  });

  it('lifecycle — objective guidance reaches siblings while open, and stops when the objective closes', async () => {
    const openObj = await mkObjective(ctxA, 'Open objective', 'active');
    const runTask = await mkTask(ctxA, 'obj run', 'running');
    const d = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', { title: 'Objective-wide convention', summary: 's', scope: 'objective', scopeObjectiveId: openObj }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, d));
    const args = { currentTaskId: runTask, currentObjectiveId: openObj, objectiveTaskIds: [], docPaths: new Set<string>() };
    expect((await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, args))).contextItem?.content ?? '').toContain('Objective-wide convention');
    // Close the objective → the guidance stops being injected, but the record survives.
    await getSetupDb().update(objectives).set({ status: 'completed' }).where(eq(objectives.id, openObj));
    expect((await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, args))).contextItem?.content ?? '').not.toContain('Objective-wide convention');
    expect((await withTenant(ctxA, (tx) => listDecisions(tx, ctxA))).find((x) => x.id === d)!.status).toBe('accepted');
  });

  it('retirement — active guidance can be retired without a replacement; record-only cannot', async () => {
    const t = await mkTask(ctxA, 'retire task', 'running');
    const d = await withTenant(ctxA, (tx) =>
      createDecision(tx, ctxA, 'Owner', { title: 'Retire me', summary: 's', scope: 'task', scopeTaskId: t }),
    );
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, d));
    await withTenant(ctxA, (tx) => retireDecision(tx, ctxA, d, 'no longer applies'));
    const all = await withTenant(ctxA, (tx) => listDecisions(tx, ctxA));
    expect(all.find((x) => x.id === d)!.status).toBe('retired');
    expect(all.find((x) => x.id === d)!.statusReason).toBe('no longer applies');
    expect((await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(t)))).contextItem?.content ?? '').not.toContain('Retire me');
    // A record-only decision was never active guidance → retiring it is rejected.
    const rec = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'Record', summary: 's', applicability: 'record' }));
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, rec));
    await expect(withTenant(ctxA, (tx) => retireDecision(tx, ctxA, rec))).rejects.toThrow(/record-only/i);
  });

  it('AI activation — acceptance alone cannot turn a record-only proposal into active guidance', async () => {
    const t = await mkTask(ctxA, 'promo task', 'running');
    // A record-only proposal (as AI candidates are filed).
    const p1 = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'AI suggestion', { title: 'Proposed conclusion', summary: 's', applicability: 'record', scope: 'task', scopeTaskId: t }));
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, p1)); // plain accept — no promotion
    const after = (await withTenant(ctxA, (tx) => listDecisions(tx, ctxA))).find((x) => x.id === p1)!;
    expect(after.applicability).toBe('record'); // stayed record-only
    expect((await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(t)))).contextItem?.content ?? '').not.toContain('Proposed conclusion');
  });

  it('AI activation — promoting to guidance requires an explicit scope target', async () => {
    const t = await mkTask(ctxA, 'promo task 2', 'running');
    const p = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'AI suggestion', { title: 'Promote me', summary: 's', applicability: 'record', scope: 'task', scopeTaskId: t }));
    // Promoting to task guidance without naming the task is rejected.
    await expect(
      withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, p, { applicability: 'guidance', scope: 'task' })),
    ).rejects.toThrow(/must name the task/i);
    // Explicit promotion to task guidance with the concrete target activates it (traceable change).
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, p, { applicability: 'guidance', scope: 'task', scopeTaskId: t }));
    const after = (await withTenant(ctxA, (tx) => listDecisions(tx, ctxA))).find((x) => x.id === p)!;
    expect(after.applicability).toBe('guidance');
    expect(after.scope).toBe('task');
    expect((await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(t)))).contextItem?.content ?? '').toContain('Promote me');
  });

  it('suggested reuse is evidence for review, never the decision\'s actual scope', async () => {
    const t = await mkTask(ctxA, 'suggest task', 'running');
    // Simulate an AI candidate: record-only actual, with a SEPARATE suggested guidance/task target.
    const ins = await getSetupDb()
      .insert(decisions)
      .values({
        orgId, projectId: ctxA.projectId, title: 'AI conclusion', summary: 's', authorLabel: 'AI suggestion', status: 'proposed',
        applicability: 'record', suggestedByRunId: null, suggestedApplicability: 'guidance', suggestedScope: 'task', suggestedScopeTaskId: t,
      })
      .returning({ id: decisions.id });
    const id = ins[0]!.id;
    const before = (await withTenant(ctxA, (tx) => listDecisions(tx, ctxA))).find((x) => x.id === id)!;
    expect(before.applicability).toBe('record'); // actual
    expect(before.scopeTaskId).toBeNull(); // actual scope unset
    expect(before.suggestedApplicability).toBe('guidance'); // suggestion preserved separately
    expect(before.suggestedScope).toBe('task');

    // Plain accept → stays record-only, no active scope, not injected (selector uses ACTUAL only).
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, id));
    const accepted = (await withTenant(ctxA, (tx) => listDecisions(tx, ctxA))).find((x) => x.id === id)!;
    expect(accepted.applicability).toBe('record');
    expect(accepted.scopeTaskId).toBeNull();
    expect((await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(t)))).contextItem?.content ?? '').not.toContain('AI conclusion');
  });

  it('promotion records the operator-selected scope, even when it differs from the AI suggestion', async () => {
    const t = await mkTask(ctxA, 'promo-diff task', 'running');
    const ins = await getSetupDb()
      .insert(decisions)
      .values({ orgId, projectId: ctxA.projectId, title: 'AI wants task scope', summary: 's', authorLabel: 'AI suggestion', status: 'proposed', applicability: 'record', suggestedApplicability: 'guidance', suggestedScope: 'task', suggestedScopeTaskId: t })
      .returning({ id: decisions.id });
    const id = ins[0]!.id;
    // Operator promotes to WORKSPACE guidance (differs from the suggested task scope).
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, id, { applicability: 'guidance', scope: 'workspace' }));
    const after = (await withTenant(ctxA, (tx) => listDecisions(tx, ctxA))).find((x) => x.id === id)!;
    expect(after.applicability).toBe('guidance');
    expect(after.scope).toBe('workspace'); // operator's choice, not the AI's task suggestion
    expect(after.suggestedScope).toBe('task'); // suggestion unchanged
  });

  it('lifecycle provenance is read from the audit log — acceptance and retirement authority', async () => {
    const t = await mkTask(ctxA, 'provenance task', 'running');
    const id = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'Provenance', summary: 's', scope: 'task', scopeTaskId: t }));
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, id));
    await withTenant(ctxA, (tx) => retireDecision(tx, ctxA, id, 'context closed'));
    const events = await withTenant(ctxA, (tx) => getDecisionLifecycle(tx, ctxA, id));
    const accepted = events.find((e) => e.action === 'decision.accepted')!;
    const retired = events.find((e) => e.action === 'decision.retired')!;
    expect(accepted.actorName).toBe('Owner');
    expect(accepted.at).toBeInstanceOf(Date);
    expect(retired.reason).toBe('context closed');
  });

  it('injection trail is idempotent and preserves the exact memory text supplied', async () => {
    const t = await mkTask(ctxA, 'inj task', 'running');
    const id = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'Injected', summary: 's', scope: 'task', scopeTaskId: t }));
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, id));
    const run1 = await mkRun(ctxA, t);
    const snapshot = 'EXACT memory line as supplied';
    // Log the same (run, decision) twice → one record (runner-retry safe).
    await withTenant(ctxA, (tx) => logDecisionInjections(tx, ctxA, { runId: run1, taskId: t, injected: [{ decisionId: id, reason: 'task', memoryText: snapshot }] }));
    await withTenant(ctxA, (tx) => logDecisionInjections(tx, ctxA, { runId: run1, taskId: t, injected: [{ decisionId: id, reason: 'task', memoryText: 'DIFFERENT (should be ignored)' }] }));
    let trail = await withTenant(ctxA, (tx) => listInjectionsForDecision(tx, ctxA, id));
    expect(trail).toHaveLength(1);
    expect(trail[0]!.reason).toBe('task');
    expect(trail[0]!.memoryText).toBe(snapshot);

    // The snapshot is immutable to later decision changes.
    await getSetupDb().update(decisions).set({ title: 'Renamed later' }).where(eq(decisions.id, id));
    trail = await withTenant(ctxA, (tx) => listInjectionsForDecision(tx, ctxA, id));
    expect(trail[0]!.memoryText).toBe(snapshot);

    // A second run creates a second record.
    const run2 = await mkRun(ctxA, t);
    await withTenant(ctxA, (tx) => logDecisionInjections(tx, ctxA, { runId: run2, taskId: t, injected: [{ decisionId: id, reason: 'task', memoryText: snapshot }] }));
    expect(await withTenant(ctxA, (tx) => listInjectionsForDecision(tx, ctxA, id))).toHaveLength(2);
  });

  it('shared applicability is observed, not called conflict', async () => {
    const obj = await mkObjective(ctxA, 'Shared objective', 'active');
    const d1 = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'Flat-fee framing', summary: 's', scope: 'objective', scopeObjectiveId: obj }));
    const d2 = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'Plain language', summary: 's', scope: 'objective', scopeObjectiveId: obj }));
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, d1));
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, d2));
    const all = await withTenant(ctxA, (tx) => listDecisions(tx, ctxA));
    const overlaps = detectSharedApplicability(all);
    const forObj = overlaps.find((o) => o.objectiveId === obj)!;
    // Two harmonious decisions share applicability — reported as an overlap, never as a conflict.
    expect(forObj.decisions.length).toBeGreaterThanOrEqual(2);
  });

  it('cross-surface — active guidance is injected ONLY into a relevant run; inactive guidance never', async () => {
    // Active guidance is a PREREQUISITE for injection, not a guarantee: it must also be relevant to
    // the run. Detail-active + relevant run → injected.
    const liveTask = await mkTask(ctxA, 'xsurface live', 'running');
    const dLive = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'Cross active', summary: 's', scope: 'task', scopeTaskId: liveTask }));
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, dLive));
    const detailLive = await withTenant(ctxA, (tx) => getDecisionDetail(tx, ctxA, dLive));
    expect(detailLive.assessment.isActiveGuidance).toBe(true);
    expect((await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(liveTask)))).contextItem?.content ?? '').toContain('Cross active');

    // Active but NOT relevant: the same active guidance is NOT injected into an unrelated run.
    const otherTask = await mkTask(ctxA, 'xsurface other', 'running');
    expect((await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(otherTask)))).contextItem?.content ?? '').not.toContain('Cross active');

    // Scope-closed guidance: Detail says inactive AND the selector does NOT inject it, even for its own task.
    const doneTask = await mkTask(ctxA, 'xsurface done', 'completed');
    const dClosed = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'Cross closed', summary: 's', scope: 'task', scopeTaskId: doneTask }));
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, dClosed));
    const detailClosed = await withTenant(ctxA, (tx) => getDecisionDetail(tx, ctxA, dClosed));
    expect(detailClosed.assessment.isActiveGuidance).toBe(false);
    expect(detailClosed.assessment.inactiveReason).toBe('task_closed');
    expect((await withTenant(ctxA, (tx) => assembleDecisionMemory(tx, ctxA, noArgs(doneTask)))).contextItem?.content ?? '').not.toContain('Cross closed');
  });

  it('Detail shows lifecycle authority only from recorded events', async () => {
    const t = await mkTask(ctxA, 'detail prov', 'running');
    const id = await withTenant(ctxA, (tx) => createDecision(tx, ctxA, 'Owner', { title: 'Detail provenance', summary: 's', scope: 'task', scopeTaskId: t }));
    // Before acceptance: no accepted event → Detail must not claim an acceptor.
    const before = await withTenant(ctxA, (tx) => getDecisionDetail(tx, ctxA, id));
    expect(before.lifecycle.find((e) => e.action === 'decision.accepted')).toBeUndefined();
    await withTenant(ctxA, (tx) => acceptDecision(tx, ctxA, id));
    const after = await withTenant(ctxA, (tx) => getDecisionDetail(tx, ctxA, id));
    const acc = after.lifecycle.find((e) => e.action === 'decision.accepted')!;
    expect(acc.actorName).toBe('Owner');
    expect(acc.at).toBeInstanceOf(Date);
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
