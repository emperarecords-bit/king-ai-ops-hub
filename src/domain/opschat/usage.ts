import { and, eq, gte, sql } from 'drizzle-orm';
import { type DbTx } from '@/db/client';
import { opsChatUsage } from '@/db/schema';
import { costForUsage, PRICING_VERSION } from '@/providers/pricing';
import { type ProviderId, type TokenUsage } from '@/types/provider';

/**
 * Ops Chat usage accounting. Ops Chat is per-user and spans workspaces, so its turns are recorded in
 * `ops_chat_usage` — never `usage_events`, which counts toward each workspace's monthly spend limit (a busy day
 * of chat must not block a workspace's tasks). Writes run under withUser (RLS: own rows only).
 */

/** Anthropic web search: $10 per 1,000 searches = 10,000 micro-dollars each (billed on top of tokens). */
export const WEB_SEARCH_COST_MICROS = 10_000n;

export function opsChatTurnCostMicros(provider: ProviderId, model: string, usage: TokenUsage, webSearches: number): bigint {
  const searches = Number.isFinite(webSearches) && webSearches > 0 ? BigInt(Math.floor(webSearches)) : 0n;
  return costForUsage(provider, model, usage).usdMicros + searches * WEB_SEARCH_COST_MICROS;
}

export interface OpsChatTurnUsage {
  userId: string;
  conversationId: string;
  ownerMessageId: string;
  provider: ProviderId;
  model: string;
  usage: TokenUsage;
  webSearches: number;
  stopReason: string | null;
  cutOff: boolean;
}

export async function recordOpsChatUsage(tx: DbTx, turn: OpsChatTurnUsage): Promise<{ id: string; costMicros: bigint }> {
  const costMicros = opsChatTurnCostMicros(turn.provider, turn.model, turn.usage, turn.webSearches);
  const inserted = await tx
    .insert(opsChatUsage)
    .values({
      userId: turn.userId,
      conversationId: turn.conversationId,
      ownerMessageId: turn.ownerMessageId,
      provider: turn.provider,
      model: turn.model,
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      webSearches: Math.max(0, Math.floor(turn.webSearches || 0)),
      costMicros,
      pricingVersion: PRICING_VERSION,
      stopReason: turn.stopReason,
      cutOff: turn.cutOff,
    })
    .returning({ id: opsChatUsage.id });
  return { id: inserted[0]!.id, costMicros };
}

export interface OpsChatUsageTotals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  costMicros: bigint;
}

/**
 * The user's Ops Chat totals since `since` (RLS confines the sum to their own rows); only one conversation's when
 * `conversationId` is given (that conversation's right panel).
 */
export async function opsChatUsageSince(tx: DbTx, userId: string, since: Date, conversationId?: string): Promise<OpsChatUsageTotals> {
  const rows = await tx
    .select({
      turns: sql<string>`count(*)`,
      inputTokens: sql<string>`coalesce(sum(${opsChatUsage.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${opsChatUsage.outputTokens}), 0)`,
      webSearches: sql<string>`coalesce(sum(${opsChatUsage.webSearches}), 0)`,
      costMicros: sql<string>`coalesce(sum(${opsChatUsage.costMicros}), 0)`,
    })
    .from(opsChatUsage)
    .where(
      and(
        eq(opsChatUsage.userId, userId),
        gte(opsChatUsage.createdAt, since),
        conversationId ? eq(opsChatUsage.conversationId, conversationId) : undefined,
      ),
    );
  const r = rows[0];
  return {
    turns: Number(r?.turns ?? 0),
    inputTokens: Number(r?.inputTokens ?? 0),
    outputTokens: Number(r?.outputTokens ?? 0),
    webSearches: Number(r?.webSearches ?? 0),
    costMicros: BigInt(r?.costMicros ?? '0'),
  };
}
