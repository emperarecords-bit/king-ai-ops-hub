import { describe, expect, it } from 'vitest';
import { toJsonSafe } from '@/domain/reporting/serialize';

describe('M0a bigint serialization boundary', () => {
  it('native JSON.stringify throws on a bigint (documents why toJsonSafe exists)', () => {
    expect(() => JSON.stringify({ cost: 5n })).toThrow(TypeError);
  });

  it('toJsonSafe converts every bigint to an exact decimal string with no precision loss', () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1 — NOT exactly representable as a JS number
    const report = {
      recordedCostMicros: huge,
      rows: [
        { model: 'gpt-5.4-mini', estimatedInputCostMicros: 750_001n, estimatedOutputCostMicros: 0n },
      ],
      coverage: { estimatedDifferenceMicros: -3n, estimatedEventCoverageBps: 560, model: null },
      nested: [[{ x: 1n }]],
    };
    const safe = toJsonSafe(report);

    // JSON round-trips without throwing and without a bigint anywhere.
    const json = JSON.stringify(safe);
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json.includes('n}')).toBe(false);

    // Exact values preserved as decimal strings — and the huge value survives (Number would corrupt it).
    expect(safe.recordedCostMicros).toBe('9007199254740993');
    expect(BigInt(safe.recordedCostMicros)).toBe(huge);
    // proof of precision loss: routing the exact string through Number and back changes it.
    expect(String(Number(safe.recordedCostMicros))).not.toBe(safe.recordedCostMicros);
    expect(safe.rows[0]!.estimatedInputCostMicros).toBe('750001');
    expect(safe.coverage.estimatedDifferenceMicros).toBe('-3');
    // non-bigint values pass through unchanged
    expect(safe.coverage.estimatedEventCoverageBps).toBe(560);
    expect(safe.coverage.model).toBeNull();
    expect(safe.nested[0]![0]!.x).toBe('1');
  });
});
