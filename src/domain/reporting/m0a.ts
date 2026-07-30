import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import {
  RUN_STATUSES,
  STEP_KINDS,
  TASK_STATUSES,
  type RunStatus,
  type StepKind,
  type TaskStatus,
} from '@/types/domain';
import { type ProviderId } from '@/types/provider';
import { type DbTx } from '@/db/client';
import { agents, runSteps, runs, tasks, usageEvents } from '@/db/schema';
import { PRICING_SOURCE_VERSION, SEED_SCHEDULE_ID } from '@/domain/pricing/pricing-foundation';
import {
  type MatchState,
  type PricingMatch,
  currentScheduleEntries,
  estimateUsageMicros,
  matchPricing,
} from './pricing-match';
import {
  type AttributionResult,
  type RunInfo,
  type StepInfo,
  attributeUsage,
} from './attribution';

/**
 * M0a MEASUREMENT-ONLY reporting queries (read-only). Every function is project-scoped, parameterized, and
 * MUST be called inside `withTenant(ctx, …)` after `assertProjectReportAccess(ctx)` — RLS is the net under
 * the trapeze, the explicit `projectId` filter is the trapeze.
 *
 * Invariants:
 *  - `usage_events.cost_micros` is the SOLE authoritative historical total. Nothing here recomputes it.
 *  - The current P1a schedule only produces a SEPARATE, labeled estimate (never a rescaled "split").
 *  - Populations are counted independently; a task/run/step with no usage still counts; orphaned usage stays
 *    in totals and is labeled unattributed/run-less.
 *  - No prompts, responses, results, errors, or evidence are read or returned — identifiers/metrics only.
 */

export interface ReportWindow {
  /** Inclusive lower bound. */
  readonly from: Date;
  /** Exclusive upper bound. */
  readonly to: Date;
}

const EMPTY_RECORD = <K extends string>(keys: readonly K[]): Record<K, number> =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

// ---------------------------------------------------------------------------
// Internal windowed loader — the shared spine for attribution + reconciliation.
// ---------------------------------------------------------------------------

interface UsageRow {
  id: string;
  runId: string | null;
  runStepId: string | null;
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: bigint;
  createdAt: Date;
}

interface WindowedUsage {
  usageRows: UsageRow[];
  stepById: Map<string, StepInfo>;
  runById: Map<string, RunInfo>;
  employeeIds: Set<string>;
}

async function loadWindowedUsage(tx: DbTx, projectId: string, window: ReportWindow): Promise<WindowedUsage> {
  const usageRows: UsageRow[] = await tx
    .select({
      id: usageEvents.id,
      runId: usageEvents.runId,
      runStepId: usageEvents.runStepId,
      provider: usageEvents.provider,
      model: usageEvents.model,
      inputTokens: usageEvents.inputTokens,
      outputTokens: usageEvents.outputTokens,
      costMicros: usageEvents.costMicros,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.projectId, projectId),
        gte(usageEvents.createdAt, window.from),
        lt(usageEvents.createdAt, window.to),
      ),
    );

  const stepIds = [...new Set(usageRows.map((u) => u.runStepId).filter((x): x is string => x != null))];
  const runIds = [...new Set(usageRows.map((u) => u.runId).filter((x): x is string => x != null))];

  const stepById = new Map<string, StepInfo>();
  if (stepIds.length > 0) {
    const rows = await tx
      .select({ id: runSteps.id, kind: runSteps.kind, agentId: runSteps.agentId })
      .from(runSteps)
      .where(and(eq(runSteps.projectId, projectId), inArray(runSteps.id, stepIds)));
    for (const r of rows) stepById.set(r.id, { kind: r.kind, agentId: r.agentId });
  }

  const runById = new Map<string, RunInfo>();
  if (runIds.length > 0) {
    const rows = await tx
      .select({ id: runs.id, primaryAgentId: runs.primaryAgentId, reviewerAgentId: runs.reviewerAgentId })
      .from(runs)
      .where(and(eq(runs.projectId, projectId), inArray(runs.id, runIds)));
    for (const r of rows) runById.set(r.id, { primaryAgentId: r.primaryAgentId, reviewerAgentId: r.reviewerAgentId });
  }

  const roster = await tx.select({ id: agents.id }).from(agents).where(eq(agents.projectId, projectId));
  const employeeIds = new Set(roster.map((a) => a.id));

  return { usageRows, stepById, runById, employeeIds };
}

