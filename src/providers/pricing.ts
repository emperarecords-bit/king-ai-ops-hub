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

export const PRICING_VERSION = '2026-07-23';

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
    inputMicrosPerM: 1_250_000n, // $1.25 / M input
    outputMicrosPerM: 10_000_000n, // $10.00 / M output
    maxOutputTokens: 65_536,
  },
  'gpt-5.4-mini': {
    provider: 'openai',
    displayName: 'GPT-5.4 mini',
    // Mini-tier list price; carried from the gpt-5-mini rate — verify against
    // the vendor pricing page (tracked as Medium debt in SPRINT-02-REPORT §6).
    inputMicrosPerM: 250_000n, // $0.25 / M
    outputMicrosPerM: 2_000_000n, // $2.00 / M
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
    inputMicrosPerM: 3_000_000n, // $3.00 / M
    outputMicrosPerM: 15_000_000n, // $15.00 / M
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
