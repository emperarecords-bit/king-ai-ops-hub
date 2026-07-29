import { and, eq, sql } from 'drizzle-orm';
import { type DataClassification, type SuccessCriterion, type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { agents, approvals, milestones, objectives, runs, tasks } from '@/db/schema';
import { listObjectives, type ObjectiveListRow } from '@/domain/objectives/objectives';
import { detectObjectiveLinkContradictions } from '@/domain/objectives/task-link';
import { attributionReconciliation } from '@/domain/agents/attribution';
import { loadProjectClassification, resolveRecordClassification, resolveRunClassification } from '@/domain/classification/classification';
import { projectSpendLimit, spentThisPeriodMicros } from '@/domain/usage/usage';

/**
 * HUB-007 — truthful workspace health, DERIVED from current authoritative state (no persisted "healthy"
 * flag). Five INDEPENDENT dimensions; activity is never presented as outcome. Both the Dashboard and the
 * Morning Briefing consume THIS one structure, so they can never disagree. AI prose may summarize these
 * findings but must never invent or override the classification.
 */

export type HealthDimension = 'execution' | 'workflow_integrity' | 'governance' | 'outcome' | 'activity';
export type HealthSeverity = 'info' | 'warning' | 'error';
export type DimensionStatus = 'ok' | 'info' | 'warning' | 'error' | 'unknown';

/** Deterministic overall states, in the precedence order documented in overallFrom(). */
export type OverallHealthState =
  | 'healthy'
  | 'operational_with_warnings'
  | 'needs_attention'
  | 'blocked'
  | 'data_integrity_issue'
  | 'unable_to_assess';

export interface HealthFinding {
  code: string;
  dimension: HealthDimension;
  severity: HealthSeverity;
  entityType: string | null;
  entityId: string | null;
  /** Short, user-facing. */
  title: string;
  /** The authoritative facts that support the finding. */
  evidence: string;
  recommendedAction: string;
  /** True only when the finding blocks a CURRENT operation (not for historical/irrelevant items). */
  blocksOperation: boolean;
}

export interface OutcomeCriterion {
  label: string;
  target: number;
  unit: string;
  met: boolean;
  verifiedAt: string | null;
}

/** Objective metrics kept strictly separate — activity (tasks) is never merged into outcome (criteria). */
export interface ObjectiveOutcomeMetrics {
  objectiveId: string;
  title: string;
  status: string;
  outcomeCriteriaMet: number;
  outcomeCriteriaTotal: number;
  criteria: OutcomeCriterion[];
  milestonesActive: number;
  milestonesCompleted: number;
  milestonesTotal: number;
  contributingTasksCompleted: number;
  contributingTasksTotal: number;
  hasVerifiedOutcomeEvidence: boolean;
  /** e.g. "No verified outcome evidence". */
  evidenceNote: string;
}

export interface WorkspaceHealth {
  overall: OverallHealthState;
  dimensions: Record<HealthDimension, DimensionStatus>;
  findings: HealthFinding[];
  /** The primary (highest-priority) active objective's outcome metrics, or null if none is active. */
  activeObjective: ObjectiveOutcomeMetrics | null;
  /** Execution facts — reported as facts, NOT proof of overall health. */
  execution: { runsCompleted: number; runsCompletedDemo: number; runsCompletedSeed: number; runsCompletedNonLive: number; runsFailed: number; failedTasks: number; spentMicros: bigint; limitMicros: bigint; budgetExhausted: boolean };
  /** Activity facts — delivery progress, never outcome. */
  activity: { tasksCompleted: number; objectivesActive: number };
}

const SEVERITY_RANK: Record<HealthSeverity, number> = { info: 1, warning: 2, error: 3 };

function criterionMet(c: SuccessCriterion): boolean {
  return c.status === 'met' || c.status === 'waived';
}

function objectiveMetrics(row: ObjectiveListRow, milestoneCounts: { active: number; completed: number; total: number }): ObjectiveOutcomeMetrics {
  const criteria = row.successCriteria;
  const met = criteria.filter(criterionMet).length;
  const hasVerified = criteria.some((c) => c.status === 'met' && c.verifiedAt);
  return {
    objectiveId: row.id,
    title: row.title,
    status: row.status,
    outcomeCriteriaMet: met,
    outcomeCriteriaTotal: criteria.length,
    criteria: criteria.map((c) => ({ label: c.label, target: c.target, unit: c.unit, met: criterionMet(c), verifiedAt: c.verifiedAt })),
    milestonesActive: milestoneCounts.active,
    milestonesCompleted: milestoneCounts.completed,
    milestonesTotal: milestoneCounts.total,
    contributingTasksCompleted: row.progress.tasksCompleted,
    contributingTasksTotal: row.progress.tasksTotal,
    hasVerifiedOutcomeEvidence: hasVerified,
    evidenceNote: hasVerified ? 'Outcome evidence recorded.' : 'No verified outcome evidence.',
  };
}

/** Deterministic precedence. Data-integrity error overrides Healthy; no failed runs alone cannot be Healthy. */
export function overallFrom(findings: HealthFinding[]): OverallHealthState {
  const has = (p: (f: HealthFinding) => boolean): boolean => findings.some(p);
  // 1. A workflow-integrity or governance ERROR is a data-integrity issue — overrides everything below.
  if (has((f) => f.severity === 'error' && (f.dimension === 'workflow_integrity' || f.dimension === 'governance'))) {
    return 'data_integrity_issue';
  }
  // 2. Anything that blocks a current operation.
  if (has((f) => f.blocksOperation)) return 'blocked';
  // 3. Any remaining error (e.g. execution: budget/run failures) needs attention.
  if (has((f) => f.severity === 'error')) return 'needs_attention';
  // 4. Any warning or info (incl. missing outcome evidence) → operational, but WITH warnings — never Healthy.
  if (findings.length > 0) return 'operational_with_warnings';
  // 5. No findings at all.
  return 'healthy';
}

const OVERALL_LABEL: Record<OverallHealthState, string> = {
  healthy: 'Healthy',
  operational_with_warnings: 'Operational with warnings',
  needs_attention: 'Needs attention',
  blocked: 'Blocked',
  data_integrity_issue: 'Data integrity issue',
  unable_to_assess: 'Unable to assess',
};
export function overallLabel(state: OverallHealthState): string {
  return OVERALL_LABEL[state];
}

/** The outcome line for an objective — activity and outcome are stated SEPARATELY, never merged. */
export function outcomeLine(o: ObjectiveOutcomeMetrics): string {
  const target = o.criteria
    .filter((c) => c.target > 0 && c.unit)
    .map((c) => `${c.met ? c.target : 0} of ${c.target} ${c.unit}`)
    .join('; ');
  return [
    `Contributing tasks: ${o.contributingTasksCompleted} of ${o.contributingTasksTotal} completed`,
    `Outcome criteria: ${o.outcomeCriteriaMet} of ${o.outcomeCriteriaTotal} met`,
    target ? `Target: ${target}` : null,
    `Milestones: ${o.milestonesActive} active, ${o.milestonesCompleted} completed`,
    `Status: ${o.status}`,
    o.evidenceNote,
  ]
    .filter(Boolean)
    .join(' · ');
}

export interface BriefingSummary {
  /** Overall operational condition (never a bare "healthy" unless truly healthy). */
  headline: string;
  /** Outcome progress on the active objective. */
  outcome: string;
  /** Meaningful activity/delivery (never presented as outcome). */
  activity: string;
  /** Blockers + warnings. */
  warnings: string[];
  /** Decisions/actions needed. */
  actions: string[];
  /** Evidence limitations. */
  evidenceLimit: string;
}

/**
 * Deterministic briefing text built from the structured health (no AI, no hard-coding). The exact wording
 * derives from facts, so the same state always yields the same briefing, and "healthy" is only ever said
 * when the classification is actually Healthy.
 */
export function briefingSummary(health: WorkspaceHealth, business: string): BriefingSummary {
  const headlineByState: Record<OverallHealthState, string> = {
    healthy: `${business} is healthy.`,
    operational_with_warnings: `${business} is operational, with warnings.`,
    needs_attention: `${business} needs attention.`,
    blocked: `${business} is blocked.`,
    data_integrity_issue: `${business} has a data-integrity issue to resolve.`,
    unable_to_assess: `${business}: not enough current evidence to assess.`,
  };
  const o = health.activeObjective;
  const outcome = o
    ? `The objective "${o.title}" — ${outcomeLine(o)}`
    : 'No active objective to measure outcomes against.';
  const activity = `${health.activity.tasksCompleted} contributing task${health.activity.tasksCompleted === 1 ? '' : 's'} completed; ${health.execution.runsFailed} failed run${health.execution.runsFailed === 1 ? '' : 's'}.`;
  const relevant = health.findings.filter((f) => f.severity === 'warning' || f.severity === 'error');
  return {
    headline: headlineByState[health.overall],
    outcome,
    activity,
    warnings: relevant.map((f) => f.title),
    actions: relevant.map((f) => f.recommendedAction),
    evidenceLimit: o ? o.evidenceNote : 'No active objective — momentum cannot be assessed.',
  };
}

export async function assessWorkspaceHealth(tx: DbTx, ctx: TenantContext): Promise<WorkspaceHealth> {
  const findings: HealthFinding[] = [];
  const objectiveRows = await listObjectives(tx, ctx);
  // HUB-009 — live health is assessed over LIVE objectives only; a demo/seed objective is not a live concern.
  const activeObjectives = objectiveRows.filter((o) => o.status === 'active' && o.classification === 'live');

  // --- Execution -----------------------------------------------------------
  // HUB-009 — headline execution facts are LIVE-only; non-live completed runs are reported SEPARATELY, never
  // merged into the live number. Effective run classification is the snapshot, else legacy-derived.
  const projectClassification = await loadProjectClassification(tx, ctx.projectId);
  const agentClassRows = await tx.select({ id: agents.id, c: agents.classification }).from(agents).where(and(eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)));
  const agentClass = new Map(agentClassRows.map((a) => [a.id, a.c]));
  const taskClassRows = await tx.select({ id: tasks.id, c: tasks.classification, status: tasks.status }).from(tasks).where(and(eq(tasks.projectId, ctx.projectId), eq(tasks.orgId, ctx.orgId)));
  const taskClass = new Map(taskClassRows.map((t) => [t.id, t.c]));
  const runRows = await tx
    .select({ status: runs.status, classification: runs.classification, taskId: runs.taskId, primaryAgentId: runs.primaryAgentId, reviewerAgentId: runs.reviewerAgentId })
    .from(runs)
    .where(and(eq(runs.projectId, ctx.projectId), eq(runs.orgId, ctx.orgId)));
  const runEffective = (r: (typeof runRows)[number]): DataClassification =>
    resolveRunClassification(r.classification, {
      projectClassification,
      taskClassification: r.taskId ? taskClass.get(r.taskId) ?? null : null,
      performerClassifications: [r.primaryAgentId, r.reviewerAgentId].filter((x): x is string => !!x).map((id) => agentClass.get(id) ?? null),
    }).classification;
  let runsFailed = 0;
  let runsCompleted = 0;
  let runsCompletedDemo = 0;
  let runsCompletedSeed = 0;
  for (const r of runRows) {
    const cls = runEffective(r);
    if (r.status === 'failed' && cls === 'live') runsFailed += 1;
    if (r.status === 'completed') {
      if (cls === 'live') runsCompleted += 1;
      else if (cls === 'demo') runsCompletedDemo += 1;
      else runsCompletedSeed += 1;
    }
  }
  const runsCompletedNonLive = runsCompletedDemo + runsCompletedSeed;
  // Failed TASKS: a live health finding only for LIVE tasks; a demo/seed failed task is not live attention.
  const failedTasks = taskClassRows.filter(
    (t) => t.status === 'failed' && resolveRecordClassification(t.c, projectClassification).classification === 'live',
  ).length;
  const spentMicros = await spentThisPeriodMicros(tx, ctx.projectId);
  const limitMicros = await projectSpendLimit(tx, ctx.projectId);
  const budgetExhausted = limitMicros > 0n && spentMicros >= limitMicros;

  if (failedTasks > 0) {
    findings.push({
      // A failed task is a genuine execution failure that needs a look (retry/cancel) → needs_attention.
      code: 'run_failure', dimension: 'execution', severity: 'error', entityType: 'task', entityId: null,
      title: `${failedTasks} failed task${failedTasks === 1 ? '' : 's'} need a look`,
      evidence: `${failedTasks} task(s) in status 'failed'.`,
      recommendedAction: 'Open the failed tasks and retry or cancel them.', blocksOperation: false,
    });
  }
  if (budgetExhausted) {
    findings.push({
      code: 'budget_exhausted', dimension: 'execution', severity: 'error', entityType: 'project', entityId: ctx.projectId,
      title: 'Monthly budget exhausted', evidence: `Spent ${spentMicros} of ${limitMicros} micros this period.`,
      recommendedAction: 'Raise the spend limit or pause new runs.', blocksOperation: true,
    });
  }

  // --- Workflow integrity (reuse the authoritative detectors; historical-valid never warns) ------------
  const strandedRows = await tx
    .select({ n: sql<string>`count(*)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, ctx.projectId),
        eq(tasks.orgId, ctx.orgId),
        eq(tasks.status, 'awaiting_approval'),
        sql`not exists (select 1 from ${approvals} a where a.task_id = ${tasks.id} and a.status = 'pending')`,
      ),
    );
  const stranded = Number(strandedRows[0]?.n ?? 0);
  if (stranded > 0) {
    findings.push({
      code: 'approval_state_conflict', dimension: 'workflow_integrity', severity: 'error', entityType: 'task', entityId: null,
      title: `${stranded} task${stranded === 1 ? '' : 's'} stuck awaiting approval with no pending decision`,
      evidence: `${stranded} task(s) in 'awaiting_approval' with zero pending approvals.`,
      recommendedAction: 'Reconcile the task authorization state.', blocksOperation: false,
    });
  }

  const linkReport = await detectObjectiveLinkContradictions(tx, ctx);
  const linkErrors = linkReport.findings.filter((f) => f.severity === 'error'); // historical_valid/warning excluded here
  if (linkErrors.length > 0) {
    findings.push({
      code: 'objective_link_error', dimension: 'workflow_integrity', severity: 'error', entityType: 'task', entityId: linkErrors[0]!.taskId,
      title: `${linkErrors.length} task${linkErrors.length === 1 ? '' : 's'} link to a missing or cross-workspace objective`,
      evidence: linkErrors.map((f) => `${f.taskTitle}: ${f.detail}`).join('; '),
      recommendedAction: 'Detach or move the affected tasks.', blocksOperation: false,
    });
  }

  const reconciliation = await attributionReconciliation(tx, ctx);
  if (!reconciliation.reconciles) {
    findings.push({
      code: 'employee_cost_unreconciled', dimension: 'workflow_integrity', severity: 'error', entityType: 'project', entityId: ctx.projectId,
      title: 'Employee-attributed cost does not reconcile with Governance Usage',
      evidence: 'Execution + review + workspace overhead ≠ total usage.',
      recommendedAction: 'Investigate the attribution ledger.', blocksOperation: false,
    });
  }

  for (const o of activeObjectives) {
    if (!o.accountableEmployee) {
      findings.push({
        code: 'objective_missing_owner', dimension: 'workflow_integrity', severity: 'warning', entityType: 'objective', entityId: o.id,
        title: `Active objective "${o.title}" has no accountable owner`,
        evidence: 'objectives.accountable_agent_id is null for an active objective.',
        recommendedAction: 'Assign an accountable employee.', blocksOperation: false,
      });
    }
  }

  // --- Governance: authorized-but-unexecuted actions -------------------------
  const authorizedRows = await tx
    .select({ taskId: approvals.taskId, objectiveId: tasks.objectiveId, objectiveStatus: objectives.status, n: sql<string>`count(*)` })
    .from(approvals)
    .innerJoin(tasks, eq(approvals.taskId, tasks.id))
    .leftJoin(objectives, eq(tasks.objectiveId, objectives.id))
    .where(and(eq(approvals.projectId, ctx.projectId), eq(approvals.orgId, ctx.orgId), eq(approvals.status, 'approved')))
    .groupBy(approvals.taskId, tasks.objectiveId, objectives.status);
  const authorizedTotal = authorizedRows.reduce((s, r) => s + Number(r.n), 0);
  if (authorizedTotal > 0) {
    const activeObjIds = new Set(activeObjectives.map((o) => o.id));
    const relevant = authorizedRows.some((r) => r.objectiveId && activeObjIds.has(r.objectiveId));
    findings.push({
      code: 'authorized_action_unexecuted', dimension: 'governance', severity: relevant ? 'warning' : 'info',
      entityType: 'approval', entityId: null,
      title: `${authorizedTotal} authorized action${authorizedTotal === 1 ? '' : 's'} not yet executed`,
      evidence: relevant
        ? 'Authorized approvals relate to the active objective and no eligible executor exists yet.'
        : 'Authorized approvals belong to closed/inactive objectives; no eligible executor exists (execution unavailable). Not required for the active objective.',
      recommendedAction: relevant ? 'Build/enable an executor, or withdraw the authorization if no longer wanted.' : 'No action required unless you intend to execute these.',
      blocksOperation: false, // authorized ≠ failed; never blocks unless required for a current operation
    });
  }

  // --- Outcome: primary active objective ------------------------------------
  let activeObjective: ObjectiveOutcomeMetrics | null = null;
  if (activeObjectives.length > 0) {
    const primary = activeObjectives[0]!; // listObjectives is priority-ordered
    const msRows = await tx
      .select({ status: milestones.status, n: sql<string>`count(*)` })
      .from(milestones)
      .where(and(eq(milestones.objectiveId, primary.id), eq(milestones.projectId, ctx.projectId)))
      .groupBy(milestones.status);
    const mCount = (st: string): number => Number(msRows.find((m) => m.status === st)?.n ?? 0);
    const total = msRows.reduce((s, m) => s + Number(m.n), 0);
    activeObjective = objectiveMetrics(primary, { active: mCount('active'), completed: mCount('completed'), total });

    if (!activeObjective.hasVerifiedOutcomeEvidence && activeObjective.outcomeCriteriaMet < activeObjective.outcomeCriteriaTotal) {
      findings.push({
        code: 'outcome_evidence_missing', dimension: 'outcome', severity: 'warning', entityType: 'objective', entityId: primary.id,
        title: `No verified outcome evidence for "${primary.title}" yet`,
        evidence: `${activeObjective.outcomeCriteriaMet} of ${activeObjective.outcomeCriteriaTotal} success criteria met; ${activeObjective.contributingTasksCompleted} of ${activeObjective.contributingTasksTotal} contributing tasks complete (activity, not outcome).`,
        recommendedAction: 'Capture verified evidence for the success criteria.', blocksOperation: false,
      });
    }
  } else {
    // No active objective → cannot assess momentum (an outcome-progress limit, not a platform failure).
    findings.push({
      code: 'outcome_unassessable', dimension: 'outcome', severity: 'info', entityType: null, entityId: null,
      title: 'No active objective — unable to assess momentum',
      evidence: 'Zero objectives in status active.', recommendedAction: 'Activate an objective to track outcomes.', blocksOperation: false,
    });
  }

  // --- Dimensions + overall -------------------------------------------------
  const dimensions: Record<HealthDimension, DimensionStatus> = {
    execution: 'ok', workflow_integrity: 'ok', governance: 'ok', outcome: 'ok', activity: 'ok',
  };
  for (const f of findings) {
    const cur = dimensions[f.dimension];
    const curRank = cur === 'ok' || cur === 'unknown' ? 0 : SEVERITY_RANK[cur as HealthSeverity];
    if (SEVERITY_RANK[f.severity] > curRank) dimensions[f.dimension] = f.severity;
  }

  const tasksCompleted = objectiveRows.reduce((s, o) => s + o.progress.tasksCompleted, 0);

  return {
    overall: overallFrom(findings),
    dimensions,
    findings,
    activeObjective,
    execution: { runsCompleted, runsCompletedDemo, runsCompletedSeed, runsCompletedNonLive, runsFailed, failedTasks, spentMicros, limitMicros, budgetExhausted },
    activity: { tasksCompleted, objectivesActive: activeObjectives.length },
  };
}
