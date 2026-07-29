/**
 * HUB-009 Gate 3C — synthetic staging dataset for classification verification.
 *
 * Creates THREE throwaway projects in the owner's org — a LIVE, a DEMO, and a SEED
 * project — populated with objectives / tasks / milestones / agents / decisions /
 * dependency candidates spanning every classification. Nothing here touches real
 * AccurateBids/empera business data, and no title carries a "[demo]" prefix (the
 * feature classifies via the stored marker, never by string matching).
 *
 * Project-level classification and record-level overrides are applied through the
 * AUDITED reversible operation `setRecordClassification` (not raw writes), so the
 * audit-verification step has real `record.classification_changed` events to check.
 *
 * Runs/usage are produced by the REAL `startRun` path with a fake provider injected
 * via the registry test seam — no external model call and no spend. Legacy-derived
 * provenance is demonstrated read-only on genuine pre-feature NULL runs (no history
 * is rewritten).
 *
 *   tsx --conditions=react-server synth.ts build     # projects + records + classifications + deps
 *   tsx --conditions=react-server synth.ts runs      # fake-provider startRun snapshots + legacy URL
 *   tsx --conditions=react-server synth.ts audit      # read the audit trail this produced
 *   tsx --conditions=react-server synth.ts cleanup    # archive the three projects (non-destructive)
 */
import postgres from 'postgres';
import { withTenant } from '@/db/tenant';
import { createObjective, setObjectiveStatus, addMilestone } from '@/domain/objectives/objectives';
import { createTask } from '@/domain/tasks/tasks';
import { addDependency } from '@/domain/dependencies/dependencies';
import { setRecordClassification } from '@/domain/classification/classification';
import { setProviderOverrideForTests } from '@/providers/registry';
import { startRun } from '@/domain/tasks/runner';
import type { TenantContext, DataClassification } from '@/types/domain';
import type { AgentRequest, AgentResponse, AIProvider, ModelDescriptor, ProviderId } from '@/types/provider';

const KEYS = { live: 'hub009-live', demo: 'hub009-demo', seed: 'hub009-seed' } as const;

class Fake implements AIProvider {
  readonly id: ProviderId;
  private q: string[];
  constructor(id: ProviderId, replies: string[]) { this.id = id; this.q = [...replies]; }
  async execute(r: AgentRequest): Promise<AgentResponse> {
    return { provider: this.id, model: r.model, text: this.q.shift() ?? 'ok', usage: { inputTokens: 10, outputTokens: 5 }, stopReason: 'stop', latencyMs: 1 };
  }
  listModels(): readonly ModelDescriptor[] { return [{ id: 'fake', provider: this.id, displayName: 'Fake', maxOutputTokens: 4096 }]; }
}
const REVIEWER_REVISE = `VERDICT: revise\n\nOne issue.\n\n\`\`\`review-issues\n[{"severity":"minor","summary":"Add a verification step","detail":"Add an explicit verification step before completion."}]\n\`\`\``;
function injectFake() {
  setProviderOverrideForTests((id) => (id === 'openai' ? new Fake('openai', ['Primary draft.', 'Revised draft with verification step.']) : id === 'anthropic' ? new Fake('anthropic', [REVIEWER_REVISE]) : undefined));
}

function admin() { return postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false }); }

async function ownerCtxParts(sql: ReturnType<typeof admin>) {
  // Reuse the same org + owner the real workspaces belong to, so the synthetic
  // projects appear in the authenticated owner UI.
  const anchor = (await sql`select id, org_id from projects where key='accuratebids-com'`)[0]
    ?? (await sql`select id, org_id from projects order by created_at limit 1`)[0];
  if (!anchor) throw new Error('no anchor project to resolve org/owner');
  const orgId = anchor.org_id as string;
  const m = (await sql`select user_id from project_members where project_id=${anchor.id} and role='admin' limit 1`)[0];
  if (!m) throw new Error('no admin user');
  return { orgId, userId: m.user_id as string };
}

