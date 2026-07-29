/**
 * HUB-009 Gate 4 — STRICTLY READ-ONLY verification of the real AccurateBids workspace
 * and the named disposition candidates. This script only SELECTs. It performs NO write,
 * NO transaction-with-write, NO savepoint, NO classification call. Projections are computed
 * purely in memory over fetched rows using the production classification helpers.
 */
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { tasks, agents, runs } from '@/db/schema';
import { resolveRecordClassification } from '@/domain/classification/classification';

const sql = postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false });

const PROJECT = 'afa97b1c-7397-4d1d-9a95-99d0c19c7a96';
const TASKS = [
  '26a6cfb5-acdd-4f15-a703-1d23e81f828a',
  '101f80b6-7cb6-47a2-9bf1-f4b8ea2adafe',
  '722cfb4f-5552-4651-b3d9-b86549d17533',
  'f8e56488-8a6c-4a05-9ee6-f79feb6b7335',
];
const ARCHIVED_PROJECT = '0db8a4a3-2eef-42c8-85e0-7e4badbe0fb4';

async function inventory() {
  const out: Record<string, unknown> = {};

  // Project identity + classification.
  const proj = (await sql`select id, key, name, classification, coalesce(archived,false) as archived from projects where id=${PROJECT}`)[0];
  out.project = proj ?? null;
  const projClass = (proj?.classification as 'live' | 'demo' | 'seed') ?? 'live';

  const archProj = (await sql`select id, key, name, classification, coalesce(archived,false) as archived from projects where id=${ARCHIVED_PROJECT}`)[0];
  out.archivedProject = archProj ?? null;

  const tasks = [];
  for (const id of TASKS) {
    const t = (await sql`select id, title, classification, status, objective_id, project_id from tasks where id=${id}`)[0];
    if (!t) { tasks.push({ id, MISSING: true }); continue; }
    const eff = resolveRecordClassification(t.classification as 'live' | 'demo' | 'seed', projClass);
    const runs = await sql`select id, classification, status, created_at from runs where task_id=${id} order by created_at`;
    const runIds = runs.map((r) => r.id as string);
    const stepCount = runIds.length ? (await sql`select count(*)::int as n from run_steps where run_id = any(${runIds})`)[0]!.n : 0;
    const msgCount = (await sql`select count(*)::int as n from messages where task_id=${id}`)[0]!.n;
    const usage = await sql`select classification, count(*)::int as n, coalesce(sum(cost_micros),0)::bigint as micros from usage_events where task_id=${id} or run_id = any(${runIds.length ? runIds : ['00000000-0000-0000-0000-000000000000']}) group by classification`;
    const deps = await sql`select prerequisite_task_id, dependent_task_id, kind from task_dependencies where prerequisite_task_id=${id} or dependent_task_id=${id}`;
    const objective = t.objective_id ? (await sql`select id, title, status, classification from objectives where id=${t.objective_id}`)[0] : null;
    const auditEvents = await sql`select action, detail, created_at from audit_logs where entity_id=${id} and action='record.classification_changed' order by created_at`;
    // Decision relationships: decisions originating from / scoped to this task or its runs.
    const runFilter = runIds.length ? runIds : ['00000000-0000-0000-0000-000000000000'];
    const decisions = await sql`select id, title, status, classification,
        (originating_task_id=${id}) as originating_task, (scope_task_id=${id}) as scope_task,
        (originating_run_id = any(${runFilter})) as originating_run, (suggested_by_run_id = any(${runFilter})) as suggested_run
      from decisions where originating_task_id=${id} or scope_task_id=${id} or originating_run_id = any(${runFilter}) or suggested_by_run_id = any(${runFilter})`;
    tasks.push({
      id, title: t.title, storedClassification: t.classification, effectiveClassification: eff.classification,
      provenance: 'stored-record-marker (non-null durable column)',
      projectId: t.project_id, projectClassification: projClass, status: t.status,
      objectiveLinkage: objective ?? null,
      runIds, runSnapshotValues: runs.map((r) => ({ id: r.id, classification: r.classification, status: r.status })),
      runStepCount: stepCount, messageCount: msgCount,
      usageEventCount: usage.reduce((s, u) => s + (u.n as number), 0),
      usageClassificationValues: usage.map((u) => ({ classification: u.classification, count: u.n, micros: String(u.micros) })),
      dependencyRelationships: deps, decisionRelationships: decisions,
      classificationChangeAuditEvents: auditEvents,
    });
  }
  out.tasks = tasks;

  // Sanity: how the four partition by effective class under the production rule (live-only default).
  const eff = tasks.filter((t) => !('MISSING' in t)).map((t: Record<string, unknown>) => t.effectiveClassification as string);
  out.effectivePartition = { live: eff.filter((c) => c === 'live').length, demo: eff.filter((c) => c === 'demo').length, seed: eff.filter((c) => c === 'seed').length };

  console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
  await sql.end();
}