function attributeRow(u: UsageRow, ctx: WindowedUsage): AttributionResult {
  return attributeUsage(
    { runId: u.runId, runStepId: u.runStepId },
    {
      stepById: (id) => ctx.stepById.get(id),
      runById: (id) => ctx.runById.get(id),
      employeeExists: (id) => ctx.employeeIds.has(id),
    },
  );
}

// ---------------------------------------------------------------------------
// 1. Project summary
// ---------------------------------------------------------------------------

export interface Share {
  readonly numerator: number;
  readonly denominator: number;
}

export interface ProjectUsageSummary {
  readonly taskCountByStatus: Record<TaskStatus, number>;
  readonly runCountByStatus: Record<RunStatus, number>;
  readonly runStepCountByKind: Record<StepKind, number>;
  readonly usageEventCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly recordedCostMicros: bigint;
  readonly runAssociatedCostMicros: bigint;
  readonly runAssociatedEventCount: number;
  readonly runLessCostMicros: bigint;
  readonly runLessEventCount: number;
  readonly reviewEnabledTaskShare: Share;
  readonly reviewedRunShare: Share;
  readonly revisionTriggeredRunShare: Share;
}

export async function getProjectUsageSummary(
  tx: DbTx,
  projectId: string,
  window: ReportWindow,
): Promise<ProjectUsageSummary> {
  // Tasks — counted by their own created_at window, independently of usage.
  const taskRows = await tx
    .select({ status: tasks.status, reviewEnabled: tasks.reviewEnabled })
    .from(tasks)
    .where(and(eq(tasks.projectId, projectId), gte(tasks.createdAt, window.from), lt(tasks.createdAt, window.to)));
  const taskCountByStatus = EMPTY_RECORD(TASK_STATUSES);
  let reviewEnabledTasks = 0;
  for (const t of taskRows) {
    taskCountByStatus[t.status] += 1;
    if (t.reviewEnabled) reviewEnabledTasks += 1;
  }

  // Runs — counted by runs.created_at, independently of usage. Zero-usage/failed runs still count.
  const runRows = await tx
    .select({ id: runs.id, status: runs.status })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), gte(runs.createdAt, window.from), lt(runs.createdAt, window.to)));
  const runCountByStatus = EMPTY_RECORD(RUN_STATUSES);
  for (const r of runRows) runCountByStatus[r.status] += 1;
  const runIdsInWindow = runRows.map((r) => r.id);

  // Steps associated with the in-window runs — counted by kind; reviewed/revision detection reuses them.
  const runStepCountByKind = EMPTY_RECORD(STEP_KINDS);
  const reviewedRunIds = new Set<string>();
  const revisionRunIds = new Set<string>();
  if (runIdsInWindow.length > 0) {
    const stepRows = await tx
      .select({ runId: runSteps.runId, kind: runSteps.kind })
      .from(runSteps)
      .where(and(eq(runSteps.projectId, projectId), inArray(runSteps.runId, runIdsInWindow)));
    for (const s of stepRows) {
      runStepCountByKind[s.kind] += 1;
      if (s.kind === 'review') reviewedRunIds.add(s.runId);
      if (s.kind === 'revision') revisionRunIds.add(s.runId);
    }
  }

  // Usage — windowed by usage_events.created_at; run-associated vs run-less split.
  const { usageRows } = await loadWindowedUsage(tx, projectId, window);
  let inputTokens = 0;
  let outputTokens = 0;
  let recordedCostMicros = 0n;
  let runAssociatedCostMicros = 0n;
  let runAssociatedEventCount = 0;
  let runLessCostMicros = 0n;
  let runLessEventCount = 0;
  for (const u of usageRows) {
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    recordedCostMicros += u.costMicros;
    if (u.runId == null) {
      runLessCostMicros += u.costMicros;
      runLessEventCount += 1;
    } else {
      runAssociatedCostMicros += u.costMicros;
      runAssociatedEventCount += 1;
    }
  }

  return {
    taskCountByStatus,
    runCountByStatus,
    runStepCountByKind,
    usageEventCount: usageRows.length,
    inputTokens,
    outputTokens,
    recordedCostMicros,
    runAssociatedCostMicros,
    runAssociatedEventCount,
    runLessCostMicros,
    runLessEventCount,
    reviewEnabledTaskShare: { numerator: reviewEnabledTasks, denominator: taskRows.length },
    reviewedRunShare: { numerator: reviewedRunIds.size, denominator: runRows.length },
    revisionTriggeredRunShare: { numerator: revisionRunIds.size, denominator: runRows.length },
  };
}

// ---------------------------------------------------------------------------
// 2. Step-cost breakdown (+ unresolved-step + run-less buckets)
// ---------------------------------------------------------------------------

