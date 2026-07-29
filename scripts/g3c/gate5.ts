/**
 * HUB-009 Gate 5 — AUTHORIZED disposition: exactly five classification changes on staging via the
 * typed domain op `setRecordClassification` (NO direct SQL update). Four AccurateBids tasks (one
 * workspace-scoped transaction, all-or-none) + the archived hub008-uiproof project (its own tx).
 *
 *   tsx --conditions=react-server gate5.ts precheck     # read-only preconditions
 *   tsx --conditions=react-server gate5.ts execute      # the five changes
 *   tsx --conditions=react-server gate5.ts verify        # read-only post-state + audit events
 *   tsx --conditions=react-server gate5.ts idempotency   # repeat calls → false, no new events
 *   tsx --conditions=react-server gate5.ts safety         # final read-only safety check
 */
import postgres from 'postgres';
import { and, eq } from 'drizzle-orm';
import { tasks } from '@/db/schema';
import { withTenant } from '@/db/tenant';
import { setRecordClassification, resolveRecordClassification, resolveRunClassification } from '@/domain/classification/classification';
import type { TenantContext } from '@/types/domain';

const sql = postgres(process.env.DATABASE_MIGRATION_URL!, { prepare: false });

const AB_PROJECT = 'afa97b1c-7397-4d1d-9a95-99d0c19c7a96';
const TASKS = [
  '26a6cfb5-acdd-4f15-a703-1d23e81f828a',
  '101f80b6-7cb6-47a2-9bf1-f4b8ea2adafe',
  '722cfb4f-5552-4651-b3d9-b86549d17533',
  'f8e56488-8a6c-4a05-9ee6-f79feb6b7335',
];
const ARCH_PROJECT = '0db8a4a3-2eef-42c8-85e0-7e4badbe0fb4';
const TASK_REASON = 'HUB-009 Gate 5: AccurateBids fixture/demonstration task — reclassify live→demo (not real operating work).';
const PROJ_REASON = 'HUB-009 Gate 5: hub008-uiproof is a HUB-008 UI-proof demonstration project — reclassify live→demo.';

async function ctxFor(projectId: string): Promise<TenantContext> {
  const p = (await sql`select org_id from projects where id=${projectId}`)[0]!;
  const m = (await sql`select user_id from project_members where project_id=${projectId} and role='admin' limit 1`)[0]!;
  return { userId: m.user_id as string, orgId: p.org_id as string, projectId, orgRole: 'owner', projectRole: 'admin' };
}

async function precheck() {
  const checks: Array<{ name: string; pass: boolean; detail?: unknown }> = [];
  const add = (name: string, pass: boolean, detail?: unknown) => checks.push({ name, pass, detail });

  for (const id of TASKS) {
    const t = (await sql`select id, classification, status, project_id, objective_id from tasks where id=${id}`)[0];
    add(`task ${id} exists & stored=live`, !!t && t.classification === 'live', t ? { classification: t.classification, status: t.status } : 'MISSING');
    add(`task ${id} in AccurateBids project`, !!t && t.project_id === AB_PROJECT, t?.project_id);
    add(`task ${id} objective still null`, !!t && t.objective_id === null, t?.objective_id);
    const deps = (await sql`select count(*)::int as n from task_dependencies where prerequisite_task_id=${id} or dependent_task_id=${id}`)[0]!.n;
    add(`task ${id} no dependencies`, deps === 0, deps);
    const runs = await sql`select id from runs where task_id=${id}`;
    const runIds = runs.map((r) => r.id as string);
    const usageN = (await sql`select count(*)::int as n from usage_events where task_id=${id} or run_id = any(${runIds.length ? runIds : ['00000000-0000-0000-0000-000000000000']})`)[0]!.n;
    add(`task ${id} usage-events still 0`, usageN === 0, usageN);
    const decN = (await sql`select count(*)::int as n from decisions where originating_task_id=${id} or scope_task_id=${id}`)[0]!.n;
    add(`task ${id} no decision links`, decN === 0, decN);
    const evN = (await sql`select count(*)::int as n from audit_logs where entity_id=${id} and action='record.classification_changed'`)[0]!.n;
    add(`task ${id} no prior classification event`, evN === 0, evN);
  }
  const proj = (await sql`select classification, coalesce(archived,false) as archived from projects where id=${ARCH_PROJECT}`)[0];
  add(`project ${ARCH_PROJECT} stored=live`, !!proj && proj.classification === 'live', proj?.classification);
  add(`project ${ARCH_PROJECT} archived=true`, !!proj && proj.archived === true, proj?.archived);
  const projEv = (await sql`select count(*)::int as n from audit_logs where entity_id=${ARCH_PROJECT} and action='record.classification_changed'`)[0]!.n;
  add(`project ${ARCH_PROJECT} no prior classification event`, projEv === 0, projEv);
  const childCounts = (await sql`select
      (select count(*)::int from tasks where project_id=${ARCH_PROJECT}) as tasks,
      (select count(*)::int from objectives where project_id=${ARCH_PROJECT}) as objectives,
      (select count(*)::int from runs where project_id=${ARCH_PROJECT}) as runs,
      (select count(*)::int from usage_events where project_id=${ARCH_PROJECT}) as usage`)[0]!;
  add(`project ${ARCH_PROJECT} child counts unchanged (1/1/1/5)`, childCounts.tasks === 1 && childCounts.objectives === 1 && childCounts.runs === 1 && childCounts.usage === 5, childCounts);

  const allPass = checks.every((c) => c.pass);
  console.log(JSON.stringify({ GO: allPass, failed: checks.filter((c) => !c.pass), checks }, null, 2));
  await sql.end();
}

