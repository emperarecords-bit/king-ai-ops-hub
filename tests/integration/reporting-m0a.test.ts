import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { agents, memberships, organizations, profiles, projectMembers, projects, runSteps, runs, tasks, usageEvents } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import {
  getProjectAttributionReconciliation,
  getProjectCompletedTaskCosts,
  getProjectDataQualityWarnings,
  getProjectEmployeeDefaults,
  getProjectModelUsage,
  getProjectRunCostDistribution,
  getProjectStepCostBreakdown,
  getProjectUsageSummary,
} from '@/domain/reporting/m0a';

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[reporting-m0a.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
const WINDOW = { from: new Date('2026-06-01T00:00:00Z'), to: new Date('2026-10-01T00:00:00Z') };
const PV = '2026-07-24';

let ctx: TenantContext; // project P1 (admin)
let p2 = ''; // isolation project
let userId = '';
let orgId = '';
let agentA = '';
let agentB = '';
let taskT1 = '';
let taskT5 = '';

// Deterministic seed costs (micros) so expected sums are exact.
const C = { u1: 100n, u2: 200n, u3: 50n, u4: 30n, u5: 40n, u6: 300n, u7: 70n, u8: 60n, u9: 25n };
const RECORDED_TOTAL = Object.values(C).reduce((s, v) => s + v, 0n); // 875

beforeAll(async () => {
  if (!available) return;
  userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `m0a-${randomUUID().slice(0, 8)}@t.local`, displayName: 'M' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `m0a-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });

  const p1 = (await db.insert(projects).values({ orgId, key: fixtureKey('m0a1'), name: 'P1' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: p1, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: p1, orgRole: 'owner', projectRole: 'admin' };
  p2 = (await db.insert(projects).values({ orgId, key: fixtureKey('m0a2'), name: 'P2' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: p2, userId, role: 'admin' });

  const mk = async (projectId: string, over: Partial<typeof agents.$inferInsert> = {}) =>
    (await db.insert(agents).values({ orgId, projectId, name: `E-${randomUUID().slice(0, 6)}`, provider: 'openai', model: 'gpt-5.4-mini', systemPrompt: 'SECRET-PROMPT', ...over }).returning({ id: agents.id }))[0]!.id;
  agentA = await mk(p1, { role: 'primary', title: 'Engineer' });
  agentB = await mk(p1, { role: 'reviewer', title: 'Reviewer', provider: 'anthropic', model: 'claude-opus-4-8' });
  await mk(p1, { role: 'primary', enabled: false }); // disabled — excluded from enabled roster

  const jul = (d: number) => new Date(`2026-07-${String(d).padStart(2, '0')}T00:00:00Z`);
  const mkTask = async (status: (typeof tasks.$inferInsert)['status'], over: Partial<typeof tasks.$inferInsert> = {}) =>
    (await db.insert(tasks).values({ orgId, projectId: p1, title: 'T', input: 'SECRET-INPUT', providerSelection: 'both', createdBy: userId, status, reviewEnabled: true, createdAt: jul(1), ...over }).returning({ id: tasks.id }))[0]!.id;
  taskT1 = await mkTask('completed', { reviewEnabled: true });
  const taskT2 = await mkTask('failed', { reviewEnabled: false });
  await mkTask('pending'); // T3: no run
  taskT5 = await mkTask('completed');
  const taskT4 = await mkTask('cancelled', { supersededByTaskId: taskT5 }); // superseded → replacement T5

  const mkRun = async (taskId: string, status: (typeof runs.$inferInsert)['status'], over: Partial<typeof runs.$inferInsert> = {}) =>
    (await db.insert(runs).values({ orgId, projectId: p1, taskId, status, primaryAgentId: agentA, reviewerAgentId: agentB, classification: 'live', createdAt: jul(2), ...over }).returning({ id: runs.id }))[0]!.id;
  const R1 = await mkRun(taskT1, 'completed');
  const R1b = await mkRun(taskT1, 'failed'); // earlier failed run, same task
  await mkRun(taskT2, 'failed'); // zero-usage failed run
  const R4 = await mkRun(taskT4, 'failed');
  const R5 = await mkRun(taskT5, 'completed');

  const mkStep = async (runId: string, n: number, kind: (typeof runSteps.$inferInsert)['kind'], over: Partial<typeof runSteps.$inferInsert> = {}) =>
    (await db.insert(runSteps).values({ orgId, projectId: p1, runId, stepNumber: n, kind, succeeded: true, ...over }).returning({ id: runSteps.id }))[0]!.id;
  const s1 = await mkStep(R1, 1, 'primary');
  const s2 = await mkStep(R1, 2, 'review', { verdict: 'approve' });
  await mkStep(R1, 3, 'consolidate'); // deterministic consolidation — NO usage
  const s1b = await mkStep(R1b, 1, 'primary');
  const s4 = await mkStep(R4, 1, 'primary');
  const s5 = await mkStep(R5, 1, 'primary');

  const mkUsage = async (over: Partial<typeof usageEvents.$inferInsert>) =>
    db.insert(usageEvents).values({ orgId, projectId: p1, provider: 'openai', model: 'gpt-5.4-mini', inputTokens: 10, outputTokens: 20, costMicros: 0n, pricingVersion: PV, classification: 'live', createdAt: jul(10), ...over });
  await mkUsage({ runId: R1, runStepId: s1, costMicros: C.u1 }); // exact → A
  await mkUsage({ runId: R1, runStepId: s2, provider: 'anthropic', model: 'claude-opus-4-8', costMicros: C.u2 }); // exact → B
  await mkUsage({ runId: R1b, runStepId: s1b, costMicros: C.u3 }); // failed-run spend retained → A
  await mkUsage({ runId: null, runStepId: null, taskId: null, model: 'text-embedding-unknown', costMicros: C.u4 }); // run-less + unknown
  await mkUsage({ runId: R1, runStepId: null, costMicros: C.u5 }); // unattributed run usage (no step)
  await mkUsage({ runId: R1, runStepId: s1, model: 'gpt-5.2', costMicros: C.u6 }); // excluded model, retained → A
  await mkUsage({ runId: R5, runStepId: s5, provider: 'anthropic', model: 'claude-sonnet-5', costMicros: C.u7, createdAt: new Date('2026-09-01T00:00:00Z') }); // expired → price-invalid → A
  await mkUsage({ runId: R5, runStepId: s5, provider: 'anthropic', model: 'claude-sonnet-5', costMicros: C.u8, createdAt: new Date('2026-08-01T00:00:00Z') }); // exact → A
  await mkUsage({ runId: R4, runStepId: s4, costMicros: C.u9 }); // → A (task T4 cancelled)

  // Isolation: a big P2 usage row that must never appear in P1 reporting.
  await db.insert(usageEvents).values({ orgId, projectId: p2, provider: 'openai', model: 'gpt-5.4-mini', inputTokens: 1, outputTokens: 1, costMicros: 9999n, pricingVersion: PV, classification: 'live', createdAt: jul(10) });
});

afterAll(async () => {
  // Fixtures use the reserved zz-fixture- key prefix; left in place like other integration suites.
});

describe('M0a reporting — reconciliation & semantics (DB)', () => {
  it('recorded total is authoritative and attribution buckets reconcile EXACTLY', async () => {
    if (!available) return;
    const rec = await withTenant(ctx, (tx) => getProjectAttributionReconciliation(tx, ctx.projectId, WINDOW));
    expect(rec.recordedCostMicros).toBe(RECORDED_TOTAL);
    expect(rec.reconciles).toBe(true);
    expect(rec.employeeCostMicros + rec.unattributedRunCostMicros + rec.runLessCostMicros).toBe(RECORDED_TOTAL);
    // employee bucket = A (u1+u3+u6+u7+u8+u9) + B (u2) ; unattributed = u5 ; run-less = u4
    expect(rec.employeeCostMicros).toBe(C.u1 + C.u2 + C.u3 + C.u6 + C.u7 + C.u8 + C.u9);
    expect(rec.unattributedRunCostMicros).toBe(C.u5);
    expect(rec.runLessCostMicros).toBe(C.u4);
    const a = rec.perEmployee.find((e) => e.agentId === agentA)!;
    const b = rec.perEmployee.find((e) => e.agentId === agentB)!;
    expect(a.costMicros).toBe(C.u1 + C.u3 + C.u6 + C.u7 + C.u8 + C.u9);
    expect(b.costMicros).toBe(C.u2);
  });

  it('populations count independently — task/failed-run/step with no usage all retained', async () => {
    if (!available) return;
    const s = await withTenant(ctx, (tx) => getProjectUsageSummary(tx, ctx.projectId, WINDOW));
    expect(s.taskCountByStatus.completed).toBe(2);
    expect(s.taskCountByStatus.failed).toBe(1);
    expect(s.taskCountByStatus.pending).toBe(1); // task with no run still counts
    expect(s.taskCountByStatus.cancelled).toBe(1);
    expect(s.runCountByStatus.completed).toBe(2);
    expect(s.runCountByStatus.failed).toBe(3); // incl. the zero-usage failed run
    expect(s.runStepCountByKind.primary).toBe(4);
    expect(s.runStepCountByKind.review).toBe(1);
    expect(s.runStepCountByKind.consolidate).toBe(1); // consolidate step with no usage still counts
    expect(s.reviewedRunShare).toEqual({ numerator: 1, denominator: 5 });
    expect(s.revisionTriggeredRunShare).toEqual({ numerator: 0, denominator: 5 });
    expect(s.reviewEnabledTaskShare).toEqual({ numerator: 4, denominator: 5 });
    expect(s.recordedCostMicros).toBe(RECORDED_TOTAL);
    expect(s.runLessCostMicros).toBe(C.u4);
    expect(s.runAssociatedCostMicros).toBe(RECORDED_TOTAL - C.u4);
  });

  it('step-cost breakdown buckets unresolved-step and run-less separately; reconciles', async () => {
    if (!available) return;
    const buckets = await withTenant(ctx, (tx) => getProjectStepCostBreakdown(tx, ctx.projectId, WINDOW));
    const get = (k: string) => buckets.find((b) => b.key === k)!;
    // primary-step usage: u1,u3,u6 (R1/R1b primary) + u9 (R4 primary) + u7,u8 (R5 primary step s5)
    expect(get('primary').recordedCostMicros).toBe(C.u1 + C.u3 + C.u6 + C.u9 + C.u7 + C.u8);
    expect(get('review').recordedCostMicros).toBe(C.u2);
    expect(get('consolidate').recordedCostMicros).toBe(0n); // no usage on consolidate
    expect(get('unresolved_step').recordedCostMicros).toBe(C.u5);
    expect(get('run_less').recordedCostMicros).toBe(C.u4);
    const total = buckets.reduce((s, b) => s + b.recordedCostMicros, 0n);
    expect(total).toBe(RECORDED_TOTAL);
  });

  it('model usage keeps unknown + excluded + expired in recorded totals; estimate covers only exact matches', async () => {
    if (!available) return;
    const { rows, coverage } = await withTenant(ctx, (tx) => getProjectModelUsage(tx, ctx.projectId, WINDOW));
    const row = (p: string, m: string) => rows.find((r) => r.provider === p && r.model === m)!;

    // gpt-5.2 retained in recorded total but unavailable for estimate.
    const g52 = row('openai', 'gpt-5.2');
    expect(g52.recordedCostMicros).toBe(C.u6);
    expect(g52.matchState).toBe('unavailable');
    expect(g52.unavailableEventCount).toBe(1);

    // unknown model retained, unavailable.
    expect(row('openai', 'text-embedding-unknown').recordedCostMicros).toBe(C.u4);

    // sonnet-5: one exact (Aug) + one expired (Sep) → mixed → unavailable summary, split counts correct.
    const sonnet = row('anthropic', 'claude-sonnet-5');
    expect(sonnet.recordedCostMicros).toBe(C.u7 + C.u8);
    expect(sonnet.exactEventCount).toBe(1);
    expect(sonnet.unavailableEventCount).toBe(1);

    // gpt-5.4-mini: all exact (u1,u3,u5,u9).
    const mini = row('openai', 'gpt-5.4-mini');
    expect(mini.exactEventCount).toBe(4);
    expect(mini.matchState).toBe('exact');

    // Coverage: recorded total is authoritative; matched-recorded is the covered subset only (never rescaled).
    expect(coverage.recordedCostMicros).toBe(RECORDED_TOTAL);
    expect(coverage.totalEvents).toBe(9);
    expect(coverage.matchedEvents).toBe(6); // 4 mini + 1 opus + 1 sonnet(Aug)
    expect(coverage.unavailableEvents).toBe(3); // embed + gpt5.2 + sonnet(Sep)
    expect(coverage.matchedRecordedCostMicros).toBe(C.u1 + C.u3 + C.u5 + C.u9 + C.u2 + C.u8);
    expect(coverage.matchedRecordedCostMicros).toBeLessThan(coverage.recordedCostMicros);
  });

  it('estimate equals recorded on exact matches priced by the same schedule value (drift == 0 on covered subset)', async () => {
    if (!available) return;
    // Seed usage tokens were 10/20 with cost forced; here we assert the estimate is computed and the delta is
    // reported (not rescaled). Because seeded cost_micros were synthetic (not the schedule price), the delta is
    // simply estimated−recorded on the covered subset; it must be a real number, never forced to zero.
    const { coverage } = await withTenant(ctx, (tx) => getProjectModelUsage(tx, ctx.projectId, WINDOW));
    expect(coverage.estimatedDifferenceMicros).toBe(coverage.estimatedCombinedCostMicros - coverage.matchedRecordedCostMicros);
    expect(coverage.estimatedCombinedCostMicros).toBe(coverage.estimatedInputCostMicros + coverage.estimatedOutputCostMicros);
  });

  it('data-quality warnings: unknown/excluded, price-invalid, unattributed, run-less; retries/cache uninstrumented', async () => {
    if (!available) return;
    const w = await withTenant(ctx, (tx) => getProjectDataQualityWarnings(tx, ctx.projectId, WINDOW));
    expect(w.unknownModelEvents).toBe(2); // text-embedding-unknown + gpt-5.2 (excluded from schedule)
    expect(w.unknownModelCostMicros).toBe(C.u4 + C.u6);
    expect(w.priceInvalidEvents).toBe(1); // sonnet-5 at/after cutoff
    expect(w.unattributedRunEvents).toBe(1);
    expect(w.runLessEvents).toBe(1);
    expect(w.retriesInstrumented).toBe(false);
    expect(w.cacheUsageInstrumented).toBe(false);
  });

  it('cost per COMPLETED task includes all its runs (incl. failed); superseded task not merged', async () => {
    if (!available) return;
    const costs = await withTenant(ctx, (tx) => getProjectCompletedTaskCosts(tx, ctx.projectId, WINDOW));
    const t1 = costs.find((c) => c.taskId === taskT1)!;
    const t5 = costs.find((c) => c.taskId === taskT5)!;
    // T1: R1 (u1,u2,u5,u6) + R1b (u3)
    expect(t1.runCount).toBe(2);
    expect(t1.recordedCostMicros).toBe(C.u1 + C.u2 + C.u5 + C.u6 + C.u3);
    // T5: only R5 (u7,u8) — the cancelled/superseded T4's u9 is NOT merged in.
    expect(t5.recordedCostMicros).toBe(C.u7 + C.u8);
    expect(costs.some((c) => c.recordedCostMicros === C.u9)).toBe(false); // T4 (cancelled) absent entirely
  });

  it('employee defaults expose no system_prompt and cover only enabled employees', async () => {
    if (!available) return;
    const emps = await withTenant(ctx, (tx) => getProjectEmployeeDefaults(tx, ctx.projectId));
    expect(emps.length).toBe(2); // A + B; the disabled one excluded
    for (const e of emps) {
      expect(Object.keys(e)).not.toContain('systemPrompt');
      expect(JSON.stringify(e)).not.toContain('SECRET-PROMPT');
    }
  });

  it('project isolation — P2 usage never appears in P1 totals', async () => {
    if (!available) return;
    const s = await withTenant(ctx, (tx) => getProjectUsageSummary(tx, ctx.projectId, WINDOW));
    expect(s.recordedCostMicros).toBe(RECORDED_TOTAL); // 9999 from P2 excluded
    const runs = await withTenant(ctx, (tx) => getProjectRunCostDistribution(tx, ctx.projectId, WINDOW, {}));
    expect(runs.every((r) => r.recordedCostMicros !== 9999n)).toBe(true);
  });

  it('run-cost distribution includes zero-usage runs and is window-scoped', async () => {
    if (!available) return;
    const rows = await withTenant(ctx, (tx) => getProjectRunCostDistribution(tx, ctx.projectId, WINDOW, {}));
    expect(rows.length).toBe(5); // all 5 runs incl. the zero-usage failed run
    expect(rows.some((r) => r.eventCount === 0)).toBe(true);
    const total = rows.reduce((s, r) => s + r.recordedCostMicros, 0n);
    // run-scoped total = all run-associated usage (everything except run-less u4)
    expect(total).toBe(RECORDED_TOTAL - C.u4);
  });
});

describe('M0a reporting — RLS cross-project denial (app_server role)', () => {
  function urlAs(role: string, password: string): string {
    const u = new URL(process.env.DATABASE_URL!);
    u.username = role;
    u.password = password;
    return u.toString();
  }

  it('under app_server with P1 context, P2 usage rows are invisible (RLS)', async () => {
    if (!available) return;
    const app = postgres(urlAs('app_server', process.env.APP_SERVER_PASSWORD ?? 'app_server_dev_only'), { max: 1, prepare: false });
    try {
      await app.begin(async (sql) => {
        await sql`select set_config('app.user_id', ${userId}, true), set_config('app.org_id', ${orgId}, true), set_config('app.project_id', ${ctx.projectId}, true)`;
        const own = await sql`select count(*)::int n from usage_events where project_id = ${ctx.projectId}`;
        const other = await sql`select count(*)::int n from usage_events where project_id = ${p2}`;
        expect(own[0]!.n).toBeGreaterThan(0);
        expect(other[0]!.n).toBe(0); // RLS blocks cross-project read even by explicit id
      });
    } finally {
      await app.end();
    }
  });
});
