import { type Money, type ProviderId, type TokenUsage } from '@/types/provider';
import { usageCost } from '@/lib/money';

/**
 * Versioned pricing table. Rates are integer USD micros per MILLION tokens so
 * that arithmetic stays exact (D-004). When vendors change prices, bump
 * PRICING_VERSION and add rows — usage_events stores the version used, so
 * history remains explainable.
 *
 * Rates checked against vendor pricing pages, 2026-07.
 */

/**
 * Rates VERIFIED against the vendors' live pricing pages on 2026-07-24
 * (developers.openai.com/api/docs/pricing, platform.claude.com pricing).
 * Two corrections landed with that verification — see the model notes below.
 * usage_events store this version, so historical costs stay explainable even
 * though rows written before it were priced with the earlier, wrong table.
 */
export const PRICING_VERSION = '2026-07-24';

interface ModelPricing {
  readonly provider: ProviderId;
  readonly displayName: string;
  readonly inputMicrosPerM: bigint;
  readonly outputMicrosPerM: bigint;
  readonly maxOutputTokens: number;
}

export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = {
  // --- OpenAI --------------------------------------------------------------
  'gpt-5.2': {
    provider: 'openai',
    displayName: 'GPT-5.2',
    // DELISTED from the public pricing page as of 2026-07-24 (still callable
    // on this account). These are its last-known rates and could not be
    // re-verified — see SPRINT-10-REPORT §4 for the open decision to move the
    // flagship tier to a currently-listed model.
    inputMicrosPerM: 1_250_000n, // $1.25 / M — UNVERIFIED
    outputMicrosPerM: 10_000_000n, // $10.00 / M — UNVERIFIED
    maxOutputTokens: 65_536,
  },
  'gpt-5.4-mini': {
    provider: 'openai',
    displayName: 'GPT-5.4 mini',
    // CORRECTED 2026-07-24: was carried from the gpt-5-mini rate ($0.25/$2.00),
    // which UNDER-billed this model by 3x on input and 2.25x on output.
    inputMicrosPerM: 750_000n, // $0.75 / M — verified
    outputMicrosPerM: 4_500_000n, // $4.50 / M — verified
    maxOutputTokens: 65_536,
  },
  'gpt-5.4': {
    provider: 'openai',
    displayName: 'GPT-5.4',
    inputMicrosPerM: 2_500_000n, // $2.50 / M — verified
    outputMicrosPerM: 15_000_000n, // $15.00 / M — verified
    maxOutputTokens: 65_536,
  },
  // --- Anthropic -----------------------------------------------------------
  'claude-opus-4-8': {
    provider: 'anthropic',
    displayName: 'Claude Opus 4.8',
    inputMicrosPerM: 5_000_000n, // $5.00 / M
    outputMicrosPerM: 25_000_000n, // $25.00 / M
    maxOutputTokens: 64_000,
  },
  'claude-sonnet-5': {
    provider: 'anthropic',
    displayName: 'Claude Sonnet 5',
    // CORRECTED 2026-07-24: introductory pricing runs through 2026-08-31; the
    // table previously used the post-introductory rate and OVER-billed by 50%.
    // On 2026-09-01 these become 3_000_000n / 15_000_000n — a unit test fails
    // from that date until the change is made, so it cannot be forgotten.
    inputMicrosPerM: 2_000_000n, // $2.00 / M — verified (introductory)
    outputMicrosPerM: 10_000_000n, // $10.00 / M — verified (introductory)
    maxOutputTokens: 64_000,
  },
  'claude-haiku-4-5-20251001': {
    provider: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    inputMicrosPerM: 1_000_000n, // $1.00 / M
    outputMicrosPerM: 5_000_000n, // $5.00 / M
    maxOutputTokens: 64_000,
  },
};

export function knownModel(model: string): boolean {
  return model in MODEL_PRICING;
}

export function modelsForProvider(provider: ProviderId): ReadonlyArray<{
  id: string;
  displayName: string;
  maxOutputTokens: number;
}> {
  return Object.entries(MODEL_PRICING)
    .filter(([, p]) => p.provider === provider)
    .map(([id, p]) => ({
      id,
      displayName: p.displayName,
      maxOutputTokens: p.maxOutputTokens,
    }));
}

/**
 * Cost for a usage record. Providers echo dated snapshot names (e.g.
 * `gpt-5.4-mini-2026-03-17` for `gpt-5.4-mini`), so an exact miss falls back
 * to the longest known key that prefixes the reported name. Truly unknown
 * models are priced at the most expensive known rate for the provider —
 * over-counting an unknown model is safer for a budget gate than counting
 * zero.
 */
export function costForUsage(provider: ProviderId, model: string, usage: TokenUsage): Money {
  const pricing =
    MODEL_PRICING[model] ?? prefixMatch(provider, model) ?? mostExpensiveFor(provider);
  return usageCost(usage, pricing.inputMicrosPerM, pricing.outputMicrosPerM);
}

function prefixMatch(provider: ProviderId, model: string): ModelPricing | undefined {
  // ONLY `${id}-<date>` qualifies. A looser startsWith would let e.g.
  // gpt-5.2-pro-2025-12-11 match gpt-5.2 and UNDER-bill a pricier model —
  // the one direction a budget gate must never fail in.
  const entry = Object.entries(MODEL_PRICING).find(
    ([id, p]) =>
      p.provider === provider &&
      model.startsWith(`${id}-`) &&
      /^\d{4}-\d{2}-\d{2}$/.test(model.slice(id.length + 1)),
  );
  return entry?.[1];
}

function mostExpensiveFor(provider: ProviderId): ModelPricing {
  const candidates = Object.values(MODEL_PRICING).filter((p) => p.provider === provider);
  const max = candidates.reduce((a, b) =>
    a.outputMicrosPerM >= b.outputMicrosPerM ? a : b,
  );
  return max;
}
