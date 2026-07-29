import { and, eq, inArray } from 'drizzle-orm';
import { type DataClassification, type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { agents, departments, objectives, runSteps, runs, tasks, usageEvents } from '@/db/schema';
import {
  type ClassificationVisibility,
  LIVE_ONLY,
  loadProjectClassification,
  resolveRecordClassification,
  resolveRunClassification,
  resolveUsageClassification,
} from '@/domain/classification/classification';

/**
 * HUB-009 — the classification maps needed to resolve the EFFECTIVE classification of any activity
 * (run/usage) within a project: the project's own classification, and each agent's / task's classification.
 * Loaded once per attribution read so per-row resolution is pure + cheap.
 */
interface ClassMaps {
  projectClassification: DataClassification;
  agentClass: Map<string, DataClassification>;
  taskClass: Map<string, DataClassification>;
}
async function loadClassMaps(tx: DbTx, ctx: TenantContext): Promise<ClassMaps> {
  const projectClassification = await loadProjectClassification(tx, ctx.projectId);
  const agentRows = await tx.select({ id: agents.id, c: agents.classification }).from(agents).where(and(eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)));
  const taskRows = await tx.select({ id: tasks.id, c: tasks.classification }).from(tasks).where(and(eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)));
  return {
    projectClassification,
    agentClass: new Map(agentRows.map((a) => [a.id, a.c])),
    taskClass: new Map(taskRows.map((t) => [t.id, t.c])),
  };
}
/** Effective classification of a RUN — its immutable snapshot when present, else legacy-derived from parents. */
function effectiveRunClass(m: ClassMaps, run: { classification: DataClassification | null; taskId: string | null; primaryAgentId: string | null; reviewerAgentId: string | null }): DataClassification {
  return resolveRunClassification(run.classification, {
    projectClassification: m.projectClassification,
    taskClassification: run.taskId ? m.taskClass.get(run.taskId) ?? null : null,
    performerClassifications: [run.primaryAgentId, run.reviewerAgentId].filter((x): x is string => !!x).map((id) => m.agentClass.get(id) ?? null),
  }).classification;
}

/**
 * HUB-004 — employee work & cost attribution, DERIVED from immutable run evidence (ratified definitions).
 *
 * No per-employee cost column exists and none is added. Attribution derives from records the run path
 * already writes and never mutates. Four INDEPENDENT concepts, never conflated:
 *   - Performed work        — completed tasks the employee executed a successful primary/revision step on.
 *   - Current owned tasks    — `tasks.owner_agent_id` (mutable, current). NOT a performer or cost bearer.
 *   - Objectives owned       — `objectives.accountable_agent_id` (mutable). Business accountability.
 *   - Review impact          — review steps + interventions (reviewer work; kept OUT of Performed work).
 *
 * COST reconciles, in exact integer micros, to Governance Usage:
 *   employee execution cost + employee review cost + workspace overhead = total.
 *   - Execution cost (primary/revision/consolidate, run-linked non-review) → the run's primary performer.
 *   - Review cost (review steps) → the run's reviewer.
 *   - Workspace overhead → run-less spend (embeddings/ingestion/extraction) AND run-linked spend that
 *     cannot be attributed to an employee confidently. This is spend WITHOUT an employee execution
 *     attribution — NOT "unassigned work"; a different concept.
 */

// -- Metric definitions ------------------------------------------------------
const PERFORMED_STEP_KINDS = ['primary', 'revision'] as const; // a successful one credits performed work
const INTERVENTION_VERDICTS = ['revise', 'reject'] as const;

