import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { type DataClassification, type TenantContext } from '@/types/domain';
import { withTenant } from '@/db/tenant';
import { approvals, objectives, runs, runSteps, tasks } from '@/db/schema';
import { type ProjectAccessRecord } from '@/db/system';
import { expireStaleApprovals, reconcileStrandedApprovalTasks } from '@/domain/approvals/approvals';
import { computeInsights, type Insight } from '@/domain/insights/insights';
import { assessWorkspaceHealth, outcomeLine, type OverallHealthState } from '@/domain/health/health';
import { projectSpendLimit, spentThisPeriodMicros } from '@/domain/usage/usage';
import { type ClassificationVisibility, type ExclusionSummary, LIVE_ONLY, exclusionSummary, loadProjectClassification, resolveRecordClassification } from '@/domain/classification/classification';

/**
 * The Morning Briefing (Sprint 6, "Every Morning"): what happened, what
 * matters now, what decisions need the owner — across every workspace they
 * belong to, computed from data the platform already records.
 *
 * One withTenant transaction per workspace, honoring I1: the briefing
 * aggregates numbers ACROSS workspaces but never mixes content between them —
 * each row's detail links back into its own workspace.
 */

const OVERNIGHT_HOURS = 24;

/** A standing-work result produced while the owner was away. */
export interface PreparedItem {
  taskId: string;
  title: string;
  projectKey: string;
  status: string;
  finishedAt: Date | null;
  /** HUB-009 — effective classification (for labelling when non-live prepared items are shown). */
  classification: DataClassification;
}

export interface WorkspaceBriefing {
  projectKey: string;
  projectName: string;
  /** Standing-work results from the last 24h — the "while you were away" list. */
  prepared: PreparedItem[];
  /** HUB-009 — non-live prepared items hidden by a live-only view (0 when includeNonLive or none). */
  preparedExcluded: ExclusionSummary;
  /** HUB-009 — FULLY-separated demo vs seed briefing figures (headline fields above stay LIVE-only; demo and
   *  seed are never merged into one non-live value). */
  nonLive: {
    runsCompletedDemo: number;
    runsCompletedSeed: number;
    runsFailedDemo: number;
    runsFailedSeed: number;
    workingDemo: number;
    workingSeed: number;
    openTasksDemo: number;
    openTasksSeed: number;
    objectivesAtRiskDemo: number;
    objectivesAtRiskSeed: number;
  };
  /** Composite management insights for this workspace, ranked by consequence. */
  insights: Insight[];
  /** Decisions waiting on the owner right now. */
  pendingApprovals: number;
  oldestPendingApprovalAt: Date | null;
  /** Since-you-were-away (last 24h). */
  runsCompleted: number;
  runsFailed: number;
  /** Reviews that changed an outcome (revise/reject verdicts, last 24h). */
  reviewInterventions: number;
  /** Active objectives with no work in motion. */
  objectivesAtRisk: number;
  activeObjectives: number;
  /** Budget pressure: percent of monthly limit spent (0–100+). */
  spentPct: number;
  /** Runs executing right now. */
  workingNow: number;
  /** The SAME structured health the Dashboard shows (HUB-007) — both surfaces cannot disagree. */
  overall: OverallHealthState;
  /** The active objective's outcome line (activity vs outcome, separated), or null. */
  outcome: string | null;
}

export interface MorningBriefing {
  workspaces: WorkspaceBriefing[];
  totals: {
    pendingApprovals: number;
    runsCompleted: number;
    runsFailed: number;
    reviewInterventions: number;
    objectivesAtRisk: number;
    workingNow: number;
    /** Workspaces at or above 80% of budget. */
    budgetAlerts: number;
  };
}

