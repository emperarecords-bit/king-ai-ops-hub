import { and, eq, gte, sql } from 'drizzle-orm';
import { type TenantContext } from '@/types/domain';
import { type ProviderId, type TokenUsage } from '@/types/provider';
import { BudgetExceededError } from '@/lib/errors';
import { type DbTx } from '@/db/client';
import { spendLimits, usageEvents } from '@/db/schema';
import { costForUsage, PRICING_VERSION } from '@/providers/pricing';

/**
 * Usage accounting and the spend gate (invariant I8). Costs are computed at
 * write time against the versioned pricing table and stored as integer micros,
 * with the version recorded so history stays explainable after price changes.
 */

export function currentPeriodStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function recordUsage(
  tx: DbTx,
  ctx: Pick<TenantContext, 'orgId' | 'projectId'>,
  args: {
    taskId: string | null;
    runId: string | null;
    runStepId: string | null;
    provider: ProviderId;
    model: string;
    usage: TokenUsage;
  },
): Promise<bigint> {
  const cost = costForUsage(args.provider, args.model, args.usage);
  await tx.insert(usageEvents).values({
    orgId: ctx.orgId,
    projectId: ctx.projectId,
    taskId: args.taskId,
    runId: args.runId,
    runStepId: args.runStepId,
    provider: args.provider,
    model: args.model,
    inputTokens: args.usage.inputTokens,
    outputTokens: args.usage.outputTokens,
    costMicros: cost.usdMicros,
    pricingVersion: PRICING_VERSION,
  });
  return cost.usdMicros;
}

export async function spentThisPeriodMicros(tx: DbTx, projectId: string): Promise<bigint> {
  const rows = await tx
    .select({
      total: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)`,
    })
    .from(usageEvents)
    .where(
      and(eq(usageEvents.projectId, projectId), gte(usageEvents.createdAt, currentPeriodStart())),
    );
  return BigInt(rows[0]?.total ?? '0');
}

/**
 * The pre-flight budget gate: refuses BEFORE the first token is bought.
 * A project with no spend_limits row gets no free pass — the seed always
 * creates one; a missing row here means misconfiguration, so we fail closed
 * with a zero budget.
 */
export async function assertWithinBudget(tx: DbTx, projectId: string): Promise<void> {
  const limitRows = await tx
    .select({ limit: spendLimits.monthlyLimitMicros })
    .from(spendLimits)
    .where(eq(spendLimits.projectId, projectId))
    .limit(1);

  const limit = limitRows[0]?.limit ?? 0n;
  const spent = await spentThisPeriodMicros(tx, projectId);
  if (spent >= limit) {
    throw new BudgetExceededError(limit, spent);
  }
}

export interface UsageSummaryRow {
  provider: ProviderId;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: bigint;
  events: number;
}

export async function usageSummary(tx: DbTx, projectId: string): Promise<UsageSummaryRow[]> {
  const rows = await tx
    .select({
      provider: usageEvents.provider,
      model: usageEvents.model,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      costMicros: sql<string>`coalesce(sum(${usageEvents.costMicros}), 0)`,
      events: sql<string>`count(*)`,
    })
    .from(usageEvents)
    .where(
      and(eq(usageEvents.projectId, projectId), gte(usageEvents.createdAt, currentPeriodStart())),
    )
    .groupBy(usageEvents.provider, usageEvents.model);

  return rows.map((r) => ({
    provider: r.provider,
    model: r.model,
    inputTokens: Number(r.inputTokens),
    outputTokens: Number(r.outputTokens),
    costMicros: BigInt(r.costMicros),
    events: Number(r.events),
  }));
}

export async function projectSpendLimit(tx: DbTx, projectId: string): Promise<bigint> {
  const rows = await tx
    .select({ limit: spendLimits.monthlyLimitMicros })
    .from(spendLimits)
    .where(eq(spendLimits.projectId, projectId))
    .limit(1);
  return rows[0]?.limit ?? 0n;
}
