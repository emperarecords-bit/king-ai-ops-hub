import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { withTenant } from '@/db/tenant';
import { approvals, objectives, runs, runSteps, tasks } from '@/db/schema';
import { type ProjectAccessRecord } from '@/db/system';
import { expireStaleApprovals } from '@/domain/approvals/approvals';
import { projectSpendLimit, spentThisPeriodMicros } from '@/domain/usage/usage';

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
}

export interface WorkspaceBriefing {
  projectKey: string;
  projectName: string;
  /** Standing-work results from the last 24h — the "while you were away" list. */
  prepared: PreparedItem[];
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

async function briefWorkspace(
  ctx: TenantContext,
  project: ProjectAccessRecord,
): Promise<WorkspaceBriefing> {
  return withTenant(ctx, async (tx) => {
    await expireStaleApprovals(tx, ctx); // the briefing never reports ghosts

    const since = new Date(Date.now() - OVERNIGHT_HOURS * 60 * 60 * 1000);

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
    const runRows = await tx
      .select({
        completed: sql<string>`count(*) filter (where ${runs.status} = 'completed' and ${runs.finishedAt} >= ${sinceIso})`,
        failed: sql<string>`count(*) filter (where ${runs.status} = 'failed' and ${runs.finishedAt} >= ${sinceIso})`,
        working: sql<string>`count(*) filter (where ${runs.status} = 'running')`,
      })
      .from(runs)
      .where(eq(runs.projectId, ctx.projectId));

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

    const activeObjectiveRows = await tx
      .select({
        id: objectives.id,
        tasksTotal: sql<string>`(select count(*) from ${tasks} t where t.objective_id = ${objectives.id})`,
        tasksOpen: sql<string>`(select count(*) from ${tasks} t where t.objective_id = ${objectives.id} and t.status in ('pending','running','awaiting_approval'))`,
      })
      .from(objectives)
      .where(and(eq(objectives.projectId, ctx.projectId), eq(objectives.status, 'active')));
    const objectivesAtRisk = activeObjectiveRows.filter((o) => Number(o.tasksOpen) === 0).length;

    // Continuous Operations: what standing work produced while you were away.
    const preparedRows = await tx
      .select({
        taskId: tasks.id,
        title: tasks.title,
        status: tasks.status,
        finishedAt: runs.finishedAt,
      })
      .from(tasks)
      .leftJoin(runs, eq(runs.taskId, tasks.id))
      .where(
        and(
          eq(tasks.projectId, ctx.projectId),
          isNotNull(tasks.scheduleId),
          gte(tasks.createdAt, since),
        ),
      )
      .orderBy(desc(tasks.createdAt))
      .limit(10);

    const spent = await spentThisPeriodMicros(tx, ctx.projectId);
    const limit = await projectSpendLimit(tx, ctx.projectId);
    const spentPct = limit > 0n ? Number((spent * 100n) / limit) : 100;

    const pending = pendingRows[0];
    const runsAgg = runRows[0];
    return {
      projectKey: project.key,
      projectName: project.name,
      prepared: preparedRows.map((r) => ({
        taskId: r.taskId,
        title: r.title,
        projectKey: project.key,
        status: r.status,
        finishedAt: r.finishedAt,
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
    };
  });
}

export async function morningBriefing(
  userId: string,
  projects: ProjectAccessRecord[],
  orgRoleByOrg: Map<string, TenantContext['orgRole']>,
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
    workspaces.push(await briefWorkspace(ctx, project));
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