export type CostBucketKey = StepKind | 'unresolved_step' | 'run_less';

export interface CostBucket {
  readonly key: CostBucketKey;
  readonly recordedCostMicros: bigint;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly eventCount: number;
}

export async function getProjectStepCostBreakdown(
  tx: DbTx,
  projectId: string,
  window: ReportWindow,
): Promise<CostBucket[]> {
  const wu = await loadWindowedUsage(tx, projectId, window);
  const keys: CostBucketKey[] = [...STEP_KINDS, 'unresolved_step', 'run_less'];
  const acc = new Map<CostBucketKey, { cost: bigint; input: number; output: number; count: number }>();
  for (const k of keys) acc.set(k, { cost: 0n, input: 0, output: 0, count: 0 });

  for (const u of wu.usageRows) {
    let key: CostBucketKey;
    if (u.runId == null) key = 'run_less';
    else if (u.runStepId == null) key = 'unresolved_step';
    else {
      const step = wu.stepById.get(u.runStepId);
      key = step ? step.kind : 'unresolved_step';
    }
    const b = acc.get(key)!;
    b.cost += u.costMicros;
    b.input += u.inputTokens;
    b.output += u.outputTokens;
    b.count += 1;
  }

  return keys.map((k) => {
    const b = acc.get(k)!;
    return { key: k, recordedCostMicros: b.cost, inputTokens: b.input, outputTokens: b.output, eventCount: b.count };
  });
}

// ---------------------------------------------------------------------------
// 3. Model usage (+ pricing match + estimate coverage)
// ---------------------------------------------------------------------------

export interface ModelUsageRow {
  readonly provider: ProviderId;
  readonly model: string;
  readonly eventCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly recordedCostMicros: bigint;
  /** Match state for THIS (provider, model) evaluated per-event at its own created_at, then summarized. */
  readonly matchState: MatchState;
  readonly exactEventCount: number;
  readonly aliasEventCount: number;
  readonly unavailableEventCount: number;
  /** Estimate (ceil-up, current P1a schedule) is present only for events that matched; recorded cost is
   *  always authoritative regardless. These are ESTIMATES, not historical billing components. */
  readonly estimatedInputCostMicros: bigint;
  readonly estimatedOutputCostMicros: bigint;
  readonly estimatedCombinedCostMicros: bigint;
  /** Recorded cost of the events that DID match (the denominator that the estimate actually covers). */
  readonly matchedRecordedCostMicros: bigint;
}

export interface ModelUsageReport {
  readonly rows: ModelUsageRow[];
  readonly coverage: EstimateCoverage;
}

export interface EstimateCoverage {
  readonly totalEvents: number;
  readonly matchedEvents: number;
  readonly exactEvents: number;
  readonly aliasEvents: number;
  readonly unavailableEvents: number;
  readonly recordedCostMicros: bigint;
  readonly matchedRecordedCostMicros: bigint;
  readonly estimatedInputCostMicros: bigint;
  readonly estimatedOutputCostMicros: bigint;
  readonly estimatedCombinedCostMicros: bigint;
  /** estimatedCombined − matchedRecorded: difference on the covered subset only (never rescaled). */
  readonly estimatedDifferenceMicros: bigint;
  /** matchedEvents / totalEvents as integer basis points (0..10000); null when no events. */
  readonly estimatedEventCoverageBps: number | null;
  /** matchedRecorded / recorded as integer basis points (0..10000); null when recorded is 0. */
  readonly estimatedRecordedCostCoverageBps: number | null;
}

function bps(numerator: bigint, denominator: bigint): number | null {
  if (denominator === 0n) return null;
  return Number((numerator * 10_000n) / denominator);
}

