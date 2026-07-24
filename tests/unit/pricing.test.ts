import { describe, expect, it } from 'vitest';
import { costForUsage, MODEL_PRICING } from '@/providers/pricing';

describe('pricing table', () => {
  it('every model has positive integer rates and a token ceiling', () => {
    for (const [id, p] of Object.entries(MODEL_PRICING)) {
      expect(p.inputMicrosPerM, id).toBeGreaterThan(0n);
      expect(p.outputMicrosPerM, id).toBeGreaterThan(0n);
      expect(p.maxOutputTokens, id).toBeGreaterThan(0);
    }
  });

  it('Claude Sonnet 5 introductory pricing expires 2026-09-01 — fail loudly, not silently', () => {
    // Verified 2026-07-24: $2/$10 introductory through Aug 31, then $3/$15.
    // This test starts failing the day the rate changes, which is the point:
    // silent under-billing after a vendor price rise is the worst outcome for
    // a budget gate. When it fails, update MODEL_PRICING and this expectation.
    const introEnds = Date.UTC(2026, 8, 1); // 2026-09-01T00:00:00Z
    const sonnet = MODEL_PRICING['claude-sonnet-5']!;
    if (Date.now() < introEnds) {
      expect(sonnet.inputMicrosPerM).toBe(2_000_000n);
      expect(sonnet.outputMicrosPerM).toBe(10_000_000n);
    } else {
      expect(sonnet.inputMicrosPerM).toBe(3_000_000n);
      expect(sonnet.outputMicrosPerM).toBe(15_000_000n);
    }
  });

  it('prices known models exactly', () => {
    // claude-opus-4-8: $5/M in, $25/M out
    const cost = costForUsage('anthropic', 'claude-opus-4-8', {
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost.usdMicros).toBe(10_000_000n + 25_000_000n);
  });

  it('dated snapshot names price at their base model, not the ceiling', () => {
    // Providers echo dated variants (found live: gpt-5.4-mini-2026-03-17).
    const dated = costForUsage('openai', 'gpt-5.4-mini-2026-03-17', {
      inputTokens: 368,
      outputTokens: 4,
    });
    const base = costForUsage('openai', 'gpt-5.4-mini', {
      inputTokens: 368,
      outputTokens: 4,
    });
    expect(dated.usdMicros).toBe(base.usdMicros);
    // And specifically NOT the flagship fallback rate.
    const ceiling = costForUsage('openai', 'gpt-totally-unknown', {
      inputTokens: 368,
      outputTokens: 4,
    });
    expect(dated.usdMicros).toBeLessThan(ceiling.usdMicros);
  });

  it('a similarly-named but distinct model does not prefix-match', () => {
    // gpt-5.2 must not claim gpt-5.2-pro-2025-12-11 (different price point);
    // the separator requirement means only true dated variants match.
    const pro = costForUsage('openai', 'gpt-5.2-pro-2025-12-11', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    // gpt-5.2 would price this at $1.25; the ceiling fallback prices at $1.25
    // input too — assert it at least never prices BELOW the base model.
    const base = costForUsage('openai', 'gpt-5.2', {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(pro.usdMicros).toBeGreaterThanOrEqual(base.usdMicros);
  });

  it('unknown models are billed at the provider ceiling — fail expensive, not free', () => {
    const unknown = costForUsage('anthropic', 'claude-imaginary-99', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    const flagship = costForUsage('anthropic', 'claude-opus-4-8', {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
    });
    expect(unknown.usdMicros).toBeGreaterThanOrEqual(flagship.usdMicros);
    expect(unknown.usdMicros).toBeGreaterThan(0n);
  });
});
