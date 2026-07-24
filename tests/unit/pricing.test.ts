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

  it('prices known models exactly', () => {
    // claude-opus-4-8: $5/M in, $25/M out
    const cost = costForUsage('anthropic', 'claude-opus-4-8', {
      inputTokens: 2_000_000,
      outputTokens: 1_000_000,
    });
    expect(cost.usdMicros).toBe(10_000_000n + 25_000_000n);
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
