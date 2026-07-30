import { type ProviderId } from '@/types/provider';
import { type PricingEntry, buildSeedEntries, ceilDiv, isEntryValidAt } from '@/domain/pricing/pricing-foundation';

/**
 * M0a pricing MATCH + ESTIMATE — pure, read-only. This never overwrites the authoritative recorded cost
 * (`usage_events.cost_micros`). It produces a SEPARATE estimate of what the CURRENT verified P1a schedule
 * would price a recorded usage row at, so a report can show recorded-vs-estimated drift honestly.
 *
 * Matching is EXACT-identity only in this increment (M0a §4): same provider AND same model string, valid at
 * the row's own `created_at`. No prefix, family, snapshot, or runtime-alias inference. The alias mechanism
 * exists as a pure hook for a future, separately-reviewed amendment, but the approved map is EMPTY here, so
 * `approved_snapshot_alias` never fires. Unmatched usage keeps its recorded cost and its estimate is marked
 * unavailable — honest coverage over inflated split coverage.
 */

export type MatchState = 'exact' | 'approved_snapshot_alias' | 'unavailable';

/**
 * Approved dated-snapshot aliases: `provider/model` (as recorded on the usage row) → the canonical schedule
 * entry it may be priced against. INTENTIONALLY EMPTY for M0a. Activating any entry requires a separately
 * reviewed amendment before commit (M0a §4). Kept as a frozen Map so the resolver is testable while proving
 * nothing is active.
 */
export const APPROVED_SNAPSHOT_ALIASES: ReadonlyMap<string, { provider: ProviderId; model: string }> =
  new Map();

/** The current verified schedule the estimate uses — the immutable P1a seed (gpt-5.2 excluded by design). */
export function currentScheduleEntries(): PricingEntry[] {
  return buildSeedEntries();
}

export interface PricingMatch {
  readonly state: MatchState;
  /** The schedule entry to estimate against, or null when unavailable. */
  readonly entry: PricingEntry | null;
}

/**
 * Resolve how a recorded usage row `(provider, model)` matches the current schedule at instant `atIso`
 * (which MUST be `usage_events.created_at`). Never throws; returns `unavailable` instead of failing closed
 * because M0a keeps the row in recorded totals regardless — only the estimate is withheld.
 */
export function matchPricing(
  entries: readonly PricingEntry[],
  provider: ProviderId,
  model: string,
  atIso: string,
): PricingMatch {
  // 1) EXACT identity — provider + model string. A name match that is outside its validity window at the
  //    row's own timestamp is `unavailable` (e.g. claude-sonnet-5 at/after its cutoff), never silently priced.
  const exact = entries.find((e) => e.provider === provider && e.model === model);
  if (exact) {
    return isEntryValidAt(exact, atIso) ? { state: 'exact', entry: exact } : { state: 'unavailable', entry: null };
  }

  // 2) APPROVED snapshot alias — empty in M0a, so this branch is inert. Provider must match; a resolved
  //    alias is still validity-checked at the row timestamp.
  const alias = APPROVED_SNAPSHOT_ALIASES.get(`${provider}/${model}`);
  if (alias) {
    const target = entries.find((e) => e.provider === alias.provider && e.model === alias.model);
    if (target && isEntryValidAt(target, atIso)) return { state: 'approved_snapshot_alias', entry: target };
  }

  // 3) Anything else — unknown model, provider mismatch, expired entry, or gpt-5.2 (excluded from the seed).
  return { state: 'unavailable', entry: null };
}

export interface UsageEstimate {
  readonly inputMicros: bigint;
  readonly outputMicros: bigint;
  readonly combinedMicros: bigint;
}

/**
 * Estimate input/output/combined micros for a usage row under `entry`, using the accepted P1a CEIL-UP
 * exact-integer formula — `ceil(tokens × rate_micros_per_1m / 1_000_000)` — via the shared `ceilDiv` helper.
 * Input and output are computed INDEPENDENTLY (each ceils on its own), then summed. All arithmetic is bigint;
 * no floating-point, no `Number`, no truncation of a positive fractional micro. The estimate is never rescaled
 * to equal the recorded `cost_micros`; any difference from recorded is reported as-is.
 *
 * Consequence (intended): a positive sub-unit charge rounds UP — 1 token at 750000 micros/M estimates to 1
 * micro, not 0. This deliberately differs from the historical recorder's floor: M0a's estimate is a worst-case
 * upper bound under the current verified schedule, not a reconstruction of the historical billed value.
 */
export function estimateUsageMicros(entry: PricingEntry, inputTokens: number, outputTokens: number): UsageEstimate {
  if (!Number.isInteger(inputTokens) || inputTokens < 0) throw new Error('inputTokens must be a non-negative integer');
  if (!Number.isInteger(outputTokens) || outputTokens < 0) throw new Error('outputTokens must be a non-negative integer');
  const inputMicros = ceilDiv(BigInt(inputTokens) * entry.inputUnitPriceMicros, entry.tokenUnitSize);
  const outputMicros = ceilDiv(BigInt(outputTokens) * entry.outputUnitPriceMicros, entry.tokenUnitSize);
  return { inputMicros, outputMicros, combinedMicros: inputMicros + outputMicros };
}
