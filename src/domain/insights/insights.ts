import { and, eq, gte, isNotNull, lt, sql } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type DbTx } from '@/db/client';
import { formatMoney } from '@/lib/money';
import {
  approvals,
  objectives,
  runSteps,
  taskSchedules,
  tasks,
  usageEvents,
} from '@/db/schema';

/**
 * Management Insights (Sprint 9).
 *
 * The distinction this module exists to honor: **activity is not progress.**
 * "12 runs completed" is activity. "Objective X has consumed $31 and closed
 * none of its criteria while Y closed four for $12" is progress — and it
 * implies an action. Every insight here therefore:
 *
 *  1. combines at least TWO dimensions (cost, quality, objective progress,
 *     review outcomes, decision latency) — single-dimension counters belong
 *     on the briefing's stat cards, not here;
 *  2. is deterministic SQL plus templated language — no model, so it cannot
 *     hallucinate and always says the same thing about the same data;
 *  3. carries `evidence`: the exact numbers behind the sentence, so any claim
 *     can be traced back to the rows that produced it;
 *  4. carries a suggested action and a link to take it.
 *
 * Severity ranks by consequence, not recency. Insights that cost money or
 * block outcomes outrank the informational.
 */

export type InsightSeverity = 'critical' | 'attention' | 'opportunity' | 'positive';

export interface Insight {
  /** Stable identity so dismissals persist across recomputation. */
  key: string;
  severity: InsightSeverity;
  /** One sentence naming what matters. Contains the figures inline. */
  headline: string;
  /** What to do about it. */
  action: string;
  href: string;
  /** The numbers behind the claim — every insight is traceable (§requirement). */
  evidence: Record<string, string | number>;
}

const SEVERITY_ORDER: Record<InsightSeverity, number> = {
  critical: 0,
  attention: 1,
  opportunity: 2,
  positive: 3,
};

const usd = (micros: bigint) => formatMoney({ usdMicros: micros });
const days = (ms: number) => Math.floor(ms / 86_400_000);

/**
 * Cost per outcome: spend joined to objectives rather than to tokens.
 * Two dimensions — money and criteria progress. The insight is the
 * DIVERGENCE between objectives, not either number alone.
 */
async function costPerOutcome(
  tx: DbTx,
  ctx: TenantContext,
  projectKey: string,
): Promise<Insight[]> {
  const rows = await tx
    .select({
      id: objectives.id,
      title: objectives.title,
      criteria: objectives.successCriteria,
      // Correlated subqueries must reference the outer table explicitly:
      // Drizzle renders ${objectives.id} unqualified, which collides with the
      // subquery's own columns.
      spentMicros: sql<string>`coalesce((
        select sum(u.cost_micros) from ${usageEvents} u
        join ${tasks} t on t.id = u.task_id
        where t.objective_id = objectives.id
      ), 0)`,
      taskCount: sql<string>`(select count(*) from ${tasks} t where t.objective_id = objectives.id)`,
    })
    .from(objectives)
    .where(and(eq(objectives.projectId, ctx.projectId), eq(objectives.status, 'active')));

  const scored = rows
    .map((r) => {
      const total = r.criteria.length;
      const met = r.criteria.filter((c) => c.status !== 'unmet').length;
      return {
        id: r.id,
        title: r.title,
        spent: BigInt(r.spentMicros),
        tasks: Number(r.taskCount),
        total,
        met,
        ratio: total === 0 ? null : met / total,
      };
    })
    .filter((r) => r.spent > 0n);

  const insights: Insight[] = [];

  // Money spent, nothing closed — the sharpest form of "activity ≠ progress".
  for (const o of scored) {
    if (o.total > 0 && o.met === 0 && o.tasks >= 2) {
      insights.push({
        key: `cost-no-progress:${o.id}`,
        severity: 'critical',
        headline: `"${o.title}" has consumed ${usd(o.spent)} across ${o.tasks} tasks without closing any of its ${o.total} success criteria.`,
        action:
          'Review whether the criteria are measurable and whether the work assigned is actually aimed at them.',
        href: `/p/${projectKey}/objectives/${o.id}`,
        evidence: {
          spent: usd(o.spent),
          tasks: o.tasks,
          criteriaMet: `0 of ${o.total}`,
        },
      });
    }
  }

  // Comparative efficiency: only meaningful with two or more funded objectives.
  const withRatio = scored.filter((o) => o.ratio != null && o.spent > 0n);
  if (withRatio.length >= 2) {
    const costPerCriterion = withRatio
      .filter((o) => o.met > 0)
      .map((o) => ({ ...o, per: Number(o.spent) / o.met }));
    if (costPerCriterion.length >= 2) {
      const sorted = [...costPerCriterion].sort((a, b) => a.per - b.per);
      const best = sorted[0]!;
      const worst = sorted[sorted.length - 1]!;
      if (worst.per >= best.per * 3) {
        insights.push({
          key: `cost-divergence:${worst.id}`,
          severity: 'attention',
          headline: `Progress on "${worst.title}" is costing ${(worst.per / best.per).toFixed(1)}× more per criterion closed than "${best.title}" (${usd(BigInt(Math.round(worst.per)))} vs ${usd(BigInt(Math.round(best.per)))}).`,
          action:
            'Compare how the two objectives are being worked — the cheaper one may have better knowledge or clearer briefs.',
          href: `/p/${projectKey}/objectives/${worst.id}`,
          evidence: {
            expensiveObjective: worst.title,
            expensivePerCriterion: usd(BigInt(Math.round(worst.per))),
            efficientObjective: best.title,
            efficientPerCriterion: usd(BigInt(Math.round(best.per))),
          },
        });
      }
    }
  }

  return insights;
}

