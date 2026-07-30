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

  it('estimate uses the same floor arithmetic as the recorder (per-1M)', () => {
    const mini = entries.find((e) => e.model === 'gpt-5.4-mini')!;
    // 1,000,000 in + 1,000,000 out → 750000 + 4500000
    const est = estimateUsageMicros(mini, 1_000_000, 1_000_000);
    expect(est.inputMicros).toBe(750_000n);
    expect(est.outputMicros).toBe(4_500_000n);
    expect(est.combinedMicros).toBe(5_250_000n);
    // sub-unit rounds DOWN (floor), matching costForTokens: 1 token * 750000 / 1_000_000 = 0
    expect(estimateUsageMicros(mini, 1, 0).inputMicros).toBe(0n);
  });

  it('estimate rejects non-integer / negative token counts', () => {
    const mini = entries.find((e) => e.model === 'gpt-5.4-mini')!;
    expect(() => estimateUsageMicros(mini, -1, 0)).toThrow();
    expect(() => estimateUsageMicros(mini, 1.5, 0)).toThrow();
  });
});
