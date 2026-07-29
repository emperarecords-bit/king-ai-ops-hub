import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fixtureKey } from '@tests/support/fixture-key';
import { FakeProvider } from '@tests/support/fake-provider';
import { type TenantContext } from '@/types/domain';
import { getSetupDb } from '@/db/client';
import { agents, auditLogs, decisions, memberships, objectives, organizations, profiles, projectMembers, projects, runs, spendLimits, tasks, usageEvents, workItems } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { createObjective } from '@/domain/objectives/objectives';
import { setProviderOverrideForTests } from '@/providers/registry';
import { startRun } from '@/domain/tasks/runner';
import { recordUsage } from '@/domain/usage/usage';
import { resolveRunClassification, resolveUsageClassification, setRecordClassification } from '@/domain/classification/classification';

/** Insert a row with the classification-guard triggers bypassed, to SIMULATE a pre-feature (legacy) row —
 *  the only way a null snapshot can exist once migration 0052 is applied. Uses a superuser-only session
 *  setting inside its own transaction. */
async function insertLegacy(fn: (tx: Parameters<Parameters<ReturnType<typeof getSetupDb>['transaction']>[0]>[0]) => Promise<string>): Promise<string> {
  return getSetupDb().transaction(async (tx) => {
    await tx.execute(sql`set local session_replication_role = replica`);
    return fn(tx);
  });
}

/** Assert a DB operation rejects with a trigger RAISE whose text matches — drizzle wraps the Postgres error
 *  ("Failed query: …") so the RAISE message lives on `.cause`. */
async function expectDbError(p: Promise<unknown>, re: RegExp): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught, 'expected the operation to reject').toBeTruthy();
  const err = caught as { message?: string; cause?: { message?: string } };
  expect(`${err.message ?? ''} | ${err.cause?.message ?? ''}`).toMatch(re);
}

/** HUB-009 Gate 3A — classification schema, effective rules on real rows, snapshots, and the audited op. */

process.env.DATABASE_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? 'postgresql://king:king@localhost:5433/king_ai_hub';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? 'test-anthropic-key';
process.env.APP_ENCRYPTION_KEY = process.env.APP_ENCRYPTION_KEY ?? Buffer.alloc(32).toString('base64');

let available = false;
try {
  await getSetupDb().select({ one: profiles.id }).from(profiles).limit(1);
  available = true;
} catch (err) {
  console.warn(`[classification.test] SKIPPING — db not reachable: ${err instanceof Error ? err.message : err}`);
}

const db = getSetupDb();
let orgId = '';
let baseCtx: TenantContext;

async function freshProject(classification: 'live' | 'demo' | 'seed' = 'live'): Promise<TenantContext> {
  const pid = (await db.insert(projects).values({ orgId, key: fixtureKey('cls'), name: 'W', classification }).returning({ id: projects.id }))[0]!.id;
  await db.insert(projectMembers).values({ orgId, projectId: pid, userId: baseCtx.userId, role: 'admin' });
  await db.insert(spendLimits).values({ orgId, projectId: pid, monthlyLimitMicros: 100_000_000n });
  return { ...baseCtx, projectId: pid };
}
async function mkAgent(ctx: TenantContext, role: 'primary' | 'reviewer', provider: 'openai' | 'anthropic', classification: 'live' | 'demo' | 'seed' = 'live'): Promise<string> {
  return (await db.insert(agents).values({ orgId, projectId: ctx.projectId, name: `${role}-${randomUUID().slice(0, 6)}`, role, provider, model: 'm', systemPrompt: 'x', classification }).returning({ id: agents.id }))[0]!.id;
}
async function mkTask(ctx: TenantContext, classification: 'live' | 'demo' | 'seed' = 'live', extra: Record<string, unknown> = {}): Promise<string> {
  return (await db.insert(tasks).values({ orgId, projectId: ctx.projectId, title: 'T', input: 'do a thing', providerSelection: 'both', reviewEnabled: true, status: 'pending', createdBy: ctx.userId, classification, ...extra }).returning({ id: tasks.id }))[0]!.id;
}