/**
 * Stalled objectives WITH REASONS. Three dimensions: objective progress,
 * work in motion, and decision state — the reason is what makes it an
 * insight instead of a status tile.
 */
async function stalledObjectives(
  tx: DbTx,
  ctx: TenantContext,
  projectKey: string,
  now: Date,
): Promise<Insight[]> {
  const rows = await tx
    .select({
      id: objectives.id,
      title: objectives.title,
      criteria: objectives.successCriteria,
      updatedAt: objectives.updatedAt,
      openTasks: sql<string>`(select count(*) from ${tasks} t
        where t.objective_id = objectives.id
          and t.status in ('pending','running'))`,
      awaitingApproval: sql<string>`(select count(*) from ${tasks} t
        where t.objective_id = objectives.id and t.status = 'awaiting_approval')`,
      lastActivity: sql<string | null>`(select max(t.created_at) from ${tasks} t
        where t.objective_id = objectives.id)`,
      scheduleCount: sql<string>`(select count(*) from ${taskSchedules} s
        where s.objective_id = objectives.id and s.enabled = true)`,
    })
    .from(objectives)
    .where(and(eq(objectives.projectId, ctx.projectId), eq(objectives.status, 'active')));

  const insights: Insight[] = [];
  for (const r of rows) {
    const openTasks = Number(r.openTasks);
    const awaiting = Number(r.awaitingApproval);
    const schedules = Number(r.scheduleCount);
    const lastActivity = r.lastActivity ? new Date(r.lastActivity) : r.updatedAt;
    const idleDays = days(now.getTime() - lastActivity.getTime());
    const unmet = r.criteria.filter((c) => c.status === 'unmet').length;

    if (openTasks > 0) continue; // work is in motion; not stalled

    // Reason 1: blocked on the owner — the most actionable finding possible.
    if (awaiting > 0) {
      insights.push({
        key: `stalled-awaiting-you:${r.id}`,
        severity: 'critical',
        headline: `"${r.title}" is waiting on you: ${awaiting} result${awaiting === 1 ? '' : 's'} need a decision before the objective can move.`,
        action: 'Decide the pending approvals.',
        href: `/p/${projectKey}/approvals`,
        evidence: { awaitingDecisions: awaiting, unmetCriteria: unmet, idleDays },
        });
      continue;
    }

    // Reason 2: nothing assigned and nothing recurring — genuinely abandoned.
    if (idleDays >= 3 && unmet > 0) {
      insights.push({
        key: `stalled-no-work:${r.id}`,
        severity: 'attention',
        headline: `"${r.title}" has had no work for ${idleDays} days with ${unmet} criteri${unmet === 1 ? 'on' : 'a'} still open${schedules === 0 ? ' and nothing recurring assigned' : ''}.`,
        action:
          schedules === 0
            ? 'Assign work toward it, or set up standing work so it progresses without you.'
            : 'Check whether the standing work is actually advancing the criteria.',
        href: `/p/${projectKey}/objectives/${r.id}`,
        evidence: { idleDays, unmetCriteria: unmet, activeSchedules: schedules },
      });
    }
  }
  return insights;
}

/**
 * Decision latency: how long results wait on the owner, and what that costs
 * in blocked outcomes. Two dimensions — time and blocked progress.
 */