export async function getProjectModelUsage(
  tx: DbTx,
  projectId: string,
  window: ReportWindow,
): Promise<ModelUsageReport> {
  const { usageRows } = await loadWindowedUsage(tx, projectId, window);
  const schedule = currentScheduleEntries();

  interface Agg {
    provider: ProviderId;
    model: string;
    eventCount: number;
    input: number;
    output: number;
    recorded: bigint;
    exact: number;
    alias: number;
    unavailable: number;
    estInput: bigint;
    estOutput: bigint;
    matchedRecorded: bigint;
  }
  const byModel = new Map<string, Agg>();

  for (const u of usageRows) {
    const key = `${u.provider}/${u.model}`;
    let a = byModel.get(key);
    if (!a) {
      a = {
        provider: u.provider,
        model: u.model,
        eventCount: 0,
        input: 0,
        output: 0,
        recorded: 0n,
        exact: 0,
        alias: 0,
        unavailable: 0,
        estInput: 0n,
        estOutput: 0n,
        matchedRecorded: 0n,
      };
      byModel.set(key, a);
    }
    a.eventCount += 1;
    a.input += u.inputTokens;
    a.output += u.outputTokens;
    a.recorded += u.costMicros; // authoritative, ALWAYS counted (incl. gpt-5.2 / unknown / expired)

    // Validity is evaluated at the row's OWN created_at (never "now").
    const m: PricingMatch = matchPricing(schedule, u.provider, u.model, u.createdAt.toISOString());
    if (m.state === 'exact') a.exact += 1;
    else if (m.state === 'approved_snapshot_alias') a.alias += 1;
    else a.unavailable += 1;

    if (m.entry) {
      const est = estimateUsageMicros(m.entry, u.inputTokens, u.outputTokens);
      a.estInput += est.inputMicros;
      a.estOutput += est.outputMicros;
      a.matchedRecorded += u.costMicros;
    }
  }

  const rows: ModelUsageRow[] = [...byModel.values()]
    .map((a) => {
      // A model row's summary match state: exact if every event matched exactly, alias if any alias and no
      // unavailable, else unavailable (mixed/none). Purely descriptive; per-event counts are authoritative.
      let matchState: MatchState;
      if (a.unavailable === 0 && a.alias === 0 && a.exact > 0) matchState = 'exact';
      else if (a.unavailable === 0 && a.alias > 0) matchState = 'approved_snapshot_alias';
      else matchState = 'unavailable';
      return {
        provider: a.provider,
        model: a.model,
        eventCount: a.eventCount,
        inputTokens: a.input,
        outputTokens: a.output,
        recordedCostMicros: a.recorded,
        matchState,
        exactEventCount: a.exact,
        aliasEventCount: a.alias,
        unavailableEventCount: a.unavailable,
        estimatedInputCostMicros: a.estInput,
        estimatedOutputCostMicros: a.estOutput,
        estimatedCombinedCostMicros: a.estInput + a.estOutput,
        matchedRecordedCostMicros: a.matchedRecorded,
      };
    })
    .sort((x, y) => (y.recordedCostMicros > x.recordedCostMicros ? 1 : y.recordedCostMicros < x.recordedCostMicros ? -1 : 0));

  const totalEvents = usageRows.length;
  const matchedEvents = rows.reduce((n, r) => n + r.exactEventCount + r.aliasEventCount, 0);
  const exactEvents = rows.reduce((n, r) => n + r.exactEventCount, 0);
  const aliasEvents = rows.reduce((n, r) => n + r.aliasEventCount, 0);
  const unavailableEvents = rows.reduce((n, r) => n + r.unavailableEventCount, 0);
  const recordedCostMicros = rows.reduce((s, r) => s + r.recordedCostMicros, 0n);
  const matchedRecordedCostMicros = rows.reduce((s, r) => s + r.matchedRecordedCostMicros, 0n);
  const estimatedInputCostMicros = rows.reduce((s, r) => s + r.estimatedInputCostMicros, 0n);
  const estimatedOutputCostMicros = rows.reduce((s, r) => s + r.estimatedOutputCostMicros, 0n);
  const estimatedCombinedCostMicros = estimatedInputCostMicros + estimatedOutputCostMicros;

  const coverage: EstimateCoverage = {
    totalEvents,
    matchedEvents,
    exactEvents,
    aliasEvents,
    unavailableEvents,
    recordedCostMicros,
    matchedRecordedCostMicros,
    estimatedInputCostMicros,
    estimatedOutputCostMicros,
    estimatedCombinedCostMicros,
    estimatedDifferenceMicros: estimatedCombinedCostMicros - matchedRecordedCostMicros,
    estimatedEventCoverageBps: totalEvents === 0 ? null : Number((BigInt(matchedEvents) * 10_000n) / BigInt(totalEvents)),
    estimatedRecordedCostCoverageBps: bps(matchedRecordedCostMicros, recordedCostMicros),
  };

  return { rows, coverage };
}

// ---------------------------------------------------------------------------
// 4. Run-cost distribution / highest-cost runs
// ---------------------------------------------------------------------------

export interface RunCostRow {
  readonly runId: string;
  readonly taskId: string;
  readonly status: RunStatus;
  readonly reviewed: boolean;
  readonly revisionTriggered: boolean;
  readonly eventCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cost of usage recorded INSIDE the selected window for this run (window-consistent with the project total). */
  readonly recordedCostMicros: bigint;
}

/**
 * All runs whose `created_at` is in the window (zero-usage runs included), each with the usage recorded
 * INSIDE the window for that run (M0a §1 decision: window-scoped run cost, not lifetime). Sorted by cost desc.
 */