async function execute() {
  const abCtx = await ctxFor(AB_PROJECT);
  // Four task changes — ONE workspace-scoped transaction (all-or-none).
  const taskResults = await withTenant(abCtx, async (tx) => {
    const out: Array<{ id: string; result: boolean }> = [];
    for (const id of TASKS) {
      const result = await setRecordClassification(tx, abCtx, { entityType: 'task', entityId: id, to: 'demo', reason: TASK_REASON });
      out.push({ id, result });
    }
    return out;
  });
  // Archived project change — its own admin ctx / transaction.
  const hubCtx = await ctxFor(ARCH_PROJECT);
  const projResult = await withTenant(hubCtx, (tx) => setRecordClassification(tx, hubCtx, { entityType: 'project', entityId: ARCH_PROJECT, to: 'demo', reason: PROJ_REASON }));

  // Capture the resulting audit events (ids + values).
  const ids = [...TASKS, ARCH_PROJECT];
  const events = await sql`select id, entity_type, entity_id, actor_id, detail, created_at, prev_hash is not null as chained
    from audit_logs where entity_id = any(${ids}) and action='record.classification_changed' order by created_at`;
  console.log(JSON.stringify({ taskResults, projResult, newEventCount: events.length, events }, null, 2));
  await sql.end();
}

