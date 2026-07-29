/**
 * HUB-009 Gate 3C resubmission — remaining server-side verification (items 2–5).
 * Self-contained (duplicates the small helpers from synth.ts) so synth.ts stays stable.
 * Everything is synthetic + non-billable; no real-workspace row is modified.
 */
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { withTenant } from '@/db/tenant';
import { createTask } from '@/domain/tasks/tasks';
import { setRecordClassification } from '@/domain/classification/classification';
import { setProviderOverrideForTests } from '@/providers/registry';
import { startRun } from '@/domain/tasks/runner';
import { recordUsage } from '@/domain/usage/usage';
import type { TenantContext, DataClassification } from '@/types/domain';
import type { AgentRequest, AgentResponse, AIProvider, ModelDescriptor, ProviderId } from '@/types/provider';

const KEYS = { live: 'hub009-live', demo: 'hub009-demo', seed: 'hub009-seed', agents: 'hub009-agents', snap: 'hub009-snap' } as const;
function admin() { return postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false }); }
function ctxFor(orgId: string, userId: string, projectId: string): TenantContext { return { userId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' }; }
async function parts(sql: ReturnType<typeof admin>) {
  const anchor = (await sql`select id, org_id from projects where key='accuratebids-com'`)[0] ?? (await sql`select id, org_id from projects order by created_at limit 1`)[0];
  const orgId = anchor!.org_id as string;
  const m = (await sql`select user_id from project_members where project_id=${anchor!.id} and role='admin' limit 1`)[0];
  return { orgId, userId: m!.user_id as string };
}
async function pid(sql: ReturnType<typeof admin>, orgId: string, key: string) { const r = (await sql`select id from projects where key=${key} and org_id=${orgId}`)[0]; return r ? (r.id as string) : null; }
class Fake implements AIProvider {
  readonly id: ProviderId; private q: string[];
  constructor(id: ProviderId, replies: string[]) { this.id = id; this.q = [...replies]; }
  async execute(r: AgentRequest): Promise<AgentResponse> { return { provider: this.id, model: r.model, text: this.q.shift() ?? 'ok', usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'stop', latencyMs: 1 }; }
  listModels(): readonly ModelDescriptor[] { return [{ id: 'fake', provider: this.id, displayName: 'Fake', maxOutputTokens: 4096 }]; }
}
function injectSingle(provider: ProviderId) { setProviderOverrideForTests((id) => (id === provider ? new Fake(provider, ['Primary draft.']) : undefined)); }

async function seedBareProject(sql: ReturnType<typeof admin>, orgId: string, userId: string, key: string, name: string) {
  await sql`delete from projects where key=${key} and org_id=${orgId}`;
  const p = (await sql`insert into projects (org_id, key, name) values (${orgId}, ${key}, ${name}) returning id`)[0]!.id as string;
  await sql`insert into project_members (org_id, project_id, user_id, role) values (${orgId}, ${p}, ${userId}, 'admin')`;
  await sql`insert into spend_limits (org_id, project_id, monthly_limit_micros) values (${orgId}, ${p}, 100000000)`;
  return p;
}
async function classify(ctx: TenantContext, entityType: string, entityId: string, to: DataClassification) {
  return withTenant(ctx, (tx) => setRecordClassification(tx, ctx, { entityType, entityId, to, reason: `HUB-009 Gate 3C ${entityType} → ${to}` }));
}

// ---- unarchive / rearchive the primary synthetic projects (approved non-destructive) ----
async function setArchived(value: boolean) {
  const sql = admin(); const { orgId } = await parts(sql);
  for (const key of [KEYS.live, KEYS.demo, KEYS.seed]) await sql`update projects set archived=${value} where key=${key} and org_id=${orgId}`;
  const rows = await sql`select key, archived from projects where key in (${KEYS.live}, ${KEYS.demo}, ${KEYS.seed}) and org_id=${orgId} order by key`;
  console.log(JSON.stringify({ archived: value, rows }, null, 2)); await sql.end();
}

// ---- synthetic legacy-null run + usage fixture (replica role bypasses the insert guard) ----
async function legacyfix() {
  const sql = admin(); const { orgId } = await parts(sql);
  const live = await pid(sql, orgId, KEYS.live); if (!live) throw new Error('run synth build first');
  const taskLive2 = (await sql`select id from tasks where project_id=${live} and title='Implement onboarding step 2' limit 1`)[0]!.id as string;
  // remove any prior fixture
  await sql`delete from runs where task_id=${taskLive2} and classification is null`;
  const out = await sql.begin(async (tx) => {
    await tx`set local session_replication_role = replica`; // disables the BEFORE-INSERT guard AND fk triggers
    const [tpl] = await tx`select * from runs where project_id=${live} and classification is not null order by created_at limit 1`;
    if (!tpl) throw new Error('need a completed synthetic run as template (run synth runs first)');
    const runId = randomUUID();
    await tx`insert into runs ${tx({ ...tpl, id: runId, task_id: taskLive2, classification: null })}`;
    const [utpl] = await tx`select * from usage_events where run_id=${tpl.id} limit 1`;
    if (utpl) await tx`insert into usage_events ${tx({ ...utpl, id: randomUUID(), run_id: runId, task_id: taskLive2, classification: null })}`;
    await tx`set local session_replication_role = origin`;
    return { runId };
  });
  const chk = (await sql`select classification from runs where id=${out.runId}`)[0];
  const uchk = await sql`select classification from usage_events where run_id=${out.runId}`;
  console.log(JSON.stringify({ legacyRunId: out.runId, runClassification: chk!.classification, usageClassifications: uchk.map((r) => r.classification), taskLive2 }, null, 2));
  await sql.end();
}

// ---- ITEM 2: usage-event trigger invariants (rolled back; synthetic rows only) ----
async function usagetrig() {
  const sql = admin(); const { orgId } = await parts(sql);
  const live = await pid(sql, orgId, KEYS.live);
  const nonNull = (await sql`select id, classification from usage_events where project_id=${live} and classification is not null order by created_at limit 1`)[0];
  const legacy = (await sql`select id from usage_events where project_id=${live} and classification is null order by created_at limit 1`)[0];
  const realNullBefore = (await sql`select count(*)::int as n from usage_events where classification is null`)[0]!.n;
  const results: Array<Record<string, unknown>> = [];
  const rec = (name: string, expected: string, outcome: string, detail?: string) => results.push({ name, expected, outcome, pass: expected === outcome, detail: detail ?? null });
  try {
    await sql.begin(async (tx) => {
      const attempt = async (name: string, expected: string, fn: (sp: typeof tx) => unknown) => {
        try { await tx.savepoint(async (sp) => { await fn(sp); }); rec(name, expected, 'ALLOWED'); }
        catch (e) { rec(name, expected, 'REJECTED', String((e as Error).message).slice(0, 120)); }
      };
      await attempt('non-null usage → different value', 'REJECTED', (sp) => sp`update usage_events set classification = case when classification='live' then 'demo'::data_classification else 'live'::data_classification end where id=${nonNull!.id}`);
      await attempt('non-null usage → null', 'REJECTED', (sp) => sp`update usage_events set classification = null where id=${nonNull!.id}`);
      if (legacy) {
        await attempt('legacy-null usage → value (backfill)', 'REJECTED', (sp) => sp`update usage_events set classification = 'live' where id=${legacy.id}`);
        await attempt('legacy-null usage → null (no-op) + other column', 'ALLOWED', (sp) => sp`update usage_events set classification = null, cost_micros = cost_micros where id=${legacy.id}`);
      }
      await attempt('non-null usage → SAME value (no-op)', 'ALLOWED', (sp) => sp`update usage_events set classification = classification where id=${nonNull!.id}`);
      throw new Error('__ROLLBACK__');
    });
  } catch (e) { if (String((e as Error).message) !== '__ROLLBACK__') throw e; }
  const legacyStillNull = legacy ? (await sql`select classification from usage_events where id=${legacy.id}`)[0]!.classification : 'no-fixture';
  const realNullAfter = (await sql`select count(*)::int as n from usage_events where classification is null`)[0]!.n;
  console.log(JSON.stringify({ allPass: results.every((r) => r.pass), results, legacyRowReadable: { classification: legacyStillNull }, realNullUsage: { before: realNullBefore, after: realNullAfter, unchanged: realNullBefore === realNullAfter } }, null, 2));
  await sql.end();
}

// ---- ITEM 3: snapshot-path creation cases ----
async function buildAgents() {
  const sql = admin(); const { orgId, userId } = await parts(sql);
  const p = await seedBareProject(sql, orgId, userId, KEYS.agents, 'HUB009 Agents (synthetic)');
  const demoAgent = (await sql`insert into agents (org_id, project_id, name, role, provider, model, system_prompt, temperature_milli, max_output_tokens) values (${orgId}, ${p}, 'Demo Primary', 'primary', 'openai', 'gpt-x', 'demo agent', 700, 4096) returning id`)[0]!.id as string;
  const seedAgent = (await sql`insert into agents (org_id, project_id, name, role, provider, model, system_prompt, temperature_milli, max_output_tokens) values (${orgId}, ${p}, 'Seed Primary', 'primary', 'anthropic', 'claude-x', 'seed agent', 700, 4096) returning id`)[0]!.id as string;
  const ctx = ctxFor(orgId, userId, p);
  const ids = await withTenant(ctx, async (tx) => ({
    taskA: await createTask(tx, ctx, { title: 'Live work performed by demo agent', input: 'x', providerSelection: 'openai', reviewEnabled: false }),
    taskB: await createTask(tx, ctx, { title: 'Live work performed by seed agent', input: 'x', providerSelection: 'anthropic', reviewEnabled: false }),
  }));
  await classify(ctx, 'agent', demoAgent, 'demo');
  await classify(ctx, 'agent', seedAgent, 'seed');
  console.log(JSON.stringify({ projectId: p, demoAgent, seedAgent, ...ids }, null, 2));
  await sql.end();
}

async function snappath() {
  const sql = admin(); const { orgId, userId } = await parts(sql);
  const out: Record<string, unknown> = {};

  // 1+2+3+4: demo/seed AGENT performing LIVE work → demo/seed activity; task stays live; agent class unchanged.
  const agents = await pid(sql, orgId, KEYS.agents); if (!agents) throw new Error('run buildAgents first');
  const actx = ctxFor(orgId, userId, agents);
  const taskA = (await sql`select id from tasks where project_id=${agents} and title='Live work performed by demo agent'`)[0]!.id as string;
  const taskB = (await sql`select id from tasks where project_id=${agents} and title='Live work performed by seed agent'`)[0]!.id as string;
  const demoAgent = (await sql`select id, classification from agents where project_id=${agents} and name='Demo Primary'`)[0]!;
  const seedAgent = (await sql`select id, classification from agents where project_id=${agents} and name='Seed Primary'`)[0]!;
  injectSingle('openai'); await startRun(actx, taskA); setProviderOverrideForTests(null);
  injectSingle('anthropic'); await startRun(actx, taskB); setProviderOverrideForTests(null);
  const runA = (await sql`select classification from runs where task_id=${taskA} order by created_at desc limit 1`)[0]!;
  const runB = (await sql`select classification from runs where task_id=${taskB} order by created_at desc limit 1`)[0]!;
  const taskAcls = (await sql`select classification from tasks where id=${taskA}`)[0]!.classification;
  const taskBcls = (await sql`select classification from tasks where id=${taskB}`)[0]!.classification;
  const demoAgentAfter = (await sql`select classification from agents where id=${demoAgent.id}`)[0]!.classification;
  const seedAgentAfter = (await sql`select classification from agents where id=${seedAgent.id}`)[0]!.classification;
  out.demoAgentOnLiveWork = { runClassification: runA.classification, taskStays: taskAcls, agentStoredBefore: demoAgent.classification, agentStoredAfter: demoAgentAfter };
  out.seedAgentOnLiveWork = { runClassification: runB.classification, taskStays: taskBcls, agentStoredBefore: seedAgent.classification, agentStoredAfter: seedAgentAfter };

  // 5: reclassify a parent AFTER run completion → run + usage snapshots unchanged (dedicated project).
  const snap = await seedBareProject(sql, orgId, userId, KEYS.snap, 'HUB009 Snap (synthetic)');
  await sql`insert into agents (org_id, project_id, name, role, provider, model, system_prompt, temperature_milli, max_output_tokens) values (${orgId}, ${snap}, 'Lead Engineer', 'primary', 'openai', 'gpt-x', 'p', 700, 4096)`;
  const sctx = ctxFor(orgId, userId, snap);
  const snapTask = await withTenant(sctx, (tx) => createTask(tx, sctx, { title: 'Snapshot immutability task', input: 'x', providerSelection: 'openai', reviewEnabled: false }));
  injectSingle('openai'); await startRun(sctx, snapTask); setProviderOverrideForTests(null);
  const beforeRun = (await sql`select id, classification from runs where task_id=${snapTask} order by created_at desc limit 1`)[0]!;
  await classify(sctx, 'task', snapTask, 'demo'); // reclassify parent AFTER the run
  const afterRun = (await sql`select classification from runs where id=${beforeRun.id}`)[0]!.classification;
  const afterUsage = await sql`select classification from usage_events where run_id=${beforeRun.id}`;
  out.reclassifyParentAfterRun = { taskNow: 'demo', runSnapshotBefore: beforeRun.classification, runSnapshotAfter: afterRun, usageSnapshotsAfter: afterUsage.map((r) => r.classification) };

  // 6: NEW usage attached to a synthetic legacy-null run → resolved non-null snapshot; legacy run stays null.
  const live = await pid(sql, orgId, KEYS.live);
  const legacyRun = (await sql`select id, task_id, classification from runs where project_id=${live} and classification is null order by created_at desc limit 1`)[0];
  if (legacyRun) {
    const lctx = ctxFor(orgId, userId, live!);
    await withTenant(lctx, (tx) => recordUsage(tx, lctx, { taskId: legacyRun.task_id as string, runId: legacyRun.id as string, runStepId: null, provider: 'openai', model: 'gpt-x', usage: { inputTokens: 1, outputTokens: 1 } }));
    const newUsage = (await sql`select classification from usage_events where run_id=${legacyRun.id} order by created_at desc limit 1`)[0]!.classification;
    const legacyRunAfter = (await sql`select classification from runs where id=${legacyRun.id}`)[0]!.classification;
    out.newUsageOnLegacyRun = { newUsageClassification: newUsage, legacyRunClassificationAfter: legacyRunAfter };
  } else out.newUsageOnLegacyRun = 'no legacy fixture — run legacyfix first';

  // 7: run-less usage snapshots the CURRENT PROJECT classification (demo project → demo; live project → live).
  const demo = await pid(sql, orgId, KEYS.demo);
  const dctx = ctxFor(orgId, userId, demo!);
  await withTenant(dctx, (tx) => recordUsage(tx, dctx, { taskId: null, runId: null, runStepId: null, provider: 'openai', model: 'gpt-x', usage: { inputTokens: 1, outputTokens: 1 } }));
  const runlessDemo = (await sql`select classification from usage_events where project_id=${demo} and run_id is null order by created_at desc limit 1`)[0]!.classification;
  const lctx2 = ctxFor(orgId, userId, live!);
  await withTenant(lctx2, (tx) => recordUsage(tx, lctx2, { taskId: null, runId: null, runStepId: null, provider: 'openai', model: 'gpt-x', usage: { inputTokens: 1, outputTokens: 1 } }));
  const runlessLive = (await sql`select classification from usage_events where project_id=${live} and run_id is null order by created_at desc limit 1`)[0]!.classification;
  out.runlessUsage = { inDemoProject: runlessDemo, inLiveProject: runlessLive };

  console.log(JSON.stringify(out, null, 2));
  await sql.end();
}

// ---- ITEM 4: dependency guard, full staging matrix ----
async function deps2() {
  const sql = admin(); const { orgId, userId } = await parts(sql);
  const { addDependency } = await import('@/domain/dependencies/dependencies');
  const { selectableTaskCandidates } = await import('@/domain/tasks/tasks');
  const { resolveRecordClassification, loadProjectClassification } = await import('@/domain/classification/classification');
  const live = await pid(sql, orgId, KEYS.live); const demo = await pid(sql, orgId, KEYS.demo);
  const ctx = ctxFor(orgId, userId, live!);
  const tid = async (title: string) => (await sql`select id from tasks where project_id=${live} and title=${title} limit 1`)[0]!.id as string;

  // Ensure an explicit-seed prerequisite exists in the live project.
  let seedPrereq = (await sql`select id from tasks where project_id=${live} and title='Seed prerequisite' limit 1`)[0]?.id as string | undefined;
  if (!seedPrereq) {
    seedPrereq = await withTenant(ctx, (tx) => createTask(tx, ctx, { title: 'Seed prerequisite', input: 'x', providerSelection: 'openai', reviewEnabled: false }));
    await classify(ctx, 'task', seedPrereq, 'seed');
  }
  const t1 = await tid('Implement onboarding step 1');
  const livePrereq = await tid('Live prerequisite');
  const demoPrereq = await tid('Demo prerequisite');
  const taskDemo = await tid('Rehearse the sales demo');
  const taskSeed = await tid('Fixture task from seed');

  const results: Array<Record<string, unknown>> = [];
  const attempt = async (name: string, expected: string, run: () => Promise<void>) => {
    try { await run(); results.push({ name, expected, outcome: 'ALLOWED', pass: expected === 'ALLOWED' }); }
    catch (e) { results.push({ name, expected, outcome: 'REJECTED', pass: expected === 'REJECTED', detail: String((e as Error).message).slice(0, 110) }); }
  };
  await attempt('live → explicit DEMO prerequisite', 'REJECTED', () => withTenant(ctx, (tx) => addDependency(tx, ctx, { dependentTaskId: t1, prerequisiteTaskId: demoPrereq })));
  await attempt('live → explicit SEED prerequisite', 'REJECTED', () => withTenant(ctx, (tx) => addDependency(tx, ctx, { dependentTaskId: t1, prerequisiteTaskId: seedPrereq! })));
  await attempt('manual submission of non-live prereq id (server-side)', 'REJECTED', () => withTenant(ctx, (tx) => addDependency(tx, ctx, { dependentTaskId: livePrereq, prerequisiteTaskId: demoPrereq })));
  await attempt('DEMO dependent → live prerequisite', 'ALLOWED', () => withTenant(ctx, (tx) => addDependency(tx, ctx, { dependentTaskId: taskDemo, prerequisiteTaskId: livePrereq })));
  await attempt('SEED dependent → live prerequisite', 'ALLOWED', () => withTenant(ctx, (tx) => addDependency(tx, ctx, { dependentTaskId: taskSeed, prerequisiteTaskId: livePrereq })));

  // Project-inheritance is honoured by the guard's effective-classification computation. Dependencies are
  // same-project (requireTask scopes to ctx.projectId), so a LIVE dependent + project-inherited-non-live
  // prerequisite is structurally unreachable; we assert the computation instead: a record-'live' task inside
  // the DEMO project resolves to effective 'demo'.
  const inherited = await withTenant(ctxFor(orgId, userId, demo!), async (tx) => {
    const projClass = await loadProjectClassification(tx, demo!);
    return resolveRecordClassification('live', projClass).classification;
  });

  // Pickers: a LIVE task's dependency + supersede candidate lists exclude demo/seed even under includeNonLive
  // (selectableTaskCandidates is record-classification based and always live-only).
  const liveTaskRows = (await sql`select id, classification from tasks where project_id=${live}`).map((r) => ({ id: r.id as string, classification: r.classification as DataClassification }));
  const depCandidates = selectableTaskCandidates(liveTaskRows, { excludeId: t1, excludeIds: new Set<string>() });
  const supCandidates = selectableTaskCandidates(liveTaskRows, { excludeId: taskDemo, excludeIds: new Set<string>() });
  const nonLiveInDep = depCandidates.filter((r) => r.classification !== 'live').length;
  const nonLiveInSup = supCandidates.filter((r) => r.classification !== 'live').length;

  console.log(JSON.stringify({
    allPass: results.every((r) => r.pass),
    results,
    projectInheritedEffectiveOfRecordLiveInDemoProject: inherited,
    dependencyPicker: { total: liveTaskRows.length, candidates: depCandidates.length, nonLivePresent: nonLiveInDep },
    supersedePicker: { candidates: supCandidates.length, nonLivePresent: nonLiveInSup },
  }, null, 2));
  await sql.end();
}

// ---- ITEM 5: audit reversal + no-op + search completeness + chain validity ----
async function audit2() {
  const sql = admin(); const { orgId, userId } = await parts(sql);
  const { searchAuditEvents } = await import('@/domain/audit/audit');
  const agents = await pid(sql, orgId, KEYS.agents); const live = await pid(sql, orgId, KEYS.live);
  const actx = ctxFor(orgId, userId, agents!);

  // Dedicated audit fixture (a decision — not shown on the work board) in the agents project.
  await sql`delete from decisions where project_id=${agents} and title='Audit reversal fixture'`;
  const dec = (await sql`insert into decisions (org_id, project_id, title, summary, author_label, status, scope) values (${orgId}, ${agents}, 'Audit reversal fixture', 's', 'Founder', 'accepted', 'workspace') returning id`)[0]!.id as string;

  const ev1 = await classify(actx, 'decision', dec, 'demo');   // live → demo
  const ev2 = await classify(actx, 'decision', dec, 'live');   // demo → live (reversal)
  const ev3 = await classify(actx, 'decision', dec, 'live');   // live → live (idempotent no-op)

  const events = await sql`select action, detail, created_at from audit_logs where entity_id=${dec} and action='record.classification_changed' order by created_at`;

  // Search completeness — no includeNonLive parameter exists; classification events for demo AND seed target
  // records are all returned in the LIVE workspace's audit search.
  const lctx = ctxFor(orgId, userId, live!);
  const search = await withTenant(lctx, (tx) => searchAuditEvents(tx, lctx, { action: 'record.classification_changed' as never }, { limit: 100 }));
  const targets = search.rows.map((r) => (r.detail as { to?: string; entityType?: string })?.to).filter(Boolean);
  const distinctTargets = [...new Set(targets)];

  // Chain validity — org-scoped, linked by prev_hash. Verify continuity over a recent window.
  const chainRows = await sql`select seq, prev_hash, row_hash from audit_logs where org_id=${orgId} order by seq desc limit 400`;
  const asc = [...chainRows].reverse();
  let breaks = 0; let checked = 0;
  for (let i = 1; i < asc.length; i++) { checked++; if (asc[i]!.prev_hash !== asc[i - 1]!.row_hash) breaks++; }

  console.log(JSON.stringify({
    reversal: {
      requests: [ev1, ev2, ev3],
      eventCount: events.length,
      transitions: events.map((e) => ({ from: (e.detail as { from?: string }).from, to: (e.detail as { to?: string }).to })),
      noopProducedNoEvent: ev3 === false && events.length === 2,
    },
    searchCompleteness: { totalMatch: search.totalCount, distinctTargetClasses: distinctTargets, includesDemo: distinctTargets.includes('demo'), includesSeed: distinctTargets.includes('seed') },
    chain: { windowChecked: checked, linkageBreaks: breaks, valid: breaks === 0 },
  }, null, 2));
  await sql.end();
}

// ---- fixture: a DEMO task contributing to the LIVE objective (for objective-detail non-live contribution) ----
async function linkdemo() {
  const sql = admin(); const { orgId, userId } = await parts(sql);
  const live = await pid(sql, orgId, KEYS.live); const ctx = ctxFor(orgId, userId, live!);
  const objLive = (await sql`select id from objectives where project_id=${live} and title='Ship the onboarding flow' limit 1`)[0]!.id as string;
  const existing = (await sql`select id from tasks where project_id=${live} and title='Demo contribution to onboarding' limit 1`)[0];
  const taskId = existing ? (existing.id as string) : await withTenant(ctx, (tx) => createTask(tx, ctx, { title: 'Demo contribution to onboarding', input: 'demo contribution', providerSelection: 'openai', reviewEnabled: false, objectiveId: objLive }));
  if (!existing) await classify(ctx, 'task', taskId, 'demo');
  console.log(JSON.stringify({ objLive, demoContributionTask: taskId }, null, 2));
  await sql.end();
}

const cmd = process.argv[2];
const map: Record<string, () => Promise<void>> = {
  unarchive: () => setArchived(false), rearchive: () => setArchived(true),
  legacyfix, usagetrig, buildAgents, snappath, deps2, audit2, linkdemo,
};
const fn = map[cmd ?? ''];
if (!fn) { console.error('unknown command', cmd); process.exit(2); }
fn().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