export async function getProjectRunCostDistribution(
  tx: DbTx,
  projectId: string,
  window: ReportWindow,
  opts: { limit?: number } = {},
): Promise<RunCostRow[]> {
  const runRows = await tx
    .select({ id: runs.id, taskId: runs.taskId, status: runs.status })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), gte(runs.createdAt, window.from), lt(runs.createdAt, window.to)));
  if (runRows.length === 0) return [];
  const runIds = runRows.map((r) => r.id);

  // Review/revision occurrence for these runs.
  const reviewed = new Set<string>();
  const revised = new Set<string>();
  const stepRows = await tx
    .select({ runId: runSteps.runId, kind: runSteps.kind })
    .from(runSteps)
    .where(and(eq(runSteps.projectId, projectId), inArray(runSteps.runId, runIds)));
  for (const s of stepRows) {
    if (s.kind === 'review') reviewed.add(s.runId);
    if (s.kind === 'revision') revised.add(s.runId);
  }

  // Window-scoped usage per run.
  const { usageRows } = await loadWindowedUsage(tx, projectId, window);
  const perRun = new Map<string, { cost: bigint; input: number; output: number; count: number }>();
  for (const r of runRows) perRun.set(r.id, { cost: 0n, input: 0, output: 0, count: 0 });
  for (const u of usageRows) {
    if (u.runId == null) continue;
    const agg = perRun.get(u.runId);
    if (!agg) continue; // usage in window whose run was created outside the window — excluded from THIS view
    agg.cost += u.costMicros;
    agg.input += u.inputTokens;
    agg.output += u.outputTokens;
    agg.count += 1;
  }

  const rows: RunCostRow[] = runRows.map((r) => {
    const agg = perRun.get(r.id)!;
    return {
      runId: r.id,
      taskId: r.taskId,
      status: r.status,
      reviewed: reviewed.has(r.id),
      revisionTriggered: revised.has(r.id),
      eventCount: agg.count,
      inputTokens: agg.input,
      outputTokens: agg.output,
      recordedCostMicros: agg.cost,
    };
  });
  rows.sort((a, b) => (b.recordedCostMicros > a.recordedCostMicros ? 1 : b.recordedCostMicros < a.recordedCostMicros ? -1 : a.runId < b.runId ? -1 : 1));
  return opts.limit != null ? rows.slice(0, opts.limit) : rows;
}

export async function getProjectHighestCostRuns(
  tx: DbTx,
  projectId: string,
  window: ReportWindow,
  opts: { limit: number },
): Promise<RunCostRow[]> {
  return getProjectRunCostDistribution(tx, projectId, window, { limit: opts.limit });
}

// ---------------------------------------------------------------------------
// 5. Employee defaults (current enabled roster) — NEVER returns system_prompt
// ---------------------------------------------------------------------------

export interface EmployeeDefaultRow {
  readonly agentId: string;
  readonly name: string;
  readonly role: string;
  readonly title: string | null;
  readonly provider: ProviderId;
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly enabled: boolean;
}

/** Enabled employees for the project. Selects an explicit column set — `system_prompt` is never projected. */
export async function getProjectEmployeeDefaults(tx: DbTx, projectId: string): Promise<EmployeeDefaultRow[]> {
  const rows = await tx
    .select({
      agentId: agents.id,
      name: agents.name,
      role: agents.role,
      title: agents.title,
      provider: agents.provider,
      model: agents.model,
      maxOutputTokens: agents.maxOutputTokens,
      enabled: agents.enabled,
    })
    .from(agents)
    .where(and(eq(agents.projectId, projectId), eq(agents.enabled, true)));
  return rows.map((r) => ({ ...r }));
}

// ---------------------------------------------------------------------------
// 6. Attribution reconciliation (employee / unattributed-run / run-less)
// ---------------------------------------------------------------------------

export interface AttributionReconciliation {
  readonly employeeCostMicros: bigint;
  readonly employeeEventCount: number;
  readonly unattributedRunCostMicros: bigint;
  readonly unattributedRunEventCount: number;
  readonly runLessCostMicros: bigint;
  readonly runLessEventCount: number;
  readonly recordedCostMicros: bigint;
  /** True iff employee + unattributedRun + runLess === recorded (must always hold). */
  readonly reconciles: boolean;
  readonly perEmployee: { agentId: string; costMicros: bigint; eventCount: number }[];
}