export async function briefWorkspace(
  ctx: TenantContext,
  project: ProjectAccessRecord,
  visibility: ClassificationVisibility = LIVE_ONLY,
): Promise<WorkspaceBriefing> {
  return withTenant(ctx, async (tx) => {
    await expireStaleApprovals(tx, ctx); // the briefing never reports ghosts
    await reconcileStrandedApprovalTasks(tx, ctx); // a fully-decided task is never reported as a blocker

    const now = new Date();
    const since = new Date(now.getTime() - OVERNIGHT_HOURS * 60 * 60 * 1000);

    const pendingRows = await tx
      .select({
        count: sql<string>`count(*)`,
        oldest: sql<string | null>`min(${approvals.createdAt})`,
      })
      .from(approvals)
      .where(and(eq(approvals.projectId, ctx.projectId), eq(approvals.status, 'pending')));

    // ISO strings, not Date objects: raw Dates inside sql`` fragments are not
    // serialized by the driver in this position (found live: ERR_INVALID_ARG_TYPE).
    const sinceIso = since.toISOString();
    // HUB-009 — briefing headline counts are LIVE-only. Recent activity (since you were away) carries a
    // classification snapshot; demo/seed runs never inflate these numbers.
    const runRows = await tx
      .select({
        completed: sql<string>`count(*) filter (where ${runs.status} = 'completed' and ${runs.finishedAt} >= ${sinceIso} and ${runs.classification} = 'live')`,
        failed: sql<string>`count(*) filter (where ${runs.status} = 'failed' and ${runs.finishedAt} >= ${sinceIso} and ${runs.classification} = 'live')`,
        working: sql<string>`count(*) filter (where ${runs.status} = 'running' and ${runs.classification} = 'live')`,
        completedDemo: sql<string>`count(*) filter (where ${runs.status} = 'completed' and ${runs.finishedAt} >= ${sinceIso} and ${runs.classification} = 'demo')`,
        completedSeed: sql<string>`count(*) filter (where ${runs.status} = 'completed' and ${runs.finishedAt} >= ${sinceIso} and ${runs.classification} = 'seed')`,
        failedDemo: sql<string>`count(*) filter (where ${runs.status} = 'failed' and ${runs.finishedAt} >= ${sinceIso} and ${runs.classification} = 'demo')`,
        failedSeed: sql<string>`count(*) filter (where ${runs.status} = 'failed' and ${runs.finishedAt} >= ${sinceIso} and ${runs.classification} = 'seed')`,
        workingDemo: sql<string>`count(*) filter (where ${runs.status} = 'running' and ${runs.classification} = 'demo')`,
        workingSeed: sql<string>`count(*) filter (where ${runs.status} = 'running' and ${runs.classification} = 'seed')`,
      })
      .from(runs)
      .where(eq(runs.projectId, ctx.projectId));

    // Per-class open-task counts (headline stays live; these are the separated demo/seed inspection figures).
    const openTaskClassRows = await tx
      .select({ classification: tasks.classification, n: sql<string>`count(*)` })
      .from(tasks)
      .where(and(eq(tasks.projectId, ctx.projectId), inArray(tasks.status, ['pending', 'running', 'awaiting_approval'])))
      .groupBy(tasks.classification);
    const openTasksByClass = new Map(openTaskClassRows.map((r) => [r.classification, Number(r.n)]));

    const interventionRows = await tx
      .select({ count: sql<string>`count(*)` })
      .from(runSteps)
      .where(
        and(
          eq(runSteps.projectId, ctx.projectId),
          eq(runSteps.kind, 'review'),
          eq(runSteps.succeeded, true),
          gte(runSteps.createdAt, since),
          inArray(runSteps.verdict, ['revise', 'reject']),
        ),
      );

    // Active objectives with their own class + open tasks OF THAT SAME class, so at-risk is computed per class
    // (a live objective is at risk only when it has no open LIVE tasks; a demo objective per demo tasks; etc.).
    const activeObjectiveRows = await tx
      .select({
        id: objectives.id,
        classification: objectives.classification,
        tasksOpenSameClass: sql<string>`(select count(*) from ${tasks} t where t.objective_id = ${objectives.id} and t.classification = ${objectives.classification} and t.status in ('pending','running','awaiting_approval'))`,
      })
      .from(objectives)
      .where(and(eq(objectives.projectId, ctx.projectId), eq(objectives.status, 'active')));
    const atRiskOf = (cls: 'live' | 'demo' | 'seed') =>
      activeObjectiveRows.filter((o) => o.classification === cls && Number(o.tasksOpenSameClass) === 0).length;
    const objectivesAtRisk = atRiskOf('live'); // headline: live objectives only

    // Continuous Operations: what standing work produced while you were away. Live-only by default; when the
    // operator opts in, non-live prepared items are shown LABELLED (headline counts above stay live-only).
    const projectClassification = await loadProjectClassification(tx, ctx.projectId);
    const preparedAll = (await tx
      .select({
        taskId: tasks.id,
        title: tasks.title,
        status: tasks.status,
        finishedAt: runs.finishedAt,
        classification: tasks.classification,
      })
      .from(tasks)
      .leftJoin(runs, eq(runs.taskId, tasks.id))
      .where(and(eq(tasks.projectId, ctx.projectId), isNotNull(tasks.scheduleId), gte(tasks.createdAt, since)))
      .orderBy(desc(tasks.createdAt))
      .limit(20)).map((r) => ({ ...r, classification: resolveRecordClassification(r.classification, projectClassification).classification }));
    const preparedRows = (visibility.includeNonLive ? preparedAll : preparedAll.filter((r) => r.classification === 'live')).slice(0, 10);
    const preparedExcluded = exclusionSummary({
      excludedDemo: preparedAll.filter((r) => r.classification === 'demo').length,
      excludedSeed: preparedAll.filter((r) => r.classification === 'seed').length,
    });

    const spent = await spentThisPeriodMicros(tx, ctx.projectId);
    const limit = await projectSpendLimit(tx, ctx.projectId);
    const spentPct = limit > 0n ? Number((spent * 100n) / limit) : 100;

    // Management insights: composite signals, not activity counters.
    const insights = await computeInsights(tx, ctx, project.key, now);

    // The one truthful health model, shared with the Dashboard (HUB-007).
    const health = await assessWorkspaceHealth(tx, ctx);

    const pending = pendingRows[0];
    const runsAgg = runRows[0];
    return {
      projectKey: project.key,
      projectName: project.name,
      insights,
      preparedExcluded,
      nonLive: {
        runsCompletedDemo: Number(runsAgg?.completedDemo ?? 0),
        runsCompletedSeed: Number(runsAgg?.completedSeed ?? 0),
        runsFailedDemo: Number(runsAgg?.failedDemo ?? 0),
        runsFailedSeed: Number(runsAgg?.failedSeed ?? 0),
        workingDemo: Number(runsAgg?.workingDemo ?? 0),
        workingSeed: Number(runsAgg?.workingSeed ?? 0),
        openTasksDemo: openTasksByClass.get('demo') ?? 0,
        openTasksSeed: openTasksByClass.get('seed') ?? 0,
        objectivesAtRiskDemo: atRiskOf('demo'),
        objectivesAtRiskSeed: atRiskOf('seed'),
      },
      prepared: preparedRows.map((r) => ({
        taskId: r.taskId,
        title: r.title,
        projectKey: project.key,
        status: r.status,
        finishedAt: r.finishedAt,
        classification: r.classification,
      })),
      pendingApprovals: Number(pending?.count ?? 0),
      oldestPendingApprovalAt: pending?.oldest ? new Date(pending.oldest) : null,
      runsCompleted: Number(runsAgg?.completed ?? 0),
      runsFailed: Number(runsAgg?.failed ?? 0),
      reviewInterventions: Number(interventionRows[0]?.count ?? 0),
      objectivesAtRisk,
      activeObjectives: activeObjectiveRows.length,
      spentPct,
      workingNow: Number(runsAgg?.working ?? 0),
      overall: health.overall,
      outcome: health.activeObjective ? outcomeLine(health.activeObjective) : null,
    };
  });
}