async function seedProject(sql: ReturnType<typeof admin>, orgId: string, userId: string, key: string, name: string) {
  await sql`delete from projects where key=${key} and org_id=${orgId}`; // idempotent reseed
  const pid = (await sql`insert into projects (org_id, key, name) values (${orgId}, ${key}, ${name}) returning id`)[0]!.id as string;
  await sql`insert into project_members (org_id, project_id, user_id, role) values (${orgId}, ${pid}, ${userId}, 'admin')`;
  await sql`insert into spend_limits (org_id, project_id, monthly_limit_micros) values (${orgId}, ${pid}, 100000000)`;
  await sql`insert into agents (org_id, project_id, name, role, provider, model, system_prompt, temperature_milli, max_output_tokens) values (${orgId}, ${pid}, 'Lead Engineer', 'primary', 'openai', 'gpt-x', 'You are the primary engineer.', 700, 4096)`;
  await sql`insert into agents (org_id, project_id, name, role, provider, model, system_prompt, temperature_milli, max_output_tokens) values (${orgId}, ${pid}, 'Principal Reviewer', 'reviewer', 'anthropic', 'claude-x', 'You are the reviewer.', 500, 4096)`;
  return pid;
}

function ctxFor(orgId: string, userId: string, projectId: string): TenantContext {
  return { userId, orgId, projectId, orgRole: 'owner', projectRole: 'admin' };
}
async function classify(ctx: TenantContext, entityType: string, entityId: string, to: DataClassification) {
  return withTenant(ctx, (tx) => setRecordClassification(tx, ctx, { entityType, entityId, to, reason: `HUB-009 Gate 3C synthetic ${entityType} → ${to}` }));
}

