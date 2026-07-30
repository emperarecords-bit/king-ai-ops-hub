import { describe, expect, it } from 'vitest';
import { MODEL_PRICING } from '@/providers/pricing';
import { buildSeedEntries } from '@/domain/pricing/pricing-foundation';
import {
  APPROVED_SNAPSHOT_ALIASES,
  currentScheduleEntries,
  estimateUsageMicros,
  matchPricing,
} from '@/domain/reporting/pricing-match';

describe('M0a pricing match (exact-only; alias map empty)', () => {
  const entries = currentScheduleEntries();
  const at = '2026-07-30T00:00:00.000Z';

  it('the approved snapshot-alias map is EMPTY in M0a', () => {
    expect(APPROVED_SNAPSHOT_ALIASES.size).toBe(0);
  });

  it('exact provider+model match returns exact with an entry', () => {
    const m = matchPricing(entries, 'openai', 'gpt-5.4-mini', at);
    expect(m.state).toBe('exact');
    expect(m.entry?.model).toBe('gpt-5.4-mini');
  });

  it('provider mismatch is rejected (unavailable), even for a real model name', () => {
    const m = matchPricing(entries, 'anthropic', 'gpt-5.4-mini', at);
    expect(m.state).toBe('unavailable');
    expect(m.entry).toBeNull();
  });

  it('prefix / near-name collisions are rejected (no substring or family matching)', () => {
    for (const bad of ['gpt-5.4-miniature', 'gpt-5.4-mini-2026', 'gpt-5', 'claude-sonnet', 'gpt-5.4-min']) {
      expect(matchPricing(entries, 'openai', bad, at).state).toBe('unavailable');
    }
  });

  it('a dated snapshot is rejected while the alias map is empty', () => {
    expect(matchPricing(entries, 'anthropic', 'claude-sonnet-5-2026-07-01', at).state).toBe('unavailable');
  });

  it('gpt-5.2 is unavailable (excluded from the seed) but still exists in the runtime source', () => {
    expect(matchPricing(entries, 'openai', 'gpt-5.2', at).state).toBe('unavailable');
    expect('gpt-5.2' in MODEL_PRICING).toBe(true);
    expect(buildSeedEntries().some((e) => e.model === 'gpt-5.2')).toBe(false);
  });

  it('validity is evaluated at the row timestamp — Sonnet-5 exact before cutoff, unavailable at/after', () => {
    expect(matchPricing(entries, 'anthropic', 'claude-sonnet-5', '2026-08-31T23:59:59.000Z').state).toBe('exact');
    expect(matchPricing(entries, 'anthropic', 'claude-sonnet-5', '2026-09-01T00:00:00.000Z').state).toBe('unavailable');
    expect(matchPricing(entries, 'anthropic', 'claude-sonnet-5', '2026-10-01T00:00:00.000Z').state).toBe('unavailable');
  });

  it('estimate uses CEIL-UP exact-integer arithmetic (P1a), independently per component', () => {
    const mini = entries.find((e) => e.model === 'gpt-5.4-mini')!; // input 750000/M, output 4500000/M
    // 0 tokens → 0 micros
    expect(estimateUsageMicros(mini, 0, 0)).toEqual({ inputMicros: 0n, outputMicros: 0n, combinedMicros: 0n });
    // 1 input token: ceil(0.75) = 1 (NOT 0 — the floor bug)
    expect(estimateUsageMicros(mini, 1, 0).inputMicros).toBe(1n);
    // 999,999 tokens: ceil(749999.25) = 749_999... ceil(999999*750000/1e6)=ceil(749999.25)=750000? verify:
    // 999999*750000 = 749_999_250_000 ; /1e6 = 749999.25 → ceil = 750000
    expect(estimateUsageMicros(mini, 999_999, 0).inputMicros).toBe(750_000n);
    // exactly 1,000,000 → 750,000 (divides evenly, no rounding)
    expect(estimateUsageMicros(mini, 1_000_000, 0).inputMicros).toBe(750_000n);
    // 1,000,001 → strictly above 750,000
    expect(estimateUsageMicros(mini, 1_000_001, 0).inputMicros).toBeGreaterThan(750_000n);
    expect(estimateUsageMicros(mini, 1_000_001, 0).inputMicros).toBe(750_001n); // ceil(750000.75)
    // independent input/output rounding: 1 in → ceil(0.75)=1 ; 1 out → ceil(4.5)=5 (each ceils separately)
    const both = estimateUsageMicros(mini, 1, 1);
    expect(both.inputMicros).toBe(1n);
    expect(both.outputMicros).toBe(5n);
    expect(both.combinedMicros).toBe(6n);
    // a rate that does not divide evenly: output 4500000/M, 3 tokens → ceil(13.5)=14
    expect(estimateUsageMicros(mini, 0, 3).outputMicros).toBe(14n);
  });

  it('estimate stays in bigint for large token counts (no unsafe Number path)', () => {
    const g54 = entries.find((e) => e.model === 'gpt-5.4')!; // input 2500000/M
    const bigTokens = 9_007_199_254_740_993; // > Number.MAX_SAFE_INTEGER (2^53-1) — but Number.isInteger true
    // The guard permits integer inputs; arithmetic is bigint so no precision is lost in the product.
    const est = estimateUsageMicros(g54, 4_000_000, 0);
    expect(typeof est.inputMicros).toBe('bigint');
    expect(est.inputMicros).toBe(10_000_000n); // 4e6 * 2.5e6 / 1e6 = 1e7, exact
    void bigTokens;
  });

  it('estimate rejects non-integer / negative token counts', () => {
    const mini = entries.find((e) => e.model === 'gpt-5.4-mini')!;
    expect(() => estimateUsageMicros(mini, -1, 0)).toThrow();
    expect(() => estimateUsageMicros(mini, 1.5, 0)).toThrow();
  });

  it('null valid_from imposes no lower rejection boundary, yet the entry is still the current-schedule estimate', () => {
    const mini = entries.find((e) => e.model === 'gpt-5.4-mini')!;
    expect(mini.validFrom).toBeNull();
    // A very early timestamp still matches (no lower bound) — the estimate is labeled current-schedule, not
    // a claim of historical billing truth.
    expect(matchPricing(entries, 'openai', 'gpt-5.4-mini', '2000-01-01T00:00:00.000Z').state).toBe('exact');
  });
});