export async function morningBriefing(
  userId: string,
  projects: ProjectAccessRecord[],
  orgRoleByOrg: Map<string, TenantContext['orgRole']>,
  visibility: ClassificationVisibility = LIVE_ONLY,
): Promise<MorningBriefing> {
  const workspaces: WorkspaceBriefing[] = [];
  for (const project of projects) {
    const ctx: TenantContext = {
      userId,
      orgId: project.orgId,
      projectId: project.projectId,
      orgRole: orgRoleByOrg.get(project.orgId) ?? 'member',
      projectRole: project.projectRole,
    };
    workspaces.push(await briefWorkspace(ctx, project, visibility));
  }

  // Decisions first, then trouble, then activity — executive sort order.
  workspaces.sort(
    (a, b) =>
      b.pendingApprovals - a.pendingApprovals ||
      b.runsFailed - a.runsFailed ||
      b.objectivesAtRisk - a.objectivesAtRisk ||
      b.runsCompleted - a.runsCompleted,
  );

  return {
    workspaces,
    totals: {
      pendingApprovals: workspaces.reduce((n, w) => n + w.pendingApprovals, 0),
      runsCompleted: workspaces.reduce((n, w) => n + w.runsCompleted, 0),
      runsFailed: workspaces.reduce((n, w) => n + w.runsFailed, 0),
      reviewInterventions: workspaces.reduce((n, w) => n + w.reviewInterventions, 0),
      objectivesAtRisk: workspaces.reduce((n, w) => n + w.objectivesAtRisk, 0),
      workingNow: workspaces.reduce((n, w) => n + w.workingNow, 0),
      budgetAlerts: workspaces.filter((w) => w.spentPct >= 80).length,
    },
  };
}