async function build() {
  const sql = admin();
  const { orgId, userId } = await ownerCtxParts(sql);

  // ---- LIVE project: live baseline + record-level demo & seed overrides -----
  const livePid = await seedProject(sql, orgId, userId, KEYS.live, 'HUB009 Live (synthetic)');
  const liveCtx = ctxFor(orgId, userId, livePid);
  const ids: Record<string, string> = {};

  await withTenant(liveCtx, async (tx) => {
    ids.objLive = await createObjective(tx, liveCtx, { title: 'Ship the onboarding flow', description: 'Genuine live objective.', successCriteria: [{ label: 'Flow completed by 3 users', metric: 'users', target: 3, unit: 'users' }] });
    await setObjectiveStatus(tx, liveCtx, ids.objLive, 'active');
    ids.mLive = await addMilestone(tx, liveCtx, ids.objLive, { title: 'Design review passed' });

    ids.objDemo = await createObjective(tx, liveCtx, { title: 'Demo walkthrough objective', description: 'Objective used for demonstrations.', successCriteria: [{ label: 'Demo delivered', metric: 'demos', target: 1, unit: 'demos' }] });
    ids.mDemo = await addMilestone(tx, liveCtx, ids.objDemo, { title: 'Demo script drafted' });

    ids.objSeed = await createObjective(tx, liveCtx, { title: 'Seed fixture objective', description: 'Fixture objective from initial seed.', successCriteria: [] });

    ids.taskLive1 = await createTask(tx, liveCtx, { title: 'Implement onboarding step 1', input: 'Build the first onboarding step.', providerSelection: 'both', reviewEnabled: true, objectiveId: ids.objLive });
    ids.taskLive2 = await createTask(tx, liveCtx, { title: 'Implement onboarding step 2', input: 'Build the second onboarding step.', providerSelection: 'both', reviewEnabled: true, objectiveId: ids.objLive });
    ids.taskDemo = await createTask(tx, liveCtx, { title: 'Rehearse the sales demo', input: 'Prepare the demo walkthrough.', providerSelection: 'both', reviewEnabled: true, objectiveId: ids.objDemo });
    ids.taskSeed = await createTask(tx, liveCtx, { title: 'Fixture task from seed', input: 'Placeholder fixture task.', providerSelection: 'both', reviewEnabled: true });
    ids.taskLivePrereq = await createTask(tx, liveCtx, { title: 'Live prerequisite', input: 'A real prerequisite task.', providerSelection: 'openai', reviewEnabled: false });
    ids.taskDemoPrereq = await createTask(tx, liveCtx, { title: 'Demo prerequisite', input: 'A demonstration prerequisite.', providerSelection: 'openai', reviewEnabled: false });
  });

  // Agents + decisions (raw) in the live project.
  // Provider 'anthropic' + role 'primary' so run resolution (primary→openai, reviewer→anthropic-role-reviewer)
  // never selects this agent as a performer — it exists purely as a demo-classified agent fixture.
  ids.agentDemo = (await sql`insert into agents (org_id, project_id, name, role, provider, model, system_prompt, temperature_milli, max_output_tokens) values (${orgId}, ${livePid}, 'Demo Presenter', 'primary', 'anthropic', 'claude-x', 'You run demos.', 700, 4096) returning id`)[0]!.id as string;
  ids.decLive = (await sql`insert into decisions (org_id, project_id, title, summary, author_label, status, scope) values (${orgId}, ${livePid}, 'Adopt onboarding metrics', 'Real workspace decision.', 'Founder', 'accepted', 'workspace') returning id`)[0]!.id as string;
  ids.decDemo = (await sql`insert into decisions (org_id, project_id, title, summary, author_label, status, scope) values (${orgId}, ${livePid}, 'Demo talking points', 'Decision used in demonstrations.', 'Founder', 'accepted', 'workspace') returning id`)[0]!.id as string;

  // Record-level overrides via the audited op.
  await classify(liveCtx, 'objective', ids.objDemo, 'demo');
  await classify(liveCtx, 'objective', ids.objSeed, 'seed');
  await classify(liveCtx, 'task', ids.taskDemo, 'demo');
  await classify(liveCtx, 'task', ids.taskSeed, 'seed');
  await classify(liveCtx, 'task', ids.taskDemoPrereq, 'demo');
  await classify(liveCtx, 'agent', ids.agentDemo, 'demo');
  await classify(liveCtx, 'decision', ids.decDemo, 'demo');

  // Dependency candidates (guard tested in `deps`). Establish one valid live→live edge now.
  await withTenant(liveCtx, (tx) => addDependency(tx, liveCtx, { dependentTaskId: ids.taskLive1, prerequisiteTaskId: ids.taskLivePrereq }));

  // ---- DEMO project: project-level inheritance (records stay 'live' but are effectively demo) ----
  const demoPid = await seedProject(sql, orgId, userId, KEYS.demo, 'HUB009 Demo (synthetic)');
  const demoCtx = ctxFor(orgId, userId, demoPid);
  await withTenant(demoCtx, async (tx) => {
    ids.demoObj = await createObjective(tx, demoCtx, { title: 'Demo-project objective', description: 'Lives in a demo project.', successCriteria: [] });
    ids.demoTask = await createTask(tx, demoCtx, { title: 'Demo-project task', input: 'Work inside a demo project.', providerSelection: 'both', reviewEnabled: true, objectiveId: ids.demoObj });
  });
  await classify(demoCtx, 'project', demoPid, 'demo');

  // ---- SEED project ---------------------------------------------------------
  const seedPid = await seedProject(sql, orgId, userId, KEYS.seed, 'HUB009 Seed (synthetic)');
  const seedCtx = ctxFor(orgId, userId, seedPid);
  await withTenant(seedCtx, async (tx) => {
    ids.seedObj = await createObjective(tx, seedCtx, { title: 'Seed-project objective', description: 'Lives in a seed project.', successCriteria: [] });
    ids.seedTask = await createTask(tx, seedCtx, { title: 'Seed-project task', input: 'Work inside a seed project.', providerSelection: 'both', reviewEnabled: true, objectiveId: ids.seedObj });
  });
  await classify(seedCtx, 'project', seedPid, 'seed');

  ids.livePid = livePid; ids.demoPid = demoPid; ids.seedPid = seedPid;
  console.log(JSON.stringify({ ok: true, keys: KEYS, ids }, null, 2));
  await sql.end();
}

async function runOne(ctx: TenantContext, taskId: string, sql: ReturnType<typeof admin>, label: string) {
  injectFake();
  const outcome = await startRun(ctx, taskId);
  setProviderOverrideForTests(null);
  const run = (await sql`select id, classification from runs where task_id=${taskId} order by created_at desc limit 1`)[0];
  const usage = await sql`select classification, count(*)::int as n from usage_events where run_id=${run!.id} group by classification`;
  return { label, taskId, status: outcome.status, runId: run!.id, runClassification: run!.classification, usage };
}