export async function getProjectAttributionReconciliation(
  tx: DbTx,
  projectId: string,
  window: ReportWindow,
): Promise<AttributionReconciliation> {
  const wu = await loadWindowedUsage(tx, projectId, window);
  let employeeCostMicros = 0n;
  let employeeEventCount = 0;
  let unattributedRunCostMicros = 0n;
  let unattributedRunEventCount = 0;
  let runLessCostMicros = 0n;
  let runLessEventCount = 0;
  let recordedCostMicros = 0n;
  const perEmployee = new Map<string, { costMicros: bigint; eventCount: number }>();

  for (const u of wu.usageRows) {
    recordedCostMicros += u.costMicros;
    const res = attributeRow(u, wu);
    if (res.kind === 'employee' && res.agentId) {
      employeeCostMicros += u.costMicros;
      employeeEventCount += 1;
      const e = perEmployee.get(res.agentId) ?? { costMicros: 0n, eventCount: 0 };
      e.costMicros += u.costMicros;
      e.eventCount += 1;
      perEmployee.set(res.agentId, e);
    } else if (res.kind === 'unattributed_run') {
      unattributedRunCostMicros += u.costMicros;
      unattributedRunEventCount += 1;
    } else {
      runLessCostMicros += u.costMicros;
      runLessEventCount += 1;
    }
  }

  const reconciles =
    employeeCostMicros + unattributedRunCostMicros + runLessCostMicros === recordedCostMicros;

  return {
    employeeCostMicros,
    employeeEventCount,
    unattributedRunCostMicros,
    unattributedRunEventCount,
    runLessCostMicros,
    runLessEventCount,
    recordedCostMicros,
    reconciles,
    perEmployee: [...perEmployee.entries()]
      .map(([agentId, v]) => ({ agentId, costMicros: v.costMicros, eventCount: v.eventCount }))
      .sort((a, b) => (b.costMicros > a.costMicros ? 1 : b.costMicros < a.costMicros ? -1 : 0)),
  };
}

// ---------------------------------------------------------------------------
// 6b. Cost per COMPLETED task (M0a §5)
// ---------------------------------------------------------------------------

export interface CompletedTaskCost {
  readonly taskId: string;
  /** Runs belonging to this task (any status; earlier failed runs included). */
  readonly runCount: number;
  /** Sum of window-scoped usage recorded against every run belonging to this task. */
  readonly recordedCostMicros: bigint;
  readonly eventCount: number;
  readonly superseded: boolean;
}

/**
 * Cost per COMPLETED task: sums window-scoped usage across EVERY run belonging to the task — including
 * earlier failed runs. A superseded task keeps its own cost (never merged into its replacement). This is a
 * completion metric, NOT an acceptance metric.
 */
export async function getProjectCompletedTaskCosts(
  tx: DbTx,
  projectId: string,
  window: ReportWindow,
): Promise<CompletedTaskCost[]> {
  const completed = await tx
    .select({ id: tasks.id, superseded: tasks.supersededByTaskId })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        eq(tasks.status, 'completed'),
        gte(tasks.createdAt, window.from),
        lt(tasks.createdAt, window.to),
      ),
    );
  if (completed.length === 0) return [];
  const taskIds = completed.map((t) => t.id);

  // Every run of these tasks (any status, any created_at) → map runId → taskId.
  const runRows = await tx
    .select({ id: runs.id, taskId: runs.taskId })
    .from(runs)
    .where(and(eq(runs.projectId, projectId), inArray(runs.taskId, taskIds)));
  const runToTask = new Map(runRows.map((r) => [r.id, r.taskId]));
  const runCountByTask = new Map<string, number>();
  for (const r of runRows) runCountByTask.set(r.taskId, (runCountByTask.get(r.taskId) ?? 0) + 1);

  // Window-scoped usage attributed to a task via its run.
  const { usageRows } = await loadWindowedUsage(tx, projectId, window);
  const costByTask = new Map<string, { cost: bigint; count: number }>();
  for (const u of usageRows) {
    if (u.runId == null) continue;
    const taskId = runToTask.get(u.runId);
    if (!taskId) continue;
    const c = costByTask.get(taskId) ?? { cost: 0n, count: 0 };
    c.cost += u.costMicros;
    c.count += 1;
    costByTask.set(taskId, c);
  }

  return completed.map((t) => {
    const c = costByTask.get(t.id) ?? { cost: 0n, count: 0 };
    return {
      taskId: t.id,
      runCount: runCountByTask.get(t.id) ?? 0,
      recordedCostMicros: c.cost,
      eventCount: c.count,
      superseded: t.superseded != null,
    };
  });
}

// ---------------------------------------------------------------------------
// 7. Data-quality warnings
// ---------------------------------------------------------------------------

