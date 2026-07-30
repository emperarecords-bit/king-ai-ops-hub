import { type ProviderId } from '@/types/provider';
import { MODEL_PRICING, PRICING_VERSION } from '@/providers/pricing';
import { canonicalizeV1, hashCanonicalV1 } from '@/lib/canonical';

/**
 * P1a pricing FOUNDATION — pure helpers for an immutable, migration-seeded pricing schedule.
 *
 * This module is FOUNDATIONAL ONLY. It is NOT imported by the run dispatcher, `startRun`, `costForUsage`,
 * or any provider adapter, and it does NOT change runtime fallback behavior. It reads the authoritative
 * `MODEL_PRICING` table as the seed source and provides worst-case cost + validity helpers that a LATER,
 * separately-approved increment may wire into governance. Nothing here touches live billing.
 *
 * Unit decision (owner-approved Option A): rates are stored VERBATIM as integer USD micros per 1,000,000
 * tokens (`unit_definition = 'per_1m_tokens'`, `token_unit_size = 1_000_000`). No rebasing to per-1k.
 */

export const PRICING_UNIT_DEFINITION = 'per_1m_tokens' as const;
export const TOKEN_UNIT_SIZE = 1_000_000n;
export const PRICING_CURRENCY = 'USD' as const;

/** Source provenance: the repository's authoritative pricing version (NOT independent Hub verification). */
export const PRICING_SOURCE_VERSION = PRICING_VERSION; // '2026-07-24'
export const SEED_MIGRATION_ID = '0053_pricing_foundations' as const;

/** Stable sentinel id for the single seeded schedule (deterministic across environments). */
export const SEED_SCHEDULE_ID = 'f00d0053-0000-4000-8000-000000000001' as const;

/**
 * IMPORTANT: `PRICING_VERSION` ('2026-07-24') is the source OBSERVATION/provenance date — NOT a
 * contractual price-effective date. The repository does not state an exact effective-from instant for the
 * listed prices, so entry-level `valid_from` is seeded NULL (no known lower validity boundary). Only a
 * `valid_until` explicitly defined by the source is stored (see VALIDITY_OVERRIDES).
 */

/**
 * Models EXCLUDED from the active seeded schedule, with reason. gpt-5.2 is delisted and its rate is marked
 * UNVERIFIED / not re-verifiable in the source — seeding it as authoritative is not permitted (owner
 * decision). It remains in the runtime `MODEL_PRICING` fallback, unchanged; a future verified schedule may
 * add it. Reservations for an excluded model must fail closed (see `selectPricingEntry`).
 */
export const EXCLUDED_MODELS: Readonly<Record<string, string>> = {
  'gpt-5.2': 'delisted; rate marked UNVERIFIED / not re-verifiable in MODEL_PRICING (2026-07-24)',
};

/**
 * Per-model validity overrides. claude-sonnet-5 carries INTRODUCTORY pricing that the source states changes
 * on 2026-09-01 ("On 2026-09-01 these become 3_000_000n / 15_000_000n"). The exact UTC boundary is therefore
 * defined by the source (no inference): the introductory entry is valid on [SEED_VALID_FROM, 2026-09-01Z).
 */
const VALIDITY_OVERRIDES: Readonly<Record<string, { validUntil: string }>> = {
  'claude-sonnet-5': { validUntil: '2026-09-01T00:00:00.000Z' },
};

export interface PricingEntry {
  readonly provider: ProviderId;
  readonly model: string;
  readonly inputUnitPriceMicros: bigint;
  readonly outputUnitPriceMicros: bigint;
  readonly tokenUnitSize: bigint;
  readonly unitDefinition: string;
  readonly minChargeMicros: bigint | null;
  readonly maxOutputTokens: number;
  readonly validFrom: string | null; // NULL = no known lower validity boundary (not inferred from source date)
  readonly validUntil: string | null;
}

/** Ceil-division for non-negative integers (rounds UP; never down). */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error('denominator must be positive');
  if (numerator < 0n) throw new Error('negative token counts are not allowed');
  return (numerator + denominator - 1n) / denominator;
}

export interface WorstCaseInput {
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly inputUnitPriceMicros: bigint;
  readonly outputUnitPriceMicros: bigint;
  readonly tokenUnitSize: bigint;
  readonly minChargeMicros: bigint | null;
}

/**
 * Worst-case token cost in micros (owner-approved formula, integer + upward rounding only):
 *   input_cost  = ceil(max_input_tokens  × input_unit_price_micros  / token_unit_size)
 *   output_cost = ceil(max_output_tokens × output_unit_price_micros / token_unit_size)
 *   worst_case  = max(input_cost + output_cost, minimum_charge)   (null minimum charge ⇒ 0)
 */