async function leakage() {
  const { withTenant } = await import('@/db/tenant');
  const { assessWorkspaceHealth } = await import('@/domain/health/health');
  const { employeeAttribution, attributionReconciliation, detectAttributionAnomalies } = await import('@/domain/agents/attribution');
  const { listExecution } = await import('@/domain/execution/execution');
  const { selectableTaskCandidates } = await import('@/domain/tasks/tasks');
  const { LIVE_ONLY, resolveRunClassification } = await import('@/domain/classification/classification');
  const ON = { includeNonLive: true } as const;

  const proj = (await sql`select id, org_id, classification from projects where id=${PROJECT}`)[0]!;
  const orgId = proj.org_id as string;
  const projCls = proj.classification as 'live' | 'demo' | 'seed';
  const userId = (await sql`select user_id from project_members where project_id=${PROJECT} and role='admin' limit 1`)[0]!.user_id as string;
  const ctx = { userId, orgId, projectId: PROJECT, orgRole: 'owner' as const, projectRole: 'admin' as const };
  const in4 = new Set(TASKS);
  const out: Record<string, unknown> = {};

  await withTenant(ctx, async (tx) => {
    // ---- CURRENT state via the real production loaders (read-only) ----
    const health = await assessWorkspaceHealth(tx, ctx);
    const anomalies = await detectAttributionAnomalies(tx, ctx);
    const recoLive = await attributionReconciliation(tx, ctx, LIVE_ONLY);
    const feedLive = await listExecution(tx, ctx, LIVE_ONLY);
    const feedOn = await listExecution(tx, ctx, ON);
    const attrLive = await employeeAttribution(tx, ctx, LIVE_ONLY);

    out.currentHealthExecution = { runsCompleted: health.execution.runsCompleted, runsCompletedDemo: health.execution.runsCompletedDemo, runsCompletedSeed: health.execution.runsCompletedSeed, failedTasks: health.execution.failedTasks, spentMicros: String(health.execution.spentMicros) };
    out.feedLive_containsCandidates = feedLive.rows.filter((r) => in4.has(r.id)).map((r) => ({ id: r.id, title: r.title, classification: r.classification, condition: r.condition ?? r.status }));
    out.feedLive_excluded = feedLive.excluded;
    out.feedOn_candidates = feedOn.rows.filter((r) => in4.has(r.id)).map((r) => ({ id: r.id, classification: r.classification }));
    out.anomalies_forCandidates = anomalies.anomalies.filter((a) => a.taskId && in4.has(a.taskId)).map((a) => ({ taskId: a.taskId, category: a.category, severity: a.severity, classification: a.classification, detail: a.detail }));
    out.attribution_liveHeadline = { performed: [...attrLive.values()].reduce((n, v) => n + v.performedWork, 0), reviewImpact: [...attrLive.values()].reduce((n, v) => n + v.reviewImpact, 0) };
    out.reconciliation_live = { totalMicros: String(recoLive.totalMicros), employeeExecutionMicros: String(recoLive.employeeExecutionMicros), employeeReviewMicros: String(recoLive.employeeReviewMicros), workspaceOverheadMicros: String(recoLive.workspaceOverheadMicros), reconciles: recoLive.reconciles };
    // The four candidates carry 0 usage, so their attributed cost is 0 → live reconciliation is unchanged by disposition.
    const candidateUsageMicros = (await sql`select coalesce(sum(cost_micros),0)::bigint as micros from usage_events where task_id = any(${TASKS}) or run_id in (select id from runs where task_id = any(${TASKS}))`)[0]!.micros;
    out.candidateAttributedCostMicros = String(candidateUsageMicros);

    // ---- PROJECTION: overlay the four tasks → demo, recompute with production rules (no writes) ----
    const overlay = new Map<string, 'demo'>(TASKS.map((t) => [t, 'demo']));
    const taskClsRows = await tx.select({ id: tasks.id, classification: tasks.classification }).from(tasks).where(and(eq(tasks.projectId, PROJECT), eq(tasks.orgId, orgId)));
    const agentClsRows = await tx.select({ id: agents.id, classification: agents.classification }).from(agents).where(and(eq(agents.projectId, PROJECT), eq(agents.orgId, orgId)));
    const taskCls = new Map(taskClsRows.map((r) => [r.id, r.classification as 'live' | 'demo' | 'seed']));
    const agentCls = new Map(agentClsRows.map((r) => [r.id, r.classification as 'live' | 'demo' | 'seed']));
    const completed = await tx.select({ id: runs.id, taskId: runs.taskId, classification: runs.classification, primaryAgentId: runs.primaryAgentId, reviewerAgentId: runs.reviewerAgentId }).from(runs).where(and(eq(runs.projectId, PROJECT), eq(runs.orgId, orgId), eq(runs.status, 'completed')));
    const bucket = (useOverlay: boolean) => {
      const b = { live: 0, demo: 0, seed: 0 };
      for (const r of completed) {
        const tc = (useOverlay && r.taskId && overlay.has(r.taskId)) ? 'demo' : (r.taskId ? taskCls.get(r.taskId) : null);
        const perfs = [r.primaryAgentId ? agentCls.get(r.primaryAgentId) : null, r.reviewerAgentId ? agentCls.get(r.reviewerAgentId) : null];
        const eff = resolveRunClassification(r.classification as 'live' | 'demo' | 'seed' | null, { projectClassification: projCls, taskClassification: tc, performerClassifications: perfs }).classification;
        b[eff] += 1;
      }
      return b;
    };
    out.projection_healthCompletedRuns = { current: bucket(false), projected: bucket(true) };

    // Execution-feed projection: the four completed tasks move to demo → excluded from live-only.
    const projectedExcludedDemo = feedLive.rows.filter((r) => in4.has(r.id)).length;
    out.projection_executionFeed = {
      current_liveVisibleCandidates: feedLive.rows.filter((r) => in4.has(r.id)).length,
      projected_excludedDemoNote: `${projectedExcludedDemo} demo records excluded`,
      projected_visibleUnderIncludeNonLive: feedOn.rows.filter((r) => in4.has(r.id)).length,
    };

    // Dependency/supersede candidacy: are the four offered for a LIVE source task's picker (now vs projected)?
    const allForPicker = taskClsRows.map((r) => ({ id: r.id, classification: r.classification as 'live' | 'demo' | 'seed' }));
    const liveSource = allForPicker.find((r) => r.classification === 'live' && !in4.has(r.id));
    const nowCandidates = liveSource ? selectableTaskCandidates(allForPicker, { excludeId: liveSource.id, excludeIds: new Set() }) : [];
    const projectedForPicker = allForPicker.map((r) => (in4.has(r.id) ? { ...r, classification: 'demo' as const } : r));
    const projCandidates = liveSource ? selectableTaskCandidates(projectedForPicker, { excludeId: liveSource.id, excludeIds: new Set() }) : [];
    out.dependencySupersedePicker = {
      liveSourceTaskUsed: liveSource?.id ?? null,
      candidatesNow_ofFour: nowCandidates.filter((c) => in4.has(c.id)).map((c) => c.id),
      candidatesProjected_ofFour: projCandidates.filter((c) => in4.has(c.id)).map((c) => c.id),
    };
  });

  console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2));
  await sql.end();
}