export interface DataQualityWarnings {
  readonly unknownModelEvents: number;
  readonly unknownModelCostMicros: bigint;
  readonly priceInvalidEvents: number;
  readonly unattributedRunEvents: number;
  readonly runLessEvents: number;
  readonly missingEmployeeRefEvents: number;
  readonly estimatedCostCoverageBps: number | null;
  readonly smallSampleEventCount: number;
  /** The runtime recorder that produced `cost_micros` uses integer FLOOR/truncation (verified read-only in
   *  `src/lib/money.ts costForTokens`). Recorded cost stays authoritative; M0a's ceil-up estimate can exceed
   *  it for fractional per-token rates (e.g. gpt-5.4-mini 0.75/4.5 micros/token). Never changed here. */
  readonly legacyRecorderArithmetic: 'floor';
  /** Count of MATCHED events whose ceil-up estimated combined cost differs from their recorded cost. Proves
   *  the warning is not a blanket claim that every event differs. */
  readonly matchedEstimateDiffersFromRecordedCount: number;
  /** Shown when a matched event's estimate differs from recorded, OR events were priced by the known legacy
   *  floor path — signalling recorded vs ceil-up estimate may differ. Not a claim that every event differs. */
  readonly legacyPricingWarning: boolean;
  /** M0a has no retry/cache instrumentation — declared as a standing blind spot, never inferred as zero. */
  readonly retriesInstrumented: false;
  readonly cacheUsageInstrumented: false;
}

export async function getProjectDataQualityWarnings(
  tx: DbTx,
  projectId: string,
  window: ReportWindow,
): Promise<DataQualityWarnings> {
  const wu = await loadWindowedUsage(tx, projectId, window);
  const schedule = currentScheduleEntries();

  let unknownModelEvents = 0;
  let unknownModelCostMicros = 0n;
  let priceInvalidEvents = 0;
  let matchedRecorded = 0n;
  let recorded = 0n;
  let missingEmployeeRefEvents = 0;
  let matchedEstimateDiffersFromRecordedCount = 0;

  for (const u of wu.usageRows) {
    recorded += u.costMicros;
    const known = schedule.some((e) => e.provider === u.provider && e.model === u.model);
    const m = matchPricing(schedule, u.provider, u.model, u.createdAt.toISOString());
    if (m.state === 'unavailable') {
      if (!known) {
        unknownModelEvents += 1;
        unknownModelCostMicros += u.costMicros;
      } else {
        // Known model name but outside its validity window at the row's timestamp → price-invalid.
        priceInvalidEvents += 1;
      }
    } else if (m.entry) {
      matchedRecorded += u.costMicros;
      // Per-event ceil-up estimate vs recorded (floor): count real divergences (never a blanket claim).
      const est = estimateUsageMicros(m.entry, u.inputTokens, u.outputTokens);
      if (est.combinedMicros !== u.costMicros) matchedEstimateDiffersFromRecordedCount += 1;
    }

    // A stored step performer that no longer resolves to a current employee.
    if (u.runStepId != null) {
      const step = wu.stepById.get(u.runStepId);
      if (step?.agentId != null && !wu.employeeIds.has(step.agentId)) missingEmployeeRefEvents += 1;
    }
  }

  const attribution = await getProjectAttributionReconciliation(tx, projectId, window);

  // The current recorder path (PRICING_SOURCE_VERSION) is the known legacy FLOOR rule; any recorded event
  // therefore MAY differ from the ceil-up estimate. Warn when a real per-event divergence is observed OR any
  // event was priced by that legacy path — without claiming every event differs.
  const legacyPricingWarning = matchedEstimateDiffersFromRecordedCount > 0 || wu.usageRows.length > 0;

  return {
    unknownModelEvents,
    unknownModelCostMicros,
    priceInvalidEvents,
    unattributedRunEvents: attribution.unattributedRunEventCount,
    runLessEvents: attribution.runLessEventCount,
    missingEmployeeRefEvents,
    estimatedCostCoverageBps: recorded === 0n ? null : Number((matchedRecorded * 10_000n) / recorded),
    smallSampleEventCount: wu.usageRows.length,
    legacyRecorderArithmetic: 'floor',
    matchedEstimateDiffersFromRecordedCount,
    legacyPricingWarning,
    retriesInstrumented: false,
    cacheUsageInstrumented: false,
  };
}

// ---------------------------------------------------------------------------
// 7b. Pricing-version breakdown (M0a §3)
// ---------------------------------------------------------------------------

export interface PricingVersionRow {
  readonly pricingVersion: string;
  readonly eventCount: number;
  readonly recordedCostMicros: bigint;
}