beforeAll(async () => {
  if (!available) return;
  const userId = randomUUID();
  await db.insert(profiles).values({ id: userId, email: `cls-${randomUUID().slice(0, 8)}@t.local`, displayName: 'A' });
  orgId = (await db.insert(organizations).values({ name: 'O', slug: `cls-${randomUUID().slice(0, 8)}` }).returning({ id: organizations.id }))[0]!.id;
  await db.insert(memberships).values({ orgId, userId, role: 'owner' });
  baseCtx = { userId, orgId, projectId: '', orgRole: 'owner', projectRole: 'admin' };
});
afterAll(async () => { if (available) await getSetupDb().update(projects).set({ archived: true }).where(eq(projects.orgId, orgId)); });
afterEach(() => setProviderOverrideForTests(null));

describe.skipIf(!available)('HUB-009 durable classification defaults + persistence', () => {
  it('new durable records default to live; explicit demo/seed persist', async () => {
    const ctx = await freshProject('live');
    expect((await db.select({ c: projects.classification }).from(projects).where(eq(projects.id, ctx.projectId)))[0]!.c).toBe('live');
    const liveTask = await mkTask(ctx);
    expect((await db.select({ c: tasks.classification }).from(tasks).where(eq(tasks.id, liveTask)))[0]!.c).toBe('live');
    const demoTask = await mkTask(ctx, 'demo');
    expect((await db.select({ c: tasks.classification }).from(tasks).where(eq(tasks.id, demoTask)))[0]!.c).toBe('demo');
    const seedAgent = await mkAgent(ctx, 'primary', 'openai', 'seed');
    expect((await db.select({ c: agents.classification }).from(agents).where(eq(agents.id, seedAgent)))[0]!.c).toBe('seed');
    const objId = await withTenant(ctx, (tx) => createObjective(tx, ctx, { title: 'O', description: 'd', successCriteria: [{ label: 'c', metric: 'm', target: 1, unit: 'u' }] }));
    expect((await db.select({ c: objectives.classification }).from(objectives).where(eq(objectives.id, objId)))[0]!.c).toBe('live');
    const wi = (await db.insert(workItems).values({ orgId, projectId: ctx.projectId, title: 'wi', createdBy: ctx.userId }).returning({ id: workItems.id }))[0]!.id;
    expect((await db.select({ c: workItems.classification }).from(workItems).where(eq(workItems.id, wi)))[0]!.c).toBe('live');
    const dec = (await db.insert(decisions).values({ orgId, projectId: ctx.projectId, title: 'd', summary: 's', authorLabel: 'F', status: 'accepted', scope: 'workspace' }).returning({ id: decisions.id }))[0]!.id;
    expect((await db.select({ c: decisions.classification }).from(decisions).where(eq(decisions.id, dec)))[0]!.c).toBe('live');
  });
});

