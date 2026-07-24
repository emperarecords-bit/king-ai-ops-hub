import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { agents, departments, objectives, runs, runSteps, usageEvents } from '@/db/schema';
import { currentPeriodStart } from '@/domain/usage/usage';

/**
 * Per-employee derived metrics (Sprint 4 P2). Everything here is a READ over
 * data the run path already records — run_steps for work and verdicts,
 * usage_events for cost, objectives for accountability. No new write paths.
 */

export interface EmployeeStats {
  agentId: string;
  departmentName: string | null;
  /** Successful model-call steps this period (primary + review + revision). */
  workDone: number;
  /** As reviewer this period: how often they changed the outcome. */
  reviewsGiven: number;
  interventions: number; // revise + reject
  /** Cost of this employee's steps this period, USD micros. */
  costMicros: bigint;
  /** Runs currently executing where this employee is primary or reviewer. */
  activeRuns: number;
  /** Active objectives this employee is accountable for. */
  accountableObjectives: string[];
  lastActiveAt: Date | null;
}

export async function employeeStats(
  tx: DbTx,
  ctx: TenantContext,
): Promise<Map<string, EmployeeStats>> {
  const periodStart = currentPeriodStart();

  const agentRows = await tx
    .select({ id: agents.id, departmentName: departments.name })
    .from(agents)
    .leftJoin(departments, eq(agents.departmentId, departments.id))
    .where(and(eq(agents.projectId, ctx.projectId), eq(agents.orgId, ctx.orgId)));
  if (agentRows.length === 0) return new Map();
  const ids = agentRows.map((a) => a.id);

  const stepStats = await tx
    .select({
      agentId: runSteps.agentId,
      workDone: sql<string>`count(*) filter (where ${runSteps.succeeded})`,
      reviewsGiven: sql<string>`count(*) filter (where ${runSteps.kind} = 'review' and ${runSteps.succeeded})`,
      interventions: sql<string>`count(*) filter (where ${runSteps.kind} = 'review' and ${runSteps.succeeded} and ${runSteps.verdict} in ('revise','reject'))`,
      lastActiveAt: sql<string | null>`max(${runSteps.createdAt})`,
    })
    .from(runSteps)
    .where(
      and(
        eq(runSteps.projectId, ctx.projectId),
        inArray(runSteps.agentId, ids),
        gte(runSteps.createdAt, periodStart),
      ),
    )
    .groupBy(runSteps.agentId);

  const costRows = await tx
    .select({
      agentId: runSteps.agentId,
      costMicros: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)`,
    })
    .from(usageEvents)
    .innerJoin(runSteps, eq(usageEvents.runStepId, runSteps.id))
    .where(
      and(
        eq(usageEvents.projectId, ctx.projectId),
        inArray(runSteps.agentId, ids),
        gte(usageEvents.createdAt, periodStart),
      ),
    )
    .groupBy(runSteps.agentId);

  const activeRows = await tx
    .select({
      primaryAgentId: runs.primaryAgentId,
      reviewerAgentId: runs.reviewerAgentId,
    })
    .from(runs)
    .where(and(eq(runs.projectId, ctx.projectId), eq(runs.status, 'running')));

  const objectiveRows = await tx
    .select({ agentId: objectives.accountableAgentId, title: objectives.title })
    .from(objectives)
    .where(
      and(
        eq(objectives.projectId, ctx.projectId),
        eq(objectives.status, 'active'),
        inArray(objectives.accountableAgentId, ids),
      ),
    );

  const stepMap = new Map(stepStats.map((s) => [s.agentId, s]));
  const costMap = new Map(costRows.map((c) => [c.agentId, c]));

  const out = new Map<string, EmployeeStats>();
  for (const a of agentRows) {
    const s = stepMap.get(a.id);
    out.set(a.id, {
      agentId: a.id,
      departmentName: a.departmentName,
      workDone: Number(s?.workDone ?? 0),
      reviewsGiven: Number(s?.reviewsGiven ?? 0),
      interventions: Number(s?.interventions ?? 0),
      costMicros: BigInt(costMap.get(a.id)?.costMicros ?? '0'),
      activeRuns: activeRows.filter(
        (r) => r.primaryAgentId === a.id || r.reviewerAgentId === a.id,
      ).length,
      accountableObjectives: objectiveRows.filter((o) => o.agentId === a.id).map((o) => o.title),
      lastActiveAt: s?.lastActiveAt ? new Date(s.lastActiveAt) : null,
    });
  }
  return out;
}