async function runs() {
  const sql = admin();
  const { orgId, userId } = await ownerCtxParts(sql);
  const live = (await sql`select id from projects where key=${KEYS.live} and org_id=${orgId}`)[0]!.id as string;
  const demo = (await sql`select id from projects where key=${KEYS.demo} and org_id=${orgId}`)[0]!.id as string;
  const seed = (await sql`select id from projects where key=${KEYS.seed} and org_id=${orgId}`)[0]!.id as string;

  const t = async (pid: string, title: string) => (await sql`select id from tasks where project_id=${pid} and title=${title} limit 1`)[0]!.id as string;
  const results = [];
  results.push(await runOne(ctxFor(orgId, userId, live), await t(live, 'Implement onboarding step 1'), sql, 'live task in live project → expect live'));
  results.push(await runOne(ctxFor(orgId, userId, live), await t(live, 'Rehearse the sales demo'), sql, 'demo-record task in live project → expect demo'));
  results.push(await runOne(ctxFor(orgId, userId, demo), await t(demo, 'Demo-project task'), sql, 'task in demo project → expect demo'));
  results.push(await runOne(ctxFor(orgId, userId, seed), await t(seed, 'Seed-project task'), sql, 'task in seed project → expect seed'));

  // Legacy-derived provenance — a genuine pre-feature NULL run (read-only), for the UI check.
  const legacy = (await sql`
    select p.key, r.task_id, r.id as run_id from runs r
    join projects p on p.id = r.project_id
    where r.classification is null order by r.created_at desc limit 1`)[0];

  console.log(JSON.stringify({ results, legacyNullRun: legacy ?? null }, null, 2));
  await sql.end();
}

async function auditTrail() {
  const sql = admin();
  const { orgId } = await ownerCtxParts(sql);
  const pids = (await sql`select id, key from projects where key in (${KEYS.live}, ${KEYS.demo}, ${KEYS.seed}) and org_id=${orgId}`);
  const idList = pids.map((r) => r.id as string);
  const events = await sql`
    select project_id, action, entity_type, detail, prev_hash is not null as chained
    from audit_logs where project_id = any(${idList}) and action = 'record.classification_changed'
    order by created_at`;
  console.log(JSON.stringify({ projects: pids, classificationChangeEvents: events }, null, 2));
  await sql.end();
}