export interface EmployeeAttribution {
  agentId: string;
  name: string;
  role: string;
  departmentName: string | null;
  /** Completed tasks with ≥1 successful primary/revision step by this employee. One credit per task. */
  performedWork: number;
  /** Tasks currently owned (tasks.owner_agent_id) — separate from performed work. */
  ownedTasks: number;
  /** Objectives this employee is accountable for (objectives.accountable_agent_id). */
  objectivesOwned: number;
  /** Distinct tasks reviewed. */
  reviewImpact: number;
  /** Review verdicts that materially change the path (revise/reject). */
  interventions: number;
  /** interventions / reviewImpact, 0..1 (0 when no reviews). */
  interventionRate: number;
  /** Execution (primary/revision/consolidate) cost, exact micros. */
  executionCostMicros: bigint;
  /** Review cost, exact micros. */
  reviewCostMicros: bigint;
}

interface UsageRow {
  costMicros: bigint;
  runId: string | null;
  primaryAgentId: string | null;
  reviewerAgentId: string | null;
  stepKind: string | null;
  /** HUB-009 — the usage event's own snapshot + its run's snapshot + the run's task, for effective resolution. */
  usageClass: DataClassification | null;
  runClass: DataClassification | null;
  runTaskId: string | null;
}

async function loadUsageChain(tx: DbTx, ctx: TenantContext): Promise<UsageRow[]> {
  const rows = await tx
    .select({
      costMicros: usageEvents.costMicros,
      runId: usageEvents.runId,
      primaryAgentId: runs.primaryAgentId,
      reviewerAgentId: runs.reviewerAgentId,
      stepKind: runSteps.kind,
      usageClass: usageEvents.classification,
      runClass: runs.classification,
      runTaskId: runs.taskId,
    })
    .from(usageEvents)
    .leftJoin(runs, eq(usageEvents.runId, runs.id))
    .leftJoin(runSteps, eq(usageEvents.runStepId, runSteps.id))
    .where(and(eq(usageEvents.projectId, ctx.projectId), eq(usageEvents.orgId, ctx.orgId)));
  return rows.map((r) => ({
    costMicros: BigInt(r.costMicros),
    runId: r.runId,
    primaryAgentId: r.primaryAgentId,
    reviewerAgentId: r.reviewerAgentId,
    stepKind: r.stepKind,
    usageClass: r.usageClass,
    runClass: r.runClass,
    runTaskId: r.runTaskId,
  }));
}

/** Effective classification of a USAGE event: its snapshot, else its run's effective class, else project. */
function effectiveUsageClass(m: ClassMaps, u: UsageRow): DataClassification {
  if (u.usageClass) return u.usageClass;
  if (!u.runId) return resolveUsageClassification(null, { projectClassification: m.projectClassification }).classification;
  return effectiveRunClass(m, { classification: u.runClass, taskId: u.runTaskId, primaryAgentId: u.primaryAgentId, reviewerAgentId: u.reviewerAgentId });
}

/**
 * The bucket a single usage event falls in. Every event lands in exactly one, so the three buckets
 * always sum to the Governance Usage total (exact micros).
 *   - execution: run-linked, non-review, run has a primary → that primary employee.
 *   - review:    run-linked, review step, run has a reviewer → that reviewer.
 *   - workspace_overhead: run-less, OR run-linked but no employee can be attributed confidently.
 */
function bucketOf(u: UsageRow): { kind: 'execution' | 'review' | 'workspace_overhead'; agentId: string | null } {
  if (!u.runId) return { kind: 'workspace_overhead', agentId: null };
  if (u.stepKind === 'review') {
    return u.reviewerAgentId ? { kind: 'review', agentId: u.reviewerAgentId } : { kind: 'workspace_overhead', agentId: null };
  }
  return u.primaryAgentId ? { kind: 'execution', agentId: u.primaryAgentId } : { kind: 'workspace_overhead', agentId: null };
}