async function hub008() {
  const p = (await sql`select id, key, name, classification, coalesce(archived,false) as archived from projects where id=${ARCHIVED_PROJECT}`)[0]!;
  const counts = (await sql`select
      (select count(*)::int from tasks where project_id=${ARCHIVED_PROJECT}) as tasks,
      (select count(*)::int from objectives where project_id=${ARCHIVED_PROJECT}) as objectives,
      (select count(*)::int from runs where project_id=${ARCHIVED_PROJECT}) as runs,
      (select count(*)::int from run_steps s join runs r on r.id=s.run_id where r.project_id=${ARCHIVED_PROJECT}) as run_steps,
      (select count(*)::int from messages where project_id=${ARCHIVED_PROJECT}) as messages,
      (select count(*)::int from usage_events where project_id=${ARCHIVED_PROJECT}) as usage,
      (select count(*)::int from decisions where project_id=${ARCHIVED_PROJECT}) as decisions,
      (select count(*)::int from agents where project_id=${ARCHIVED_PROJECT}) as agents,
      (select count(*)::int from audit_logs where project_id=${ARCHIVED_PROJECT}) as audit`)[0]!;
  // Run/usage snapshot distribution (proves a project→demo classification would NOT rewrite these).
  const runSnap = await sql`select classification, count(*)::int as n from runs where project_id=${ARCHIVED_PROJECT} group by classification`;
  const usageSnap = await sql`select classification, count(*)::int as n from usage_events where project_id=${ARCHIVED_PROJECT} group by classification`;
  // Child stored classifications — none need an individual update to inherit the project classification.
  const childTaskCls = await sql`select classification, count(*)::int as n from tasks where project_id=${ARCHIVED_PROJECT} group by classification`;
  console.log(JSON.stringify({ project: p, childCounts: counts, runSnapshots: runSnap, usageSnapshots: usageSnap, childTaskStoredClass: childTaskCls,
    inheritanceNote: 'project→demo makes every child effectively demo via resolveRecordClassification precedence; no child row is updated; run/usage snapshot columns are not rewritten (only set at insert).' }, null, 2));
  await sql.end();
}

const cmd = process.argv[2] ?? 'inventory';
(cmd === 'leakage' ? leakage() : cmd === 'hub008' ? hub008() : inventory()).catch((e) => { console.error('ERR', e); process.exit(1); });