async function decisionLatency(
  tx: DbTx,
  ctx: TenantContext,
  projectKey: string,
  now: Date,
): Promise<Insight[]> {
  const decided = await tx
    .select({
      medianHours: sql<string | null>`percentile_cont(0.5) within group (
        order by extract(epoch from (${approvals.decidedAt} - ${approvals.createdAt})) / 3600.0)`,
      count: sql<string>`count(*)`,
    })
    .from(approvals)
    .where(
      and(
        eq(approvals.projectId, ctx.projectId),
        isNotNull(approvals.decidedAt),
        gte(approvals.createdAt, new Date(now.getTime() - 30 * 86_400_000)),
      ),
    );

  const expiredRows = await tx
    .select({ count: sql<string>`count(*)` })
    .from(approvals)
    .where(
      and(
        eq(approvals.projectId, ctx.projectId),
        eq(approvals.status, 'expired'),
        gte(approvals.createdAt, new Date(now.getTime() - 30 * 86_400_000)),
      ),
    );

  const oldestPending = await tx
    .select({ oldest: sql<string | null>`min(${approvals.createdAt})`, count: sql<string>`count(*)` })
    .from(approvals)
    .where(and(eq(approvals.projectId, ctx.projectId), eq(approvals.status, 'pending')));

  const insights: Insight[] = [];
  const expired = Number(expiredRows[0]?.count ?? 0);
  const decidedCount = Number(decided[0]?.count ?? 0);
  const median = decided[0]?.medianHours ? Number(decided[0].medianHours) : null;

  // Work bought and then wasted — cost and latency combined.
  if (expired > 0) {
    insights.push({
      key: 'decision-expired',
      severity: 'critical',
      headline: `${expired} proposed action${expired === 1 ? '' : 's'} expired undecided in the last 30 days — work you paid for that produced nothing.`,
      action: 'Decide approvals within their 24-hour window, or extend the window if it is too short.',
      href: `/p/${projectKey}/approvals`,
      evidence: { expiredApprovals: expired, decidedApprovals: decidedCount },
    });
  }

  const pendingCount = Number(oldestPending[0]?.count ?? 0);
  const oldest = oldestPending[0]?.oldest ? new Date(oldestPending[0].oldest) : null;
  if (oldest && days(now.getTime() - oldest.getTime()) >= 1) {
    insights.push({
      key: 'decision-aging',
      severity: 'attention',
      headline: `${pendingCount} decision${pendingCount === 1 ? '' : 's'} ${pendingCount === 1 ? 'has' : 'have'} been waiting up to ${days(now.getTime() - oldest.getTime())} day(s); approvals expire after one.`,
      action: 'Clear the queue before the window closes.',
      href: `/p/${projectKey}/approvals`,
      evidence: {
        pending: pendingCount,
        oldestAgeDays: days(now.getTime() - oldest.getTime()),
        medianDecisionHours: median != null ? median.toFixed(1) : 'n/a',
      },
    });
  } else if (median != null && decidedCount >= 3 && median <= 4) {
    insights.push({
      key: 'decision-fast',
      severity: 'positive',
      headline: `You are not the bottleneck: ${decidedCount} decisions in 30 days with a median turnaround of ${median.toFixed(1)} hours.`,
      action: 'No action needed — this is the number to protect as volume grows.',
      href: `/p/${projectKey}/approvals`,
      evidence: { decisions: decidedCount, medianHours: median.toFixed(1) },
    });
  }

  return insights;
}

/**
 * Review leverage: quality signal joined to cost. Names where the
 * cross-check is earning its keep and where it is not — with the money.
 */
