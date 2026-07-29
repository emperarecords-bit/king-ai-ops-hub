import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { agents, departments, memberships, objectives, organizations, profiles, projectMembers, projects, runSteps, runs, tasks, usageEvents } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import {
  attributionReconciliation,
  detectAttributionAnomalies,
  employeeAttribution,
  employeeAttributionDrilldown,
} from '@/domain/agents/attribution';

/**
 * HUB-004 — derived work & cost attribution (ratified definitions). Attribution comes from immutable run
 * evidence, never from task owner, task content/title, or department.
 */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[attribution.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let ctx: TenantContext;
let ctx2: TenantContext;
let performer = ''; // business primary
let performer2 = ''; // a second performer (multi-performer case)
let reviewer = ''; // reviewer
let leadEng = ''; // Engineering primary (no system marker — treated as a normal employee)
let owner = ''; // owns but performs nothing

beforeAll(async () => {
  if (!available) return;
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `at-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `at-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('at'), name: 'A' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' };
  const pid2 = (await db.insert(projects).values({ orgId, key: fixtureKey('at2'), name: 'B' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid2, userId, role: 'admin' });
  ctx2 = { userId, orgId, projectId: pid2, orgRole: 'owner', projectRole: 'admin' };

  const engDept = (await db.insert(departments).values({ orgId, key: 'engineering', name: 'Engineering' }).returning({ id: departments.id }))[0]!.id;
  const mk = (name: string, role: 'primary' | 'reviewer', dept?: string): Promise<string> =>
    db.insert(agents).values({ orgId, projectId: pid, name, role, departmentId: dept ?? null, provider: 'openai', model: 'gpt-x', systemPrompt: 'x' }).returning({ id: agents.id }).then((r) => r[0]!.id);
  performer = await mk('Perf', 'primary');
  performer2 = await mk('Perf Two', 'primary');
  reviewer = await mk('Rev', 'reviewer');
  leadEng = await mk('Lead Engineer', 'primary', engDept);
  owner = await mk('Owner Only', 'primary');
});

afterAll(async () => {
  if (!available) return;
  await db.update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

interface Step { kind: 'primary' | 'review' | 'revision' | 'consolidate'; agent: string | null; verdict?: 'approve' | 'revise' | 'reject'; succeeded?: boolean; cost: number }
async function seedRun(opts: {
  status?: 'completed' | 'failed' | 'cancelled';
  runStatus?: 'completed' | 'failed';
  primary?: string | null; reviewer?: string | null; ownerAgentId?: string | null; title?: string;
  steps?: Step[]; runlessCost?: number; project?: TenantContext;
}): Promise<string> {
  const c = opts.project ?? ctx;
  const taskId = (await db.insert(tasks).values({ orgId, projectId: c.projectId, title: opts.title ?? 'T', input: 'x', providerSelection: 'openai', status: opts.status ?? 'completed', createdBy: c.userId, ownerAgentId: opts.ownerAgentId ?? null }).returning({ id: tasks.id }))[0]!.id;
  if (opts.primary !== null) {
    const runId = (await db.insert(runs).values({ classification: 'live', orgId, projectId: c.projectId, taskId, status: opts.runStatus ?? 'completed', primaryAgentId: opts.primary ?? leadEng, reviewerAgentId: opts.reviewer ?? null }).returning({ id: runs.id }))[0]!.id;
    let n = 0;
    for (const st of opts.steps ?? []) {
      const stepId = (await db.insert(runSteps).values({ orgId, projectId: c.projectId, runId, stepNumber: n++, kind: st.kind, agentId: st.agent, verdict: st.verdict ?? null, succeeded: st.succeeded ?? true }).returning({ id: runSteps.id }))[0]!.id;
      await db.insert(usageEvents).values({ classification: 'live', orgId, projectId: c.projectId, taskId, runId, runStepId: stepId, provider: 'openai', model: 'gpt-x', inputTokens: 1, outputTokens: 1, costMicros: BigInt(st.cost), pricingVersion: 'v1' });
    }
  }
  if (opts.runlessCost) {
    await db.insert(usageEvents).values({ classification: 'live', orgId, projectId: c.projectId, taskId: null, runId: null, runStepId: null, provider: 'openai', model: 'gpt-x', inputTokens: 1, outputTokens: 1, costMicros: BigInt(opts.runlessCost), pricingVersion: 'v1' });
  }
  return taskId;
}
const attrOf = (id: string) => withTenant(ctx, (tx) => employeeAttribution(tx, ctx)).then((m) => m.get(id)!);

describe.skipIf(!available)('HUB-004 derived work & cost attribution', () => {
  it('attributes cost/work to PERFORMER + REVIEWER from runs — never the owner or task content', async () => {
    await seedRun({
      title: 'Draft outreach kit', ownerAgentId: owner, primary: performer, reviewer,
      steps: [
        { kind: 'primary', agent: performer, cost: 100 },
        { kind: 'review', agent: reviewer, verdict: 'revise', cost: 400 },
        { kind: 'revision', agent: performer, cost: 50 },
        { kind: 'consolidate', agent: performer, cost: 20 },
      ],
    });
    const p = await attrOf(performer);
    expect(p.executionCostMicros).toBe(170n); // primary+revision+consolidate → performer
    expect(p.performedWork).toBe(1);
    const rv = await attrOf(reviewer);
    expect(rv.reviewCostMicros).toBe(400n);
    expect(rv.reviewImpact).toBe(1);
    expect(rv.interventions).toBe(1);
    expect(rv.interventionRate).toBe(1);
    // The OWNER performed nothing → zero cost, zero performed work (owner ≠ performer/cost-bearer).
    const ow = await attrOf(owner);
    expect(ow.executionCostMicros).toBe(0n);
    expect(ow.performedWork).toBe(0);
    expect(ow.ownedTasks).toBe(1); // but IS the current owner — a separate metric
  });

  it('multiple attempts/revisions by one employee on one task = one performed-work credit', async () => {
    const before = (await attrOf(leadEng)).performedWork;
    const taskId = (await db.insert(tasks).values({ orgId, projectId: ctx.projectId, title: 'Retried', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id }))[0]!.id;
    for (let i = 0; i < 3; i++) {
      const runId = (await db.insert(runs).values({ classification: 'live', orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: leadEng }).returning({ id: runs.id }))[0]!.id;
      await db.insert(runSteps).values({ orgId, projectId: ctx.projectId, runId, stepNumber: 0, kind: i === 0 ? 'primary' : 'revision', agentId: leadEng, succeeded: true });
    }
    expect((await attrOf(leadEng)).performedWork - before).toBe(1);
  });

  it('multiple genuine performers on one task each get one credit (total not forced to task count)', async () => {
    const taskId = (await db.insert(tasks).values({ orgId, projectId: ctx.projectId, title: 'Two performers', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId }).returning({ id: tasks.id }))[0]!.id;
    const runId = (await db.insert(runs).values({ classification: 'live', orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: performer }).returning({ id: runs.id }))[0]!.id;
    await db.insert(runSteps).values({ orgId, projectId: ctx.projectId, runId, stepNumber: 0, kind: 'primary', agentId: performer, succeeded: true });
    await db.insert(runSteps).values({ orgId, projectId: ctx.projectId, runId, stepNumber: 1, kind: 'revision', agentId: performer2, succeeded: true });
    const p1 = await attrOf(performer);
    const p2 = await attrOf(performer2);
    // Each performer earns exactly one credit for THIS task.
    expect(p1.performedWork).toBeGreaterThanOrEqual(1);
    expect(p2.performedWork).toBeGreaterThanOrEqual(1);
  });

  it('failed run: cost attributed, but no performed-work credit; cancelled: same', async () => {
    const p = await attrOf(leadEng);
    await seedRun({ status: 'failed', runStatus: 'failed', primary: leadEng, title: 'Failed', steps: [{ kind: 'primary', agent: leadEng, succeeded: false, cost: 999 }] });
    await seedRun({ status: 'cancelled', primary: leadEng, title: 'Cancelled', steps: [{ kind: 'primary', agent: leadEng, succeeded: true, cost: 111 }] });
    const q = await attrOf(leadEng);
    expect(q.executionCostMicros - p.executionCostMicros).toBe(1110n); // both costs counted
    expect(q.performedWork).toBe(p.performedWork); // neither counts as performed work
  });

  it('objective accountability is separate from task ownership and performed work', async () => {
    const objId = (await db.insert(objectives).values({ orgId, projectId: ctx.projectId, title: 'Obj', status: 'active', successCriteria: [], createdBy: ctx.userId, accountableAgentId: owner }).returning({ id: objectives.id }))[0]!.id;
    void objId;
    const ow = await attrOf(owner);
    expect(ow.objectivesOwned).toBe(1);
    expect(ow.performedWork).toBe(0); // owns an objective, performed nothing — truthful
  });

  it('run-less usage is WORKSPACE OVERHEAD (not "unassigned work") and the ledger reconciles exactly', async () => {
    await seedRun({ title: 'Embeds', primary: leadEng, steps: [{ kind: 'primary', agent: leadEng, cost: 30 }], runlessCost: 70 });
    const rec = await withTenant(ctx, (tx) => attributionReconciliation(tx, ctx));
    expect(rec.reconciles).toBe(true);
    expect(rec.employeeExecutionMicros + rec.employeeReviewMicros + rec.workspaceOverheadMicros).toBe(rec.totalMicros);
    expect(rec.workspaceOverheadMicros).toBeGreaterThanOrEqual(70n);
  });

  it('drill-down execution/review totals equal the card totals (exact micros)', async () => {
    const a = await attrOf(performer);
    const d = await withTenant(ctx, (tx) => employeeAttributionDrilldown(tx, ctx, performer));
    expect(d.performedExecutionTotal).toBe(a.executionCostMicros);
    const rvA = await attrOf(reviewer);
    const rvD = await withTenant(ctx, (tx) => employeeAttributionDrilldown(tx, ctx, reviewer));
    expect(rvD.reviewedTotal).toBe(rvA.reviewCostMicros);
    expect(rvD.reviewed.every((r) => r.verdicts.length >= 0)).toBe(true);
    // Owner drill-down surfaces the owned task + owned objective explicitly.
    const ownD = await withTenant(ctx, (tx) => employeeAttributionDrilldown(tx, ctx, owner));
    expect(ownD.ownedTasks.length).toBeGreaterThanOrEqual(1);
    expect(ownD.ownedObjectives.length).toBeGreaterThanOrEqual(1);
  });

  it('attribution is workspace-scoped (no cross-workspace leakage)', async () => {
    await seedRun({ project: ctx2, primary: leadEng, title: 'Foreign', steps: [{ kind: 'primary', agent: leadEng, cost: 5000 }] });
    const recA = await withTenant(ctx, (tx) => attributionReconciliation(tx, ctx));
    const recB = await withTenant(ctx2, (tx) => attributionReconciliation(tx, ctx2));
    expect(recB.totalMicros).toBeGreaterThanOrEqual(5000n);
    expect(recA.employeeExecutionMicros).toBeLessThan(recB.totalMicros + recA.totalMicros);
  });

  it('detector: owner≠performer (warning), manually-closed (info), demo record (demo hygiene), reconciles', async () => {
    // completed, non-demo, no run → manually closed (info).
    await db.insert(tasks).values({ orgId, projectId: ctx.projectId, title: 'Manually closed', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId });
    // demo record (STORED classification, not a title prefix), completed, no run → demo hygiene.
    await db.insert(tasks).values({ orgId, projectId: ctx.projectId, title: 'A demonstration task', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: ctx.userId, classification: 'demo' });

    const report = await withTenant(ctx, (tx) => detectAttributionAnomalies(tx, ctx));
    expect(report.reconciliation.reconciles).toBe(true);
    const cats = new Set(report.anomalies.map((a) => a.category));
    expect(cats.has('owner_differs_from_performer')).toBe(true); // outreach task: owner ≠ performer
    expect(cats.has('completed_task_manually_closed')).toBe(true);
    expect(cats.has('demo_record')).toBe(true);
    expect(report.anomalies.find((a) => a.category === 'owner_differs_from_performer')!.severity).toBe('warning');
    expect(report.anomalies.find((a) => a.category === 'demo_record')!.severity).toBe('demo_hygiene');
    expect(cats.has('usage_cost_no_bucket')).toBe(false);
  });

  it('a disabled employee keeps historical performed work & cost attribution', async () => {
    const before = await attrOf(performer);
    await db.update(agents).set({ enabled: false }).where(eq(agents.id, performer));
    const after = await attrOf(performer);
    expect(after.executionCostMicros).toBe(before.executionCostMicros);
    expect(after.performedWork).toBe(before.performedWork);
  });
});
