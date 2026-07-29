import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { agents, approvals, memberships, milestones, organizations, profiles, projectMembers, projects, spendLimits, tasks, usageEvents } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { createObjective, setCriterionStatus, setObjectiveStatus, setObjectiveOwner } from '@/domain/objectives/objectives';
import { assessWorkspaceHealth, briefingSummary, outcomeLine, overallFrom, type HealthFinding } from '@/domain/health/health';

/** HUB-007 — truthful, dimension-separated workspace health. Activity is never presented as outcome. */

process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[health.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let ctx: TenantContext;

async function freshProject(): Promise<TenantContext> {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('he'), name: 'W' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: ctx.userId, role: 'admin' });
  return { ...ctx, projectId: pid };
}

beforeAll(async () => {
  if (!available) return;
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `he-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `he-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('he'), name: 'W' }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId, role: 'admin' });
  ctx = { userId, orgId, projectId: pid, orgRole: 'owner', projectRole: 'admin' };
});

afterAll(async () => {
  if (!available) return;
  await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId));
});

/** An active objective with one numeric criterion and two completed tasks. */
async function activePilot(c: TenantContext, withOwner: boolean): Promise<string> {
  const objId = await withTenant(c, (tx) =>
    createObjective(tx, c, { title: 'Activate first 3 pilot contractors', description: '', successCriteria: [{ label: 'Contractors sending a real quote', metric: 'contractors', target: 3, unit: 'contractors' }] }),
  );
  await withTenant(c, (tx) => setObjectiveStatus(tx, c, objId, 'active'));
  if (withOwner) {
    const a = (await db.insert(agents).values({ orgId, projectId: c.projectId, name: 'Owner', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'x' }).returning({ id: agents.id }))[0]!.id;
    await withTenant(c, (tx) => setObjectiveOwner(tx, c, objId, a));
  }
  for (const t of ['Create first-3 pilot activation plan', 'Draft pilot qualification and outreach kit']) {
    await db.insert(tasks).values({ orgId, projectId: c.projectId, title: t, input: 'x', providerSelection: 'openai', status: 'completed', createdBy: c.userId, objectiveId: objId });
  }
  await db.insert(milestones).values({ orgId, projectId: c.projectId, objectiveId: objId, title: 'First qualified pilot contractor agrees to begin onboarding', status: 'active', position: 0 });
  return objId;
}
const health = (c: TenantContext) => withTenant(c, (tx) => assessWorkspaceHealth(tx, c));

describe('HUB-007 overallFrom precedence (pure)', () => {
  const f = (o: Partial<HealthFinding>): HealthFinding => ({ code: 'x', dimension: 'outcome', severity: 'warning', entityType: null, entityId: null, title: '', evidence: '', recommendedAction: '', blocksOperation: false, ...o });
  it('no findings → healthy', () => expect(overallFrom([])).toBe('healthy'));
  it('a warning (incl. outcome) → operational_with_warnings, never healthy', () =>
    expect(overallFrom([f({ dimension: 'outcome', severity: 'warning' })])).toBe('operational_with_warnings'));
  it('an execution error → needs_attention', () =>
    expect(overallFrom([f({ dimension: 'execution', severity: 'error' })])).toBe('needs_attention'));
  it('a blocking finding → blocked', () =>
    expect(overallFrom([f({ dimension: 'execution', severity: 'error', blocksOperation: true })])).toBe('blocked'));
  it('a workflow-integrity/governance error → data_integrity_issue (overrides all)', () => {
    expect(overallFrom([f({ dimension: 'workflow_integrity', severity: 'error' })])).toBe('data_integrity_issue');
    expect(overallFrom([f({ dimension: 'workflow_integrity', severity: 'error', blocksOperation: true }), f({ dimension: 'execution', severity: 'error' })])).toBe('data_integrity_issue');
  });
});