async function reviewLeverage(
  tx: DbTx,
  ctx: TenantContext,
  projectKey: string,
  now: Date,
): Promise<Insight[]> {
  const since = new Date(now.getTime() - 30 * 86_400_000);
  const rows = await tx
    .select({
      reviews: sql<string>`count(*) filter (where ${runSteps.kind} = 'review' and ${runSteps.succeeded})`,
      interventions: sql<string>`count(*) filter (where ${runSteps.kind} = 'review' and ${runSteps.succeeded} and ${runSteps.verdict} in ('revise','reject'))`,
      reviewCost: sql<string>`coalesce(sum(${usageEvents.costMicros}) filter (where ${runSteps.kind} = 'review'), 0)`,
      totalCost: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)`,
    })
    .from(runSteps)
    .leftJoin(usageEvents, eq(usageEvents.runStepId, runSteps.id))
    .where(and(eq(runSteps.projectId, ctx.projectId), gte(runSteps.createdAt, since)));

  const r = rows[0];
  const reviews = Number(r?.reviews ?? 0);
  if (reviews < 5) return []; // not enough history to claim anything honestly

  const interventions = Number(r?.interventions ?? 0);
  const reviewCost = BigInt(r?.reviewCost ?? '0');
  const totalCost = BigInt(r?.totalCost ?? '0');
  const rate = interventions / reviews;
  const sharePct = totalCost > 0n ? Number((reviewCost * 100n) / totalCost) : 0;

  if (rate <= 0.05 && sharePct >= 30) {
    return [
      {
        key: 'review-low-leverage',
        severity: 'opportunity',
        headline: `Cross-checking changed only ${Math.round(rate * 100)}% of ${reviews} results but accounts for ${sharePct}% of spend (${usd(reviewCost)}) — it is not earning its keep on this work.`,
        action:
          'Consider turning cross-check off for routine tasks here, keeping it for architecture, security, and anything consequential.',
        href: `/p/${projectKey}/usage`,
        evidence: {
          reviews,
          interventions,
          interventionRate: `${Math.round(rate * 100)}%`,
          reviewSpend: usd(reviewCost),
          shareOfSpend: `${sharePct}%`,
        },
      },
    ];
  }

  if (rate >= 0.3) {
    return [
      {
        key: 'review-high-leverage',
        severity: 'attention',
        headline: `Cross-checking changed ${Math.round(rate * 100)}% of ${reviews} results here — the first answer is wrong often enough to be worth reading the reviews.`,
        action:
          'Look at what reviewers are catching; the pattern usually points at missing company knowledge.',
        href: `/p/${projectKey}/knowledge`,
        evidence: {
          reviews,
          interventions,
          interventionRate: `${Math.round(rate * 100)}%`,
          reviewSpend: usd(reviewCost),
        },
      },
    ];
  }

  return [];
}

/**
 * Standing work leverage: does unattended output actually get read and
 * decided, or is it spending quietly? Cost + decision behavior.
 */
async function standingWorkValue(
  tx: DbTx,
  ctx: TenantContext,
  projectKey: string,
  now: Date,
): Promise<Insight[]> {
  const since = new Date(now.getTime() - 14 * 86_400_000);
  const rows = await tx
    .select({
      produced: sql<string>`count(distinct ${tasks.id})`,
      spent: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)`,
    })
    .from(tasks)
    .leftJoin(usageEvents, eq(usageEvents.taskId, tasks.id))
    .where(
      and(
        eq(tasks.projectId, ctx.projectId),
        isNotNull(tasks.scheduleId),
        gte(tasks.createdAt, since),
      ),
    );

  const produced = Number(rows[0]?.produced ?? 0);
  if (produced < 3) return [];

  const stale = await tx
    .select({ count: sql<string>`count(*)` })
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, ctx.projectId),
        isNotNull(tasks.scheduleId),
        eq(tasks.status, 'awaiting_approval'),
        lt(tasks.createdAt, new Date(now.getTime() - 3 * 86_400_000)),
      ),
    );
  const ignored = Number(stale[0]?.count ?? 0);
  if (ignored < 2) return [];

  return [
    {
      key: 'standing-work-ignored',
      severity: 'opportunity',
      headline: `Standing work produced ${produced} results in 14 days, but ${ignored} have sat undecided for over 3 days (${usd(BigInt(rows[0]?.spent ?? '0'))} spent).`,
      action: 'Either act on this recurring output or reduce its cadence — unread output is pure cost.',
      href: `/p/${projectKey}/approvals`,
      evidence: { produced, ignoredOver3Days: ignored, spend: usd(BigInt(rows[0]?.spent ?? '0')) },
    },
  ];
}

/**
 * Computes every insight for a workspace, ranked by consequence.
 * Deterministic: same data in, same sentences out.
 */
export async function computeInsights(
  tx: DbTx,
  ctx: TenantContext,
  projectKey: string,
  now = new Date(),
): Promise<Insight[]> {
  const all = [
    ...(await costPerOutcome(tx, ctx, projectKey)),
    ...(await stalledObjectives(tx, ctx, projectKey, now)),
    ...(await decisionLatency(tx, ctx, projectKey, now)),
    ...(await reviewLeverage(tx, ctx, projectKey, now)),
    ...(await standingWorkValue(tx, ctx, projectKey, now)),
  ];

  return all.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
