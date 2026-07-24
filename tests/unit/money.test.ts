import { describe, expect, it } from 'vitest';
import { costForTokens, formatMoney, usageCost } from '@/lib/money';

describe('costForTokens', () => {
  it('computes exact integer costs', () => {
    // 1M tokens at $2.50/M = 2_500_000 micros
    expect(costForTokens(1_000_000, 2_500_000n)).toBe(2_500_000n);
    // 1 token at $2.50/M = 2.5 micros → floors to 2
    expect(costForTokens(1, 2_500_000n)).toBe(2n);
    expect(costForTokens(0, 2_500_000n)).toBe(0n);
  });

  it('never drifts across accumulation the way floats do', () => {
    // 10k additions of a tiny cost stay exact.
    let total = 0n;
    for (let i = 0; i < 10_000; i += 1) {
      total += costForTokens(37, 1_250_000n);
    }
    expect(total).toBe(BigInt(10_000) * ((37n * 1_250_000n) / 1_000_000n));
  });

  it('rejects negative and fractional token counts', () => {
    expect(() => costForTokens(-1, 1n)).toThrow();
    expect(() => costForTokens(1.5, 1n)).toThrow();
  });
});

describe('usageCost', () => {
  it('sums input and output at their separate rates', () => {
    const cost = usageCost(
      { inputTokens: 1_000_000, outputTokens: 500_000 },
      1_250_000n,
      10_000_000n,
    );
    expect(cost.usdMicros).toBe(1_250_000n + 5_000_000n);
  });
});

describe('formatMoney', () => {
  it('formats whole dollars with two decimals', () => {
    expect(formatMoney({ usdMicros: 25_000_000n })).toBe('$25.00');
  });
  it('keeps four decimals for sub-cent values', () => {
    expect(formatMoney({ usdMicros: 12_500n })).toBe('$0.0125');
  });
  it('handles negatives', () => {
    expect(formatMoney({ usdMicros: -1_500_000n })).toBe('-$1.50');
  });
});