async function surfaces() {
  const sql = admin();
  const { orgId, userId } = await ownerCtxParts(sql);
  const { listExecution } = await import('@/domain/execution/execution');
  const { listObjectives, getObjective } = await import('@/domain/objectives/objectives');
  const { assessWorkspaceHealth } = await import('@/domain/health/health');
  const { employeeAttribution, employeeAttributionDrilldown } = await import('@/domain/agents/attribution');
  const { listAgents } = await import('@/domain/agents/agents');
  const { morningBriefing } = await import('@/domain/briefing/briefing');
  const { LIVE_ONLY } = await import('@/domain/classification/classification');
  const ON = { includeNonLive: true } as const;

  const live = (await sql`select id from projects where key=${KEYS.live} and org_id=${orgId}`)[0]!.id as string;
  const ctx = ctxFor(orgId, userId, live);
  const out: Record<string, unknown> = {};

  await withTenant(ctx, async (tx) => {
    // 1. WORK feed (listExecution) — live-only default vs included.
    const feedLive = await listExecution(tx, ctx, LIVE_ONLY);
    const feedOn = await listExecution(tx, ctx, ON);
    const clsOf = (rows: Array<{ classification?: string }>) => rows.reduce((m: Record<string, number>, r) => { const k = r.classification ?? 'live'; m[k] = (m[k] ?? 0) + 1; return m; }, {});
    out.work = { liveOnly: { count: feedLive.rows.length, byClass: clsOf(feedLive.rows), excluded: feedLive.excluded }, included: { count: feedOn.rows.length, byClass: clsOf(feedOn.rows) } };

    // 2. OBJECTIVES list — page filters all→live unless includeNonLive.
    const allObj = await listObjectives(tx, ctx);
    out.objectives = { total: allObj.length, byClass: clsOf(allObj), liveOnlyShown: allObj.filter((o) => o.classification === 'live').length };

    // 3. OBJECTIVE detail (live objective) — milestone present, live-only.
    const objLive = allObj.find((o) => o.classification === 'live');
    if (objLive) { const d = await getObjective(tx, ctx, objLive.id, LIVE_ONLY); out.objectiveDetail = { title: d.title, milestones: d.milestones.map((m) => m.title) }; }

    // 4. HEALTH — headline live-only by construction (takes no visibility).
    const h = await assessWorkspaceHealth(tx, ctx);
    out.health = { runsCompletedLive: h.execution.runsCompleted, runsCompletedDemo: h.execution.runsCompletedDemo, runsCompletedSeed: h.execution.runsCompletedSeed };

    // 5. ATTRIBUTION — headline live-only; demo/seed via per-class `only`; provenance via drilldown.
    const headline = await employeeAttribution(tx, ctx, LIVE_ONLY);
    const demoWork = await employeeAttribution(tx, ctx, ON, 'demo');
    const seedWork = await employeeAttribution(tx, ctx, ON, 'seed');
    const sum = (m: Map<string, { performedWork: number }>) => [...m.values()].reduce((n, v) => n + v.performedWork, 0);
    out.attribution = { headlinePerformedLive: sum(headline), demoPerformed: sum(demoWork), seedPerformed: sum(seedWork) };
    const agents = await listAgents(tx, ctx);
    const primary = agents.find((a) => a.name === 'Lead Engineer');
    if (primary) {
      const drillOn = await employeeAttributionDrilldown(tx, ctx, primary.id, ON);
      out.provenance = {
        performed: drillOn.performed.map((r) => ({ task: r.taskTitle, classification: r.classification, provenance: r.provenance })),
        reviewed: drillOn.reviewed.map((r) => ({ task: r.taskTitle, classification: r.classification, provenance: r.provenance })),
      };
    }
  });

  // 5b. LEGACY-DERIVED provenance — read-only on a real workspace with genuine pre-feature NULL runs.
  const abRow = (await sql`select p.id, p.org_id from projects p join runs r on r.project_id=p.id where r.classification is null and coalesce(p.archived,false)=false order by r.created_at desc limit 1`)[0];
  if (abRow) {
    const abCtx = ctxFor(abRow.org_id as string, userId, abRow.id as string);
    await withTenant(abCtx, async (tx) => {
      const { employeeAttributionDrilldown } = await import('@/domain/agents/attribution');
      const { listAgents } = await import('@/domain/agents/agents');
      const agents = await listAgents(tx, abCtx);
      let legacyExample: unknown = null; let legacyCount = 0;
      for (const a of agents) {
        const d = await employeeAttributionDrilldown(tx, abCtx, a.id, { includeNonLive: true });
        const legacy = [...d.performed, ...d.reviewed].filter((r) => r.provenance === 'legacy-derived');
        legacyCount += legacy.length;
        if (!legacyExample && legacy[0]) legacyExample = { task: legacy[0].taskTitle, classification: legacy[0].classification, provenance: legacy[0].provenance };
      }
      out.legacyDerivedProvenance = { workspaceRows: legacyCount, example: legacyExample };
    });
  }

  // 6. BRIEFING (briefWorkspace) for the LIVE project — headline live-only vs nonLive demo/seed separated.
  const { briefWorkspace } = await import('@/domain/briefing/briefing');
  const projectRecord = { projectId: live, orgId, key: KEYS.live, name: 'HUB009 Live (synthetic)', description: '', projectRole: 'admin' as const };
  try {
    const bLive = await briefWorkspace(ctx, projectRecord, LIVE_ONLY);
    const bOn = await briefWorkspace(ctx, projectRecord, ON);
    out.briefing = {
      headlineRunsCompleted_off: bLive.runsCompleted, headlineRunsCompleted_on: bOn.runsCompleted,
      nonLive_runsCompletedDemo: bOn.nonLive?.runsCompletedDemo, nonLive_runsCompletedSeed: bOn.nonLive?.runsCompletedSeed,
    };
  } catch (e) { out.briefing = { ERROR: String((e as Error).message).slice(0, 200) }; }

  console.log(JSON.stringify(out, null, 2));
  await sql.end();
}