describe.skipIf(!available)('HUB-009 audited classification operation', () => {
  it('admin classify + reversal succeed and are audited; identical request is an idempotent no-op with no event', async () => {
    const ctx = await freshProject('live');
    const taskId = await mkTask(ctx, 'live');
    const evCount = async () => (await db.select({ id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.entityId, taskId), eq(auditLogs.action, 'record.classification_changed')))).length;

    const changed = await withTenant(ctx, (tx) => setRecordClassification(tx, ctx, { entityType: 'task', entityId: taskId, to: 'demo', reason: 'demonstration task' }));
    expect(changed).toBe(true);
    expect((await db.select({ c: tasks.classification }).from(tasks).where(eq(tasks.id, taskId)))[0]!.c).toBe('demo');
    const ev = (await db.select({ d: auditLogs.detail, actor: auditLogs.actorId, org: auditLogs.orgId, proj: auditLogs.projectId }).from(auditLogs).where(and(eq(auditLogs.entityId, taskId), eq(auditLogs.action, 'record.classification_changed'))))[0]!;
    const d = ev.d as Record<string, unknown>;
    expect(d).toMatchObject({ entityType: 'task', entityId: taskId, from: 'live', to: 'demo', reason: 'demonstration task' });
    expect(ev.actor).toBeTruthy();
    expect(ev.org).toBe(orgId);
    expect(ev.proj).toBe(ctx.projectId);
    expect(await evCount()).toBe(1);

    // reversal via the same op
    const reverted = await withTenant(ctx, (tx) => setRecordClassification(tx, ctx, { entityType: 'task', entityId: taskId, to: 'live', reason: 'revert' }));
    expect(reverted).toBe(true);
    expect((await db.select({ c: tasks.classification }).from(tasks).where(eq(tasks.id, taskId)))[0]!.c).toBe('live');
    expect(await evCount()).toBe(2);

    // idempotent no-op: already live → live
    const noop = await withTenant(ctx, (tx) => setRecordClassification(tx, ctx, { entityType: 'task', entityId: taskId, to: 'live', reason: 'noop' }));
    expect(noop).toBe(false);
    expect(await evCount()).toBe(2); // no new event
  });

  it('rejects non-admin, empty reason, non-allowlisted entity, and cross-workspace ids', async () => {
    const ctx = await freshProject('live');
    const taskId = await mkTask(ctx, 'live');
    const member = { ...ctx, projectRole: 'member' as const };
    await expect(withTenant(member, (tx) => setRecordClassification(tx, member, { entityType: 'task', entityId: taskId, to: 'demo', reason: 'x' }))).rejects.toThrow(/admin/i);
    await expect(withTenant(ctx, (tx) => setRecordClassification(tx, ctx, { entityType: 'task', entityId: taskId, to: 'demo', reason: '   ' }))).rejects.toThrow(/reason/i);
    await expect(withTenant(ctx, (tx) => setRecordClassification(tx, ctx, { entityType: 'run', entityId: taskId, to: 'demo', reason: 'x' }))).rejects.toThrow(/not classifiable/i);

    const otherCtx = await freshProject('live');
    const otherTask = await mkTask(otherCtx, 'live');
    // Classifying another workspace's task under ctx must reject (cross-workspace).
    await expect(withTenant(ctx, (tx) => setRecordClassification(tx, ctx, { entityType: 'task', entityId: otherTask, to: 'demo', reason: 'x' }))).rejects.toThrow(/not found/i);
    expect((await db.select({ c: tasks.classification }).from(tasks).where(eq(tasks.id, otherTask)))[0]!.c).toBe('live'); // untouched
  });
});

describe.skipIf(!available)('HUB-009 run + usage snapshots (created at dispatch, immutable)', () => {
  async function runFor(ctx: TenantContext, taskId: string): Promise<string> {
    await mkAgent(ctx, 'primary', 'openai');
    await mkAgent(ctx, 'reviewer', 'anthropic');
    setProviderOverrideForTests((id) => (id === 'openai' ? new FakeProvider('openai').reply('answer') : id === 'anthropic' ? new FakeProvider('anthropic').reply('VERDICT: approve\n\nok.') : undefined));
    const outcome = await startRun(ctx, taskId);
    expect(outcome.status).toBe('completed');
    return (await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, taskId)))[0]!.id;
  }

  it('a demo task in a live project (live agents) snapshots a demo run; the agent record stays live; the snapshot is immutable after the task is reclassified; usage inherits it', async () => {
    const ctx = await freshProject('live');
    const taskId = await mkTask(ctx, 'demo');
    const runId = await runFor(ctx, taskId);

    const run = (await db.select({ c: runs.classification }).from(runs).where(eq(runs.id, runId)))[0]!;
    expect(run.c).toBe('demo'); // resolved from the task at dispatch
    // The live performing agent is NOT reclassified.
    const primary = (await db.select({ c: agents.classification }).from(agents).where(and(eq(agents.projectId, ctx.projectId), eq(agents.role, 'primary'))))[0]!;
    expect(primary.c).toBe('live');
    // Usage events for the run inherit the run snapshot.
    const usage = await db.select({ c: usageEvents.classification }).from(usageEvents).where(eq(usageEvents.runId, runId));
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.c === 'demo')).toBe(true);

    // Reclassify the task back to live — the existing run + usage snapshots must NOT change.
    await withTenant(ctx, (tx) => setRecordClassification(tx, ctx, { entityType: 'task', entityId: taskId, to: 'live', reason: 'reclassify' }));
    expect((await db.select({ c: runs.classification }).from(runs).where(eq(runs.id, runId)))[0]!.c).toBe('demo');
    expect((await db.select({ c: usageEvents.classification }).from(usageEvents).where(eq(usageEvents.runId, runId))).every((u) => u.c === 'demo')).toBe(true);
  });

  it('a demo project dominates a live task → demo run snapshot', async () => {
    const ctx = await freshProject('demo');
    const taskId = await mkTask(ctx, 'live');
    const runId = await runFor(ctx, taskId);
    expect((await db.select({ c: runs.classification }).from(runs).where(eq(runs.id, runId)))[0]!.c).toBe('demo');
  });

  it('a run with a null snapshot resolves by legacy derivation, distinguishable from a snapshot', async () => {
    const ctx = await freshProject('live');
    const agentId = await mkAgent(ctx, 'primary', 'openai', 'demo');
    const taskId = await mkTask(ctx, 'live');
    const legacyRun = await insertLegacy((tx) => tx.insert(runs).values({ orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: agentId, classification: null }).returning({ id: runs.id }).then((r) => r[0]!.id));
    const row = (await db.select({ c: runs.classification }).from(runs).where(eq(runs.id, legacyRun)))[0]!;
    const eff = resolveRunClassification(row.c, { projectClassification: 'live', taskClassification: 'live', performerClassifications: ['demo'] });
    expect(eff).toEqual({ classification: 'demo', provenance: 'legacy-derived' }); // derived from the demo performer
  });
});