export function worstCaseTokenCostMicros(p: WorstCaseInput): bigint {
  if (p.maxInputTokens < 0 || p.maxOutputTokens < 0) throw new Error('token counts must be non-negative');
  const input = ceilDiv(BigInt(p.maxInputTokens) * p.inputUnitPriceMicros, p.tokenUnitSize);
  const output = ceilDiv(BigInt(p.maxOutputTokens) * p.outputUnitPriceMicros, p.tokenUnitSize);
  const sum = input + output;
  const floor = p.minChargeMicros ?? 0n; // null minimum charge behaves as zero
  return sum > floor ? sum : floor;
}

/**
 * True iff `atIso` is within the entry's validity window `[validFrom, validUntil)`. A NULL `validFrom`
 * means no known lower boundary; a NULL `validUntil` means open-ended. Fail-closed after `validUntil`.
 */
export function isEntryValidAt(entry: Pick<PricingEntry, 'validFrom' | 'validUntil'>, atIso: string): boolean {
  const at = Date.parse(atIso);
  if (Number.isNaN(at)) throw new Error('invalid timestamp');
  if (entry.validFrom != null && at < Date.parse(entry.validFrom)) return false;
  if (entry.validUntil != null && at >= Date.parse(entry.validUntil)) return false;
  return true;
}

export class PricingLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PricingLookupError';
  }
}

/**
 * Fail-closed pricing lookup: throws if the model is absent (incl. excluded models like gpt-5.2) or if the
 * matching entry is outside its validity interval at `atIso`. Never falls back to another model or price.
 */
export function selectPricingEntry(entries: readonly PricingEntry[], provider: ProviderId, model: string, atIso: string): PricingEntry {
  const entry = entries.find((e) => e.provider === provider && e.model === model);
  if (!entry) throw new PricingLookupError(`no seeded pricing entry for ${provider}/${model} (fail closed)`);
  if (!isEntryValidAt(entry, atIso)) throw new PricingLookupError(`pricing entry for ${provider}/${model} is outside its validity interval at ${atIso}`);
  return entry;
}

/** Build the exact set of entries to seed, verbatim from `MODEL_PRICING`, excluding EXCLUDED_MODELS. */
export function buildSeedEntries(): PricingEntry[] {
  const entries: PricingEntry[] = [];
  for (const [model, p] of Object.entries(MODEL_PRICING)) {
    if (model in EXCLUDED_MODELS) continue;
    entries.push({
      provider: p.provider,
      model,
      inputUnitPriceMicros: p.inputMicrosPerM, // verbatim per-1M (no conversion)
      outputUnitPriceMicros: p.outputMicrosPerM,
      tokenUnitSize: TOKEN_UNIT_SIZE,
      unitDefinition: PRICING_UNIT_DEFINITION,
      minChargeMicros: null,
      maxOutputTokens: p.maxOutputTokens,
      validFrom: null, // source defines no effective-from instant; not inferred from the snapshot date
      validUntil: VALIDITY_OVERRIDES[model]?.validUntil ?? null,
    });
  }
  entries.sort((a, b) => `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`, 'en'));
  return entries;
}

/** Canonical schedule object used for hashing (deterministic; bigints handled by canonicalizeV1). */
export function buildCanonicalSchedule(): unknown {
  return {
    currency: PRICING_CURRENCY,
    sourcePricingVersion: PRICING_SOURCE_VERSION,
    tokenUnitSize: TOKEN_UNIT_SIZE,
    unitDefinition: PRICING_UNIT_DEFINITION,
    entries: buildSeedEntries().map((e) => ({
      provider: e.provider,
      model: e.model,
      inputUnitPriceMicros: e.inputUnitPriceMicros,
      outputUnitPriceMicros: e.outputUnitPriceMicros,
      tokenUnitSize: e.tokenUnitSize,
      unitDefinition: e.unitDefinition,
      minChargeMicros: e.minChargeMicros,
      maxOutputTokens: e.maxOutputTokens,
      validFrom: e.validFrom,
      validUntil: e.validUntil,
    })),
  };
}

/** SHA-256 (canonicalization v1) hash of the seeded schedule — the value stored as `schedule_hash`. */
export function computeSeedScheduleHash(): string {
  return hashCanonicalV1(buildCanonicalSchedule());
}

/** Canonical string form (for debugging / provenance). */
export function seedScheduleCanonicalString(): string {
  return canonicalizeV1(buildCanonicalSchedule());
}