export interface PricingVersionBreakdown {
  /** The current verified schedule's SOURCE version (provenance only — a string match does NOT prove
   *  identical arithmetic or billing semantics). */
  readonly currentSourceVersion: string;
  readonly byVersion: PricingVersionRow[];
  /** Events whose stored `pricing_version` differs from `currentSourceVersion`. */
  readonly eventsWithNonCurrentSourceVersion: number;
  /** Matched events whose ceil-up estimate differs from recorded cost (arithmetic divergence, not a version
   *  mismatch). */
  readonly matchedEventsEstimateDiffersFromRecorded: number;
}

/**
 * Read-only breakdown by the STORED `usage_events.pricing_version`. Exposes counts and recorded cost per
 * version, how many events predate/differ from the current source version, and how many matched events have
 * an estimate ≠ recorded. Numeric aggregates only; no task content.
 */
export async function getProjectPricingVersionBreakdown(
  tx: DbTx,
  projectId: string,
  window: ReportWindow,
): Promise<PricingVersionBreakdown> {
  const rows = await tx
    .select({
      pricingVersion: usageEvents.pricingVersion,
      provider: usageEvents.provider,
      model: usageEvents.model,
      inputTokens: usageEvents.inputTokens,
      outputTokens: usageEvents.outputTokens,
      costMicros: usageEvents.costMicros,
      createdAt: usageEvents.createdAt,
    })
    .from(usageEvents)
    .where(
      and(
        eq(usageEvents.projectId, projectId),
        gte(usageEvents.createdAt, window.from),
        lt(usageEvents.createdAt, window.to),
      ),
    );

  const schedule = currentScheduleEntries();
  const byVersion = new Map<string, { count: number; cost: bigint }>();
  let eventsWithNonCurrentSourceVersion = 0;
  let matchedEventsEstimateDiffersFromRecorded = 0;

  for (const r of rows) {
    const v = byVersion.get(r.pricingVersion) ?? { count: 0, cost: 0n };
    v.count += 1;
    v.cost += r.costMicros;
    byVersion.set(r.pricingVersion, v);
    if (r.pricingVersion !== PRICING_SOURCE_VERSION) eventsWithNonCurrentSourceVersion += 1;

    const m = matchPricing(schedule, r.provider, r.model, r.createdAt.toISOString());
    if (m.entry) {
      const est = estimateUsageMicros(m.entry, r.inputTokens, r.outputTokens);
      if (est.combinedMicros !== r.costMicros) matchedEventsEstimateDiffersFromRecorded += 1;
    }
  }

  return {
    currentSourceVersion: PRICING_SOURCE_VERSION,
    byVersion: [...byVersion.entries()]
      .map(([pricingVersion, v]) => ({ pricingVersion, eventCount: v.count, recordedCostMicros: v.cost }))
      .sort((a, b) => (b.recordedCostMicros > a.recordedCostMicros ? 1 : b.recordedCostMicros < a.recordedCostMicros ? -1 : 0)),
    eventsWithNonCurrentSourceVersion,
    matchedEventsEstimateDiffersFromRecorded,
  };
}

// ---------------------------------------------------------------------------
// 8. Baseline metadata (reproducibility)
// ---------------------------------------------------------------------------

export interface BaselineMetadata {
  readonly windowFrom: string;
  readonly windowTo: string;
  readonly recordedPricingVersion: string;
  readonly estimateScheduleId: string;
  readonly totalUsageEvents: number;
  readonly recordedCostMicros: bigint;
  readonly matchedEvents: number;
  readonly matchedRecordedCostMicros: bigint;
}

/**
 * Self-describing provenance for a report run. `recordedPricingVersion` is the version the ROWS were priced
 * with (authoritative); `estimateScheduleId` is the P1a schedule used ONLY for the separate estimate.
 */
export async function getProjectBaselineMetadata(
  tx: DbTx,
  projectId: string,
  window: ReportWindow,
): Promise<BaselineMetadata> {
  const model = await getProjectModelUsage(tx, projectId, window);
  return {
    windowFrom: window.from.toISOString(),
    windowTo: window.to.toISOString(),
    recordedPricingVersion: PRICING_SOURCE_VERSION,
    estimateScheduleId: SEED_SCHEDULE_ID,
    totalUsageEvents: model.coverage.totalEvents,
    recordedCostMicros: model.coverage.recordedCostMicros,
    matchedEvents: model.coverage.matchedEvents,
    matchedRecordedCostMicros: model.coverage.matchedRecordedCostMicros,
  };
}