describe.skipIf(!available)('HUB-009 Gate 3A correction — DB snapshot enforcement (migration 0052)', () => {
  it('1. a new run cannot be inserted with a null classification', async () => {
    const ctx = await freshProject('live');
    const agentId = await mkAgent(ctx, 'primary', 'openai');
    const taskId = await mkTask(ctx, 'live');
    await expectDbError(db.insert(runs).values({ orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: agentId, classification: null }), /must be set on insert/i);
  });

  it('2. a non-null run classification cannot be changed; 3. legitimate status updates still succeed', async () => {
    const ctx = await freshProject('live');
    const agentId = await mkAgent(ctx, 'primary', 'openai');
    const taskId = await mkTask(ctx, 'live');
    const runId = (await db.insert(runs).values({ orgId, projectId: ctx.projectId, taskId, status: 'running', primaryAgentId: agentId, classification: 'demo' }).returning({ id: runs.id }))[0]!.id;
    await expectDbError(db.update(runs).set({ classification: 'live' }).where(eq(runs.id, runId)), /immutable/i);
    // A normal status/finished update that does NOT touch classification is allowed.
    await db.update(runs).set({ status: 'completed', finishedAt: new Date() }).where(eq(runs.id, runId));
    expect((await db.select({ s: runs.status, c: runs.classification }).from(runs).where(eq(runs.id, runId)))[0]).toEqual({ s: 'completed', c: 'demo' });
  });

  it('4. a historical null-classification run remains readable (legacy-derived)', async () => {
    const ctx = await freshProject('live');
    const agentId = await mkAgent(ctx, 'primary', 'openai', 'seed');
    const taskId = await mkTask(ctx, 'live');
    const legacyRun = await insertLegacy((tx) => tx.insert(runs).values({ orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: agentId, classification: null }).returning({ id: runs.id }).then((r) => r[0]!.id));
    const row = (await db.select({ c: runs.classification }).from(runs).where(eq(runs.id, legacyRun)))[0]!;
    expect(row.c).toBeNull();
    expect(resolveRunClassification(row.c, { projectClassification: 'live', taskClassification: 'live', performerClassifications: ['seed'] })).toEqual({ classification: 'seed', provenance: 'legacy-derived' });
  });

  it('5. usage linked to a snapshotted run copies the exact value', async () => {
    const ctx = await freshProject('live');
    const agentId = await mkAgent(ctx, 'primary', 'openai');
    const taskId = await mkTask(ctx, 'live');
    const runId = (await db.insert(runs).values({ orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: agentId, classification: 'demo' }).returning({ id: runs.id }))[0]!.id;
    await withTenant(ctx, (tx) => recordUsage(tx, ctx, { taskId, runId, runStepId: null, provider: 'openai', model: 'gpt-x', usage: { inputTokens: 1, outputTokens: 1 } }));
    expect((await db.select({ c: usageEvents.classification }).from(usageEvents).where(eq(usageEvents.runId, runId)))[0]!.c).toBe('demo');
  });

  it('6. usage linked to a legacy null-snapshot run resolves + stores the run\'s effective classification (run stays null)', async () => {
    const ctx = await freshProject('live');
    const agentId = await mkAgent(ctx, 'primary', 'openai', 'demo'); // demo performer
    const taskId = await mkTask(ctx, 'live');
    const legacyRun = await insertLegacy((tx) => tx.insert(runs).values({ orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: agentId, classification: null }).returning({ id: runs.id }).then((r) => r[0]!.id));
    await withTenant(ctx, (tx) => recordUsage(tx, ctx, { taskId, runId: legacyRun, runStepId: null, provider: 'openai', model: 'gpt-x', usage: { inputTokens: 1, outputTokens: 1 } }));
    expect((await db.select({ c: usageEvents.classification }).from(usageEvents).where(eq(usageEvents.runId, legacyRun)))[0]!.c).toBe('demo'); // resolved from the demo performer
    expect((await db.select({ c: runs.classification }).from(runs).where(eq(runs.id, legacyRun)))[0]!.c).toBeNull(); // run untouched
  });

  it('7. run-less usage snapshots the current project classification', async () => {
    const ctx = await freshProject('demo');
    await withTenant(ctx, (tx) => recordUsage(tx, ctx, { taskId: null, runId: null, runStepId: null, provider: 'openai', model: 'gpt-x', usage: { inputTokens: 1, outputTokens: 1 } }));
    const u = (await db.select({ c: usageEvents.classification }).from(usageEvents).where(and(eq(usageEvents.projectId, ctx.projectId), sql`${usageEvents.runId} is null`)))[0]!;
    expect(u.c).toBe('demo');
  });

  it('8. a new usage event cannot be inserted with a null classification; 9. its classification is immutable', async () => {
    const ctx = await freshProject('live');
    await expectDbError(db.insert(usageEvents).values({ orgId, projectId: ctx.projectId, taskId: null, runId: null, runStepId: null, provider: 'openai', model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 0n, pricingVersion: 'v', classification: null }), /must be set on insert/i);
    const uid = (await db.insert(usageEvents).values({ orgId, projectId: ctx.projectId, taskId: null, runId: null, runStepId: null, provider: 'openai', model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 0n, pricingVersion: 'v', classification: 'demo' }).returning({ id: usageEvents.id }))[0]!.id;
    await expectDbError(db.update(usageEvents).set({ classification: 'live' }).where(eq(usageEvents.id, uid)), /immutable/i);
  });

  it('10. a historical null usage event remains readable as legacy-derived', async () => {
    const ctx = await freshProject('seed');
    const uid = await insertLegacy((tx) => tx.insert(usageEvents).values({ orgId, projectId: ctx.projectId, taskId: null, runId: null, runStepId: null, provider: 'openai', model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 0n, pricingVersion: 'v', classification: null }).returning({ id: usageEvents.id }).then((r) => r[0]!.id));
    const row = (await db.select({ c: usageEvents.classification }).from(usageEvents).where(eq(usageEvents.id, uid)))[0]!;
    expect(row.c).toBeNull();
    expect(resolveUsageClassification(row.c, { projectClassification: 'seed' })).toEqual({ classification: 'seed', provenance: 'legacy-derived' });
  });

  it('11. legacy resolution is workspace-scoped — a demo record in another workspace never leaks in', async () => {
    const ctx = await freshProject('live'); // live workspace, live parents
    const agentId = await mkAgent(ctx, 'primary', 'openai', 'live');
    const taskId = await mkTask(ctx, 'live');
    const legacyRun = await insertLegacy((tx) => tx.insert(runs).values({ orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: agentId, classification: null }).returning({ id: runs.id }).then((r) => r[0]!.id));
    // A different workspace full of demo/seed data must not influence this resolution.
    const otherCtx = await freshProject('demo');
    await mkAgent(otherCtx, 'primary', 'openai', 'seed');
    await withTenant(ctx, (tx) => recordUsage(tx, ctx, { taskId, runId: legacyRun, runStepId: null, provider: 'openai', model: 'gpt-x', usage: { inputTokens: 1, outputTokens: 1 } }));
    expect((await db.select({ c: usageEvents.classification }).from(usageEvents).where(eq(usageEvents.runId, legacyRun)))[0]!.c).toBe('live'); // only this workspace's (live) parents counted
  });
});