export async function employeeAttribution(
  tx: DbTx,
  ctx: TenantContext,
  visibility: ClassificationVisibility = LIVE_ONLY,
  /** When set, count ONLY activity whose effective classification is exactly this (for a per-class breakdown
   *  such as demo-vs-seed on the Employees page). Overrides `visibility`. */
  only?: DataClassification,
): Promise<Map<string, EmployeeAttribution>> {
  const agentRows = await tx
    .select({ id: agents.id, name: agents.name, role: agents.role, departmentName: departments.name })
    .from(agents)
    .leftJoin(departments, eq(agents.departmentId, departments.id))
    .where(and(eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)));
  if (agentRows.length === 0) return new Map();
  const ids = agentRows.map((a) => a.id);

  // HUB-009 — resolve every activity's EFFECTIVE classification and, in a live-only view, count ONLY live
  // activity. Live attribution mathematics are unchanged beyond this classification filter.
  const maps = await loadClassMaps(tx, ctx);
  const keepActivity = (cls: DataClassification) => (only ? cls === only : visibility.includeNonLive || cls === 'live');

  // Cost, derived from the run chain (exact micros) — filtered by effective usage classification.
  const usage = await loadUsageChain(tx, ctx);
  const executionCost = new Map<string, bigint>();
  const reviewCost = new Map<string, bigint>();
  for (const u of usage) {
    if (!keepActivity(effectiveUsageClass(maps, u))) continue;
    const b = bucketOf(u);
    if (b.kind === 'execution' && b.agentId) executionCost.set(b.agentId, (executionCost.get(b.agentId) ?? 0n) + u.costMicros);
    if (b.kind === 'review' && b.agentId) reviewCost.set(b.agentId, (reviewCost.get(b.agentId) ?? 0n) + u.costMicros);
  }

  // Performed work: one credit per (employee, completed task) with a successful primary/revision step,
  // counting only activity whose effective run classification passes the visibility filter.
  const performedRows = await tx
    .select({ agentId: runSteps.agentId, taskId: runs.taskId, runClass: runs.classification, primaryAgentId: runs.primaryAgentId, reviewerAgentId: runs.reviewerAgentId })
    .from(runSteps)
    .innerJoin(runs, eq(runSteps.runId, runs.id))
    .innerJoin(tasks, eq(runs.taskId, tasks.id))
    .where(
      and(
        eq(runSteps.projectId, ctx.projectId),
        eq(runSteps.succeeded, true),
        inArray(runSteps.kind, [...PERFORMED_STEP_KINDS]),
        eq(tasks.status, 'completed'),
        inArray(runSteps.agentId, ids),
      ),
    );
  const performedPairs = new Set<string>();
  for (const p of performedRows) {
    if (!p.agentId || !p.taskId) continue;
    const cls = effectiveRunClass(maps, { classification: p.runClass, taskId: p.taskId, primaryAgentId: p.primaryAgentId, reviewerAgentId: p.reviewerAgentId });
    if (!keepActivity(cls)) continue;
    performedPairs.add(`${p.agentId}|${p.taskId}`);
  }
  const performedWork = new Map<string, number>();
  for (const key of performedPairs) { const a = key.split('|')[0]!; performedWork.set(a, (performedWork.get(a) ?? 0) + 1); }

  // Review impact: distinct tasks reviewed + interventions (filtered by effective run classification).
  const reviewedRows = await tx
    .select({ agentId: runs.reviewerAgentId, taskId: runs.taskId, runClass: runs.classification, primaryAgentId: runs.primaryAgentId, reviewerAgentId: runs.reviewerAgentId })
    .from(runs)
    .innerJoin(runSteps, and(eq(runSteps.runId, runs.id), eq(runSteps.kind, 'review')))
    .where(and(eq(runs.projectId, ctx.projectId), inArray(runs.reviewerAgentId, ids)));
  const reviewedPairs = new Set<string>();
  for (const r of reviewedRows) {
    if (!r.agentId || !r.taskId) continue;
    const cls = effectiveRunClass(maps, { classification: r.runClass, taskId: r.taskId, primaryAgentId: r.primaryAgentId, reviewerAgentId: r.reviewerAgentId });
    if (!keepActivity(cls)) continue;
    reviewedPairs.add(`${r.agentId}|${r.taskId}`);
  }
  const reviewImpact = new Map<string, number>();
  for (const key of reviewedPairs) { const a = key.split('|')[0]!; reviewImpact.set(a, (reviewImpact.get(a) ?? 0) + 1); }

  const interventionRows = await tx
    .select({ agentId: runSteps.agentId, runClass: runs.classification, taskId: runs.taskId, primaryAgentId: runs.primaryAgentId, reviewerAgentId: runs.reviewerAgentId })
    .from(runSteps)
    .innerJoin(runs, eq(runSteps.runId, runs.id))
    .where(
      and(
        eq(runSteps.projectId, ctx.projectId),
        eq(runSteps.kind, 'review'),
        eq(runSteps.succeeded, true),
        inArray(runSteps.agentId, ids),
        inArray(runSteps.verdict, [...INTERVENTION_VERDICTS]),
      ),
    );
  const interventions = new Map<string, number>();
  for (const i of interventionRows) {
    if (!i.agentId) continue;
    const cls = effectiveRunClass(maps, { classification: i.runClass, taskId: i.taskId, primaryAgentId: i.primaryAgentId, reviewerAgentId: i.reviewerAgentId });
    if (!keepActivity(cls)) continue;
    interventions.set(i.agentId, (interventions.get(i.agentId) ?? 0) + 1);
  }

  // Current ownership + objective accountability (separate concepts) — a non-live owned record is non-live.
  const ownedTaskRows = await tx
    .select({ agentId: tasks.ownerAgentId, classification: tasks.classification })
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.projectId), inArray(tasks.ownerAgentId, ids)));
  const ownedTasks = new Map<string, number>();
  for (const o of ownedTaskRows) {
    if (!o.agentId) continue;
    if (!keepActivity(resolveRecordClassification(o.classification, maps.projectClassification).classification)) continue;
    ownedTasks.set(o.agentId, (ownedTasks.get(o.agentId) ?? 0) + 1);
  }

  const ownedObjRows = await tx
    .select({ agentId: objectives.accountableAgentId, classification: objectives.classification })
    .from(objectives)
    .where(and(eq(objectives.projectId, ctx.projectId), inArray(objectives.accountableAgentId, ids)));
  const objectivesOwned = new Map<string, number>();
  for (const o of ownedObjRows) {
    if (!o.agentId) continue;
    if (!keepActivity(resolveRecordClassification(o.classification, maps.projectClassification).classification)) continue;
    objectivesOwned.set(o.agentId, (objectivesOwned.get(o.agentId) ?? 0) + 1);
  }

  const out = new Map<string, EmployeeAttribution>();
  for (const a of agentRows) {
    const reviews = reviewImpact.get(a.id) ?? 0;
    const iv = interventions.get(a.id) ?? 0;
    out.set(a.id, {
      agentId: a.id,
      name: a.name,
      role: a.role,
      departmentName: a.departmentName,
      performedWork: performedWork.get(a.id) ?? 0,
      ownedTasks: ownedTasks.get(a.id) ?? 0,
      objectivesOwned: objectivesOwned.get(a.id) ?? 0,
      reviewImpact: reviews,
      interventions: iv,
      interventionRate: reviews > 0 ? iv / reviews : 0,
      executionCostMicros: executionCost.get(a.id) ?? 0n,
      reviewCostMicros: reviewCost.get(a.id) ?? 0n,
    });
  }
  return out;
}