describe.skipIf(!available)('HUB-007 assessWorkspaceHealth (seeded)', () => {
  it('completed tasks do NOT complete the objective: 2/2 tasks are separate from 0/1 outcome criteria (0/3 target)', async () => {
    const c = await freshProject();
    await activePilot(c, true);
    const h = await health(c);
    const o = h.activeObjective!;
    expect(o.status).toBe('active'); // NOT completed despite 2/2 tasks
    expect(o.contributingTasksCompleted).toBe(2);
    expect(o.contributingTasksTotal).toBe(2);
    expect(o.outcomeCriteriaMet).toBe(0);
    expect(o.outcomeCriteriaTotal).toBe(1);
    expect(o.criteria[0]!.target).toBe(3);
    expect(o.criteria[0]!.unit).toBe('contractors');
    expect(o.criteria[0]!.met).toBe(false); // → 0 of 3 contractors
    expect(o.milestonesActive).toBe(1);
    expect(o.hasVerifiedOutcomeEvidence).toBe(false);
  });

  it('completed tasks + no outcome evidence → outcome warning; overall operational_with_warnings, NOT healthy', async () => {
    const c = await freshProject();
    await activePilot(c, true);
    const h = await health(c);
    expect(h.overall).toBe('operational_with_warnings');
    expect(h.findings.some((x) => x.code === 'outcome_evidence_missing' && x.dimension === 'outcome')).toBe(true);
    expect(h.dimensions.execution).toBe('ok'); // no failed runs
  });

  it('the briefing summary derives from the SAME structured health (never a bare %)', async () => {
    const c = await freshProject();
    await activePilot(c, true);
    const h = await health(c);
    const s = briefingSummary(h, 'AccurateBids.com');
    expect(s.headline).toBe('AccurateBids.com is operational, with warnings.');
    expect(s.outcome).toContain('2 of 2 completed');
    expect(s.outcome).toContain('0 of 1 met');
    expect(s.outcome).toContain('0 of 3 contractors');
    // No standalone unlabeled percentage anywhere in the outcome line.
    expect(/\b\d+%/.test(outcomeLine(h.activeObjective!))).toBe(false);
  });

  it('all criteria met + no other findings → healthy', async () => {
    const c = await freshProject();
    const objId = await activePilot(c, true);
    await withTenant(c, (tx) => setCriterionStatus(tx, c, objId, 0, 'met'));
    const h = await health(c);
    expect(h.activeObjective!.outcomeCriteriaMet).toBe(1);
    expect(h.findings.some((x) => x.code === 'outcome_evidence_missing')).toBe(false);
    expect(h.overall).toBe('healthy');
  });

  it('a failed task → run_failure (needs_attention)', async () => {
    const c = await freshProject();
    const objId = await activePilot(c, true);
    await withTenant(c, (tx) => setCriterionStatus(tx, c, objId, 0, 'met')); // isolate the execution finding
    await db.insert(tasks).values({ orgId, projectId: c.projectId, title: 'boom', input: 'x', providerSelection: 'openai', status: 'failed', createdBy: c.userId });
    const h = await health(c);
    expect(h.findings.some((x) => x.code === 'run_failure')).toBe(true);
    expect(h.overall).toBe('needs_attention');
  });

  it('budget exhausted → blocked', async () => {
    const c = await freshProject();
    const objId = await activePilot(c, true);
    await withTenant(c, (tx) => setCriterionStatus(tx, c, objId, 0, 'met'));
    await db.insert(spendLimits).values({ orgId, projectId: c.projectId, monthlyLimitMicros: 100n });
    await db.insert(usageEvents).values({ classification: 'live', orgId, projectId: c.projectId, provider: 'openai', model: 'gpt-x', inputTokens: 1, outputTokens: 1, costMicros: 500n, pricingVersion: 'v1' });
    const h = await health(c);
    expect(h.findings.some((x) => x.code === 'budget_exhausted' && x.blocksOperation)).toBe(true);
    expect(h.overall).toBe('blocked');
  });

  it('objective_missing_owner appears, then DISAPPEARS after an owner is assigned (resolved findings vanish)', async () => {
    const c = await freshProject();
    const objId = await activePilot(c, false); // no owner
    await withTenant(c, (tx) => setCriterionStatus(tx, c, objId, 0, 'met')); // remove outcome finding
    let h = await health(c);
    expect(h.findings.some((x) => x.code === 'objective_missing_owner')).toBe(true);
    const a = (await db.insert(agents).values({ orgId, projectId: c.projectId, name: 'Owner', role: 'primary', provider: 'openai', model: 'gpt-x', systemPrompt: 'x' }).returning({ id: agents.id }))[0]!.id;
    await withTenant(c, (tx) => setObjectiveOwner(tx, c, objId, a));
    h = await health(c);
    expect(h.findings.some((x) => x.code === 'objective_missing_owner')).toBe(false);
  });

  it('an authorized-but-unexecuted action UNRELATED to the active objective is info and does not dominate', async () => {
    const c = await freshProject();
    const objId = await activePilot(c, true);
    await withTenant(c, (tx) => setCriterionStatus(tx, c, objId, 0, 'met')); // no outcome finding
    // A completed task tied to NO active objective, with an approved (authorized) approval.
    const t = (await db.insert(tasks).values({ orgId, projectId: c.projectId, title: 'Pilot launch', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: c.userId }).returning({ id: tasks.id }))[0]!.id;
    await db.insert(approvals).values({ orgId, projectId: c.projectId, taskId: t, actionType: 'file_write', payload: {}, payloadSha256: 'x', summary: 's', status: 'approved', expiresAt: new Date('2027-01-01T00:00:00Z') });
    const h = await health(c);
    const finding = h.findings.find((x) => x.code === 'authorized_action_unexecuted')!;
    expect(finding.severity).toBe('info'); // unrelated → info, non-blocking, does not force needs_attention
    expect(finding.blocksOperation).toBe(false);
    expect(h.overall).toBe('operational_with_warnings'); // info only, not needs_attention/blocked
  });

  it('a historical-valid closed-objective task link creates NO warning', async () => {
    const c = await freshProject();
    const objId = await activePilot(c, true);
    await withTenant(c, (tx) => setCriterionStatus(tx, c, objId, 0, 'met'));
    // A completed task tied to a CANCELLED objective — historical_valid, must not warn.
    const cancelled = await withTenant(c, (tx) => createObjective(tx, c, { title: 'Old goal', description: '', successCriteria: [{ label: 'x', metric: 'm', target: 1, unit: '' }] }));
    await withTenant(c, (tx) => setObjectiveStatus(tx, c, cancelled, 'cancelled', 'pivoted'));
    await db.insert(tasks).values({ orgId, projectId: c.projectId, title: 'done long ago', input: 'x', providerSelection: 'openai', status: 'completed', createdBy: c.userId, objectiveId: cancelled });
    const h = await health(c);
    expect(h.findings.some((x) => x.code === 'objective_link_error')).toBe(false);
    expect(h.overall).toBe('healthy'); // no warnings from historical-valid links
  });

  it('deterministic: identical state yields identical overall + findings', async () => {
    const c = await freshProject();
    await activePilot(c, true);
    const a = await health(c);
    const b = await health(c);
    expect(b.overall).toBe(a.overall);
    expect(b.findings.map((x) => x.code).sort()).toEqual(a.findings.map((x) => x.code).sort());
  });

  it('workspace isolation — another workspace’s state does not affect this one', async () => {
    const c1 = await freshProject();
    const c2 = await freshProject();
    await activePilot(c2, true);
    const h1 = await health(c1);
    // c1 has no objectives → outcome_unassessable info, but no leakage of c2's objective.
    expect(h1.activeObjective).toBeNull();
  });
});