async function deps() {
  const sql = admin();
  const { orgId, userId } = await ownerCtxParts(sql);
  const live = (await sql`select id from projects where key=${KEYS.live} and org_id=${orgId}`)[0]!.id as string;
  const ctx = ctxFor(orgId, userId, live);
  const id = async (title: string) => (await sql`select id from tasks where project_id=${live} and title=${title} limit 1`)[0]!.id as string;
  const t1 = await id('Implement onboarding step 1');
  const livePrereq = await id('Live prerequisite');
  const demoPrereq = await id('Demo prerequisite');
  const taskDemo = await id('Rehearse the sales demo');

  const cases: Array<{ name: string; expected: 'REJECTED' | 'ALLOWED'; run: () => Promise<void> }> = [
    { name: 'live task depends on DEMO task (guard)', expected: 'REJECTED', run: () => withTenant(ctx, (tx) => addDependency(tx, ctx, { dependentTaskId: t1, prerequisiteTaskId: demoPrereq })) },
    { name: 'DEMO task depends on live task (allowed)', expected: 'ALLOWED', run: () => withTenant(ctx, (tx) => addDependency(tx, ctx, { dependentTaskId: taskDemo, prerequisiteTaskId: livePrereq })) },
    { name: 'live task depends on live task (allowed, idempotent)', expected: 'ALLOWED', run: () => withTenant(ctx, (tx) => addDependency(tx, ctx, { dependentTaskId: t1, prerequisiteTaskId: livePrereq })) },
    { name: 'task depends on itself', expected: 'REJECTED', run: () => withTenant(ctx, (tx) => addDependency(tx, ctx, { dependentTaskId: t1, prerequisiteTaskId: t1 })) },
    { name: 'cycle (livePrereq → t1 when t1 → livePrereq exists)', expected: 'REJECTED', run: () => withTenant(ctx, (tx) => addDependency(tx, ctx, { dependentTaskId: livePrereq, prerequisiteTaskId: t1 })) },
  ];
  const results = [];
  for (const c of cases) {
    try { await c.run(); results.push({ name: c.name, expected: c.expected, outcome: 'ALLOWED', pass: c.expected === 'ALLOWED' }); }
    catch (e) { results.push({ name: c.name, expected: c.expected, outcome: 'REJECTED', pass: c.expected === 'REJECTED', detail: String((e as Error).message).slice(0, 120) }); }
  }
  console.log(JSON.stringify({ allPass: results.every((r) => r.pass), results }, null, 2));
  await sql.end();
}

async function legacyUrl() {
  const sql = admin();
  // A genuine pre-feature NULL run in a NON-archived workspace the owner can open.
  const row = (await sql`
    select p.key, r.task_id, r.id as run_id from runs r
    join projects p on p.id = r.project_id
    where r.classification is null and coalesce(p.archived, false) = false
    order by r.created_at desc limit 1`)[0];
  console.log(JSON.stringify({ legacyNullRunAccessible: row ?? null }, null, 2));
  await sql.end();
}

async function cleanup() {
  const sql = admin();
  const { orgId } = await ownerCtxParts(sql);
  const report = [];
  for (const key of Object.values(KEYS)) {
    const p = (await sql`select id, archived from projects where key=${key} and org_id=${orgId}`)[0];
    if (!p) { report.push({ key, state: 'absent' }); continue; }
    // Non-destructive: flip archived only. Count child rows BEFORE and AFTER to prove nothing is deleted.
    const before = (await sql`select
        (select count(*)::int from tasks where project_id=${p.id}) as tasks,
        (select count(*)::int from objectives where project_id=${p.id}) as objectives,
        (select count(*)::int from runs where project_id=${p.id}) as runs,
        (select count(*)::int from usage_events where project_id=${p.id}) as usage,
        (select count(*)::int from agents where project_id=${p.id}) as agents,
        (select count(*)::int from decisions where project_id=${p.id}) as decisions,
        (select count(*)::int from milestones where project_id=${p.id}) as milestones,
        (select count(*)::int from audit_logs where project_id=${p.id}) as audit`)[0];
    await sql`update projects set archived = true where id=${p.id}`;
    const after = (await sql`select
        (select count(*)::int from tasks where project_id=${p.id}) as tasks,
        (select count(*)::int from runs where project_id=${p.id}) as runs,
        (select count(*)::int from usage_events where project_id=${p.id}) as usage,
        (select count(*)::int from audit_logs where project_id=${p.id}) as audit`)[0];
    const archived = (await sql`select archived from projects where id=${p.id}`)[0]!.archived;
    report.push({ key, archived, before, after, dataPreserved: before.tasks === after.tasks && before.runs === after.runs && before.usage === after.usage && before.audit === after.audit });
  }
  console.log(JSON.stringify({ cleanup: report }, null, 2));
  await sql.end();
}

const cmd = process.argv[2] ?? 'build';
const fn = cmd === 'build' ? build : cmd === 'runs' ? runs : cmd === 'deps' ? deps : cmd === 'surfaces' ? surfaces : cmd === 'audit' ? auditTrail : cmd === 'legacy' ? legacyUrl : cmd === 'cleanup' ? cleanup : null;
if (!fn) { console.error('unknown command', cmd); process.exit(2); }
fn().then(() => process.exit(0)).catch((e) => { console.error('ERR', e); process.exit(1); });