async function verify() {
  const out: Record<string, unknown> = {};
  const projClassAB = (await sql`select classification from projects where id=${AB_PROJECT}`)[0]!.classification as 'live' | 'demo' | 'seed';
  out.tasks = [];
  for (const id of TASKS) {
    const t = (await sql`select classification, status, objective_id from tasks where id=${id}`)[0]!;
    const eff = resolveRecordClassification(t.classification as 'live' | 'demo' | 'seed', projClassAB);
    const runs = await sql`select id, classification, status from runs where task_id=${id}`;
    const runInfo = [];
    for (const r of runs) {
      const stepN = (await sql`select count(*)::int as n from run_steps where run_id=${r.id}`)[0]!.n;
      const useN = (await sql`select count(*)::int as n from usage_events where run_id=${r.id}`)[0]!.n;
      const effRun = resolveRunClassification(r.classification as 'live' | 'demo' | 'seed' | null, { projectClassification: projClassAB, taskClassification: t.classification as 'live' | 'demo' | 'seed', performerClassifications: [] });
      runInfo.push({ id: r.id, snapshot: r.classification, status: r.status, stepCount: stepN, usageCount: useN, effective: effRun.classification, provenance: effRun.provenance });
    }
    (out.tasks as unknown[]).push({ id, storedClassification: t.classification, effectiveClassification: eff.classification, provenance: 'record-marker', status: t.status, objectiveId: t.objective_id, runs: runInfo });
  }
  const proj = (await sql`select classification, coalesce(archived,false) as archived from projects where id=${ARCH_PROJECT}`)[0]!;
  const childCounts = (await sql`select
      (select count(*)::int from tasks where project_id=${ARCH_PROJECT}) as tasks,
      (select count(*)::int from objectives where project_id=${ARCH_PROJECT}) as objectives,
      (select count(*)::int from runs where project_id=${ARCH_PROJECT}) as runs,
      (select count(*)::int from run_steps s join runs r on r.id=s.run_id where r.project_id=${ARCH_PROJECT}) as run_steps,
      (select count(*)::int from messages where project_id=${ARCH_PROJECT}) as messages,
      (select count(*)::int from usage_events where project_id=${ARCH_PROJECT}) as usage,
      (select count(*)::int from decisions where project_id=${ARCH_PROJECT}) as decisions,
      (select count(*)::int from agents where project_id=${ARCH_PROJECT}) as agents,
      (select count(*)::int from audit_logs where project_id=${ARCH_PROJECT}) as audit`)[0]!;
  const childTask = (await sql`select classification from tasks where project_id=${ARCH_PROJECT}`)[0]!;
  out.archivedProject = { storedClassification: proj.classification, effectiveClassification: proj.classification, archived: proj.archived, childCounts,
    childTaskEffective: resolveRecordClassification(childTask.classification as 'live' | 'demo' | 'seed', proj.classification as 'live' | 'demo' | 'seed').classification };
  const events = await sql`select count(*)::int as n from audit_logs where entity_id = any(${[...TASKS, ARCH_PROJECT]}) and action='record.classification_changed'`;
  out.classificationEventCount = events[0]!.n;
  console.log(JSON.stringify(out, null, 2));
  await sql.end();
}

async function idempotency() {
  const abCtx = await ctxFor(AB_PROJECT);
  const hubCtx = await ctxFor(ARCH_PROJECT);
  const before = (await sql`select count(*)::int as n from audit_logs where entity_id = any(${[...TASKS, ARCH_PROJECT]}) and action='record.classification_changed'`)[0]!.n;
  const taskRepeat = await withTenant(abCtx, async (tx) => {
    const out = [];
    for (const id of TASKS) out.push({ id, result: await setRecordClassification(tx, abCtx, { entityType: 'task', entityId: id, to: 'demo', reason: TASK_REASON }) });
    return out;
  });
  const projRepeat = await withTenant(hubCtx, (tx) => setRecordClassification(tx, hubCtx, { entityType: 'project', entityId: ARCH_PROJECT, to: 'demo', reason: PROJ_REASON }));
  const after = (await sql`select count(*)::int as n from audit_logs where entity_id = any(${[...TASKS, ARCH_PROJECT]}) and action='record.classification_changed'`)[0]!.n;
  console.log(JSON.stringify({ taskRepeat, projRepeat, eventsBefore: before, eventsAfter: after, noNewEvents: before === after }, null, 2));
  await sql.end();
}

async function safety() {
  // Every record.classification_changed on a REAL workspace must be exactly the five approved entities.
  const realEvents = await sql`
    select a.entity_type, a.entity_id, p.key from audit_logs a join projects p on p.id=a.project_id
    where a.action='record.classification_changed' and p.key not like 'hub009-%'
    order by a.created_at`;
  const approved = new Set([...TASKS, ARCH_PROJECT]);
  const unexpected = realEvents.filter((e) => !approved.has(e.entity_id as string));
  console.log(JSON.stringify({
    realWorkspaceClassificationEvents: realEvents,
    exactlyFiveApproved: realEvents.length === 5 && realEvents.every((e) => approved.has(e.entity_id as string)),
    unexpectedRealChanges: unexpected,
  }, null, 2));
  await sql.end();
}

const cmd = process.argv[2];
const map: Record<string, () => Promise<void>> = { precheck, execute, verify, idempotency, safety };
const fn = map[cmd ?? ''];
if (!fn) { console.error('unknown command', cmd); process.exit(2); }
fn().catch((e) => { console.error('ERR', e); process.exit(1); });