export interface AttributionReconciliation {
  totalMicros: bigint;
  employeeExecutionMicros: bigint;
  employeeReviewMicros: bigint;
  workspaceOverheadMicros: bigint;
  /** execution + review + overhead === total, in exact integer micros. */
  reconciles: boolean;
}

/** Prove employee execution + employee review + workspace overhead == Governance Usage total (exact micros).
 *  In a live-only view the totals reconcile over LIVE activity only; with includeNonLive they reconcile over
 *  all authorized activity. */
export async function attributionReconciliation(
  tx: DbTx,
  ctx: TenantContext,
  visibility: ClassificationVisibility = LIVE_ONLY,
  /** When set, reconcile ONLY activity of exactly this effective classification (per-class breakdown). */
  only?: DataClassification,
): Promise<AttributionReconciliation> {
  const maps = await loadClassMaps(tx, ctx);
  const usage = await loadUsageChain(tx, ctx);
  let total = 0n;
  let execution = 0n;
  let review = 0n;
  let overhead = 0n;
  for (const u of usage) {
    const cls = effectiveUsageClass(maps, u);
    if (only ? cls !== only : !(visibility.includeNonLive || cls === 'live')) continue;
    total += u.costMicros;
    const b = bucketOf(u);
    if (b.kind === 'execution') execution += u.costMicros;
    else if (b.kind === 'review') review += u.costMicros;
    else overhead += u.costMicros;
  }
  return {
    totalMicros: total,
    employeeExecutionMicros: execution,
    employeeReviewMicros: review,
    workspaceOverheadMicros: overhead,
    reconciles: execution + review + overhead === total,
  };
}