describe.skipIf(!available)('HUB-009 Gate 3A correction #2 — full snapshot immutability (no historical backfill)', () => {
  it('a legacy null-classification run REJECTS null → live (no backfill), yet permits an unrelated status update (staying null)', async () => {
    const ctx = await freshProject('live');
    const agentId = await mkAgent(ctx, 'primary', 'openai');
    const taskId = await mkTask(ctx, 'live');
    const legacyRun = await insertLegacy((tx) => tx.insert(runs).values({ orgId, projectId: ctx.projectId, taskId, status: 'running', primaryAgentId: agentId, classification: null }).returning({ id: runs.id }).then((r) => r[0]!.id));
    // null → live is a forbidden backfill (assertion runs under the LIVE update trigger, no bypass).
    await expectDbError(db.update(runs).set({ classification: 'live' }).where(eq(runs.id, legacyRun)), /immutable/i);
    // An unrelated status update leaves classification null and succeeds (NULL → NULL is allowed).
    await db.update(runs).set({ status: 'completed', finishedAt: new Date() }).where(eq(runs.id, legacyRun));
    expect((await db.select({ s: runs.status, c: runs.classification }).from(runs).where(eq(runs.id, legacyRun)))[0]).toEqual({ s: 'completed', c: null });
  });

  it('a legacy null-classification usage event REJECTS null → live and remains readable as legacy-derived', async () => {
    const ctx = await freshProject('seed');
    const uid = await insertLegacy((tx) => tx.insert(usageEvents).values({ orgId, projectId: ctx.projectId, taskId: null, runId: null, runStepId: null, provider: 'openai', model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 0n, pricingVersion: 'v', classification: null }).returning({ id: usageEvents.id }).then((r) => r[0]!.id));
    await expectDbError(db.update(usageEvents).set({ classification: 'live' }).where(eq(usageEvents.id, uid)), /immutable/i);
    const row = (await db.select({ c: usageEvents.classification }).from(usageEvents).where(eq(usageEvents.id, uid)))[0]!;
    expect(row.c).toBeNull();
    expect(resolveUsageClassification(row.c, { projectClassification: 'seed' })).toEqual({ classification: 'seed', provenance: 'legacy-derived' });
  });

  it('a non-null run classification rejects EVERY transition — including to null and to another non-live value', async () => {
    const ctx = await freshProject('live');
    const agentId = await mkAgent(ctx, 'primary', 'openai');
    const taskId = await mkTask(ctx, 'live');
    const runId = (await db.insert(runs).values({ orgId, projectId: ctx.projectId, taskId, status: 'completed', primaryAgentId: agentId, classification: 'demo' }).returning({ id: runs.id }))[0]!.id;
    await expectDbError(db.update(runs).set({ classification: null }).where(eq(runs.id, runId)), /immutable/i);   // demo → null
    await expectDbError(db.update(runs).set({ classification: 'seed' }).where(eq(runs.id, runId)), /immutable/i);  // demo → seed
    await expectDbError(db.update(runs).set({ classification: 'live' }).where(eq(runs.id, runId)), /immutable/i);  // demo → live
    // same-value update alongside another column succeeds (demo → demo).
    await db.update(runs).set({ classification: 'demo', status: 'failed' }).where(eq(runs.id, runId));
    expect((await db.select({ s: runs.status, c: runs.classification }).from(runs).where(eq(runs.id, runId)))[0]).toEqual({ s: 'failed', c: 'demo' });
  });

  it('a non-null usage classification rejects transition to null and to another value; same-value + other-field update succeeds', async () => {
    const ctx = await freshProject('live');
    const uid = (await db.insert(usageEvents).values({ orgId, projectId: ctx.projectId, taskId: null, runId: null, runStepId: null, provider: 'openai', model: 'm', inputTokens: 1, outputTokens: 1, costMicros: 0n, pricingVersion: 'v', classification: 'seed' }).returning({ id: usageEvents.id }))[0]!.id;
    await expectDbError(db.update(usageEvents).set({ classification: null }).where(eq(usageEvents.id, uid)), /immutable/i);   // seed → null
    await expectDbError(db.update(usageEvents).set({ classification: 'demo' }).where(eq(usageEvents.id, uid)), /immutable/i);  // seed → demo
    await db.update(usageEvents).set({ classification: 'seed', model: 'm2' }).where(eq(usageEvents.id, uid)); // seed → seed + other field
    expect((await db.select({ m: usageEvents.model, c: usageEvents.classification }).from(usageEvents).where(eq(usageEvents.id, uid)))[0]).toEqual({ m: 'm2', c: 'seed' });
  });
});