// -- Drill-downs (req 3): the exact records behind every figure ---------------
/** HUB-009 — how an activity's classification was determined, so a diagnostic view never implies a
 *  legacy-derived value was historically snapshotted. */
export type ActivityProvenance = 'snapshot' | 'legacy-derived';
export interface TaskCostRow {
  taskId: string;
  taskTitle: string;
  costMicros: bigint;
  /** Effective classification of this activity. */
  classification: DataClassification;
  /** Whether that classification is an immutable snapshot or legacy-derived at read time. */
  provenance: ActivityProvenance;
}
export interface OwnedRow {
  id: string;
  title: string;
  status: string;
}
export interface ReviewedRow {
  taskId: string;
  taskTitle: string;
  verdicts: string[];
  costMicros: bigint;
  classification: DataClassification;
  provenance: ActivityProvenance;
}
export interface EmployeeDrilldown {
  performed: TaskCostRow[]; // performed tasks with execution cost
  reviewed: ReviewedRow[]; // reviewed tasks with verdicts + review cost
  ownedTasks: OwnedRow[];
  ownedObjectives: OwnedRow[];
  performedExecutionTotal: bigint;
  reviewedTotal: bigint;
}

export async function employeeAttributionDrilldown(
  tx: DbTx,
  ctx: TenantContext,
  agentId: string,
  visibility: ClassificationVisibility = LIVE_ONLY,
): Promise<EmployeeDrilldown> {
  const maps = await loadClassMaps(tx, ctx);
  // Cost rows via the run chain.
  const rows = await tx
    .select({
      costMicros: usageEvents.costMicros,
      taskId: runs.taskId,
      taskTitle: tasks.title,
      primaryAgentId: runs.primaryAgentId,
      reviewerAgentId: runs.reviewerAgentId,
      stepKind: runSteps.kind,
      verdict: runSteps.verdict,
      usageClass: usageEvents.classification,
      runClass: runs.classification,
    })
    .from(usageEvents)
    .innerJoin(runs, eq(usageEvents.runId, runs.id))
    .leftJoin(runSteps, eq(usageEvents.runStepId, runSteps.id))
    .leftJoin(tasks, eq(runs.taskId, tasks.id))
    .where(and(eq(usageEvents.projectId, ctx.projectId), eq(usageEvents.orgId, ctx.orgId)));

  const performed = new Map<string, TaskCostRow>();
  const reviewed = new Map<string, ReviewedRow>();
  for (const r of rows) {
    if (!r.taskId) continue;
    // Every drilldown row is run-linked (innerJoin runs): effective = usage snapshot, else the run's effective class.
    const effUsage = r.usageClass ?? effectiveRunClass(maps, { classification: r.runClass, taskId: r.taskId, primaryAgentId: r.primaryAgentId, reviewerAgentId: r.reviewerAgentId });
    if (!(visibility.includeNonLive || effUsage === 'live')) continue;
    // A usage event's own snapshot is authoritative (snapshot-backed); otherwise the value is legacy-derived.
    const provenance: ActivityProvenance = r.usageClass ? 'snapshot' : 'legacy-derived';
    const cost = BigInt(r.costMicros);
    const isReview = r.stepKind === 'review';
    if (!isReview && r.primaryAgentId === agentId) {
      const cur = performed.get(r.taskId) ?? { taskId: r.taskId, taskTitle: r.taskTitle ?? '(unknown)', costMicros: 0n, classification: effUsage, provenance };
      cur.costMicros += cost;
      performed.set(r.taskId, cur);
    }
    if (isReview && r.reviewerAgentId === agentId) {
      const cur = reviewed.get(r.taskId) ?? { taskId: r.taskId, taskTitle: r.taskTitle ?? '(unknown)', verdicts: [], costMicros: 0n, classification: effUsage, provenance };
      cur.costMicros += cost;
      if (r.verdict) cur.verdicts.push(r.verdict);
      reviewed.set(r.taskId, cur);
    }
  }

  const ownedTasks = await tx
    .select({ id: tasks.id, title: tasks.title, status: tasks.status })
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.projectId), eq(tasks.ownerAgentId, agentId)));
  const ownedObjectives = await tx
    .select({ id: objectives.id, title: objectives.title, status: objectives.status })
    .from(objectives)
    .where(and(eq(objectives.projectId, ctx.projectId), eq(objectives.accountableAgentId, agentId)));

  const perf = [...performed.values()];
  const rev = [...reviewed.values()];
  return {
    performed: perf,
    reviewed: rev,
    ownedTasks,
    ownedObjectives,
    performedExecutionTotal: perf.reduce((s, r) => s + r.costMicros, 0n),
    reviewedTotal: rev.reduce((s, r) => s + r.costMicros, 0n),
  };
}

// -- Read-only historical detector (req 8), ratified terminology -------------
export type AttributionAnomalyCategory =
  | 'usage_cost_no_bucket' // a usage event in none of execution/review/overhead (impossible by construction)
  | 'run_missing_employee' // run references a missing or cross-workspace employee
  | 'owner_differs_from_performer' // current owner ≠ historical performer
  | 'completed_task_manually_closed' // completed task with no run (manually closed) — not corruption
  | 'demo_record'; // demo/test-marked record → route to HUB-009, not treated as attribution corruption

export type AttributionSeverity = 'error' | 'warning' | 'info' | 'demo_hygiene';

export interface AttributionAnomaly {
  category: AttributionAnomalyCategory;
  severity: AttributionSeverity;
  taskId: string | null;
  taskTitle: string | null;
  detail: string;
  /** HUB-009 — effective classification of the record this anomaly concerns (for labelling when shown). */
  classification: DataClassification;
}

export interface AttributionAuditReport {
  reconciliation: AttributionReconciliation;
  anomalies: AttributionAnomaly[];
  scanned: { tasks: number; runs: number; usageEvents: number; agents: number };
}

export async function detectAttributionAnomalies(
  tx: DbTx,
  ctx: TenantContext,
): Promise<AttributionAuditReport> {
  const maps = await loadClassMaps(tx, ctx);
  const agentRows = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)));
  const agentIds = new Set(agentRows.map((a) => a.id));

  const taskRows = await tx
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, ownerAgentId: tasks.ownerAgentId, classification: tasks.classification })
    .from(tasks)
    .where(and(eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)));

  const runRows = await tx
    .select({ id: runs.id, taskId: runs.taskId, status: runs.status, primaryAgentId: runs.primaryAgentId, reviewerAgentId: runs.reviewerAgentId, classification: runs.classification })
    .from(runs)
    .where(and(eq(runs.projectId, ctx.projectId), eq(runs.orgId, ctx.orgId)));

  const usage = await loadUsageChain(tx, ctx);
  // Reconciliation is a partition property that holds over ALL authorized activity, so check it in full.
  const reconciliation = await attributionReconciliation(tx, ctx, { includeNonLive: true });

  const runsByTask = new Map<string, typeof runRows>();
  for (const r of runRows) {
    if (!r.taskId) continue;
    const arr = runsByTask.get(r.taskId) ?? [];
    arr.push(r);
    runsByTask.set(r.taskId, arr);
  }

  const anomalies: AttributionAnomaly[] = [];
  const push = (a: AttributionAnomaly): void => void anomalies.push(a);
  // HUB-009 — classification comes from STORED classification (project + record), never from a title/name
  // prefix. A properly-classified non-live record is never a LIVE integrity anomaly; instead it is surfaced
  // as a `demo_hygiene` note (labelled, inspectable, never silently dropped).
  const taskClass = (t: { classification: DataClassification }) => resolveRecordClassification(t.classification, maps.projectClassification).classification;

  for (const t of taskRows) {
    const taskRuns = runsByTask.get(t.id) ?? [];
    const performer = taskRuns.find((r) => r.status === 'completed' && r.primaryAgentId)?.primaryAgentId ?? null;
    const cls = taskClass(t);

    if (t.status === 'completed' && !performer) {
      if (cls !== 'live') {
        push({ category: 'demo_record', severity: 'demo_hygiene', taskId: t.id, taskTitle: t.title, classification: cls,
          detail: `Classified ${cls} record with no run — demo hygiene (HUB-009), not attribution corruption.` });
      } else {
        push({ category: 'completed_task_manually_closed', severity: 'info', taskId: t.id, taskTitle: t.title, classification: cls,
          detail: 'Completed task has no run — it was manually closed. No performing employee to credit.' });
      }
    }
    // A non-live task's owner≠performer is not a LIVE integrity issue.
    if (t.ownerAgentId && performer && t.ownerAgentId !== performer && cls === 'live') {
      push({ category: 'owner_differs_from_performer', severity: 'warning', taskId: t.id, taskTitle: t.title, classification: cls,
        detail: 'Current owner differs from the employee who actually performed the work — owner must not be read as performer.' });
    }
  }

  for (const r of runRows) {
    const runCls = effectiveRunClass(maps, { classification: r.classification, taskId: r.taskId, primaryAgentId: r.primaryAgentId, reviewerAgentId: r.reviewerAgentId });
    const missing = (agentId: string, role: string) => {
      if (runCls === 'live') {
        push({ category: 'run_missing_employee', severity: 'error', taskId: r.taskId, taskTitle: null, classification: runCls,
          detail: `Run ${role} agent ${agentId} is missing or cross-workspace — its cost cannot roll up.` });
      } else {
        // Malformed NON-LIVE activity is surfaced (never dropped), but not as a live error.
        push({ category: 'demo_record', severity: 'demo_hygiene', taskId: r.taskId, taskTitle: null, classification: runCls,
          detail: `Classified ${runCls} run has a missing/cross-workspace ${role} agent ${agentId} — demo hygiene, not a live integrity error.` });
      }
    };
    if (r.primaryAgentId && !agentIds.has(r.primaryAgentId)) missing(r.primaryAgentId, 'primary');
    if (r.reviewerAgentId && !agentIds.has(r.reviewerAgentId)) missing(r.reviewerAgentId, 'reviewer');
  }

  if (!reconciliation.reconciles) {
    push({ category: 'usage_cost_no_bucket', severity: 'error', taskId: null, taskTitle: null, classification: 'live',
      detail: 'Cost does not reconcile: execution + review + workspace overhead ≠ Governance Usage total.' });
  }

  return {
    reconciliation,
    anomalies,
    scanned: { tasks: taskRows.length, runs: runRows.length, usageEvents: usage.length, agents: agentRows.length },
  };
}
