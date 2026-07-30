import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatMicros2dp, formatMicrosExact } from '@/domain/reporting/format-money';

describe('M0a exact monetary formatter (bigint-only, no Number)', () => {
  it('formats the required cases with exact 6 decimals, sign-independent', () => {
    expect(formatMicrosExact(0n)).toBe('$0.000000');
    expect(formatMicrosExact(1n)).toBe('$0.000001');
    expect(formatMicrosExact(999_999n)).toBe('$0.999999');
    expect(formatMicrosExact(1_000_000n)).toBe('$1.000000');
    expect(formatMicrosExact(1_000_001n)).toBe('$1.000001');
    expect(formatMicrosExact(-1n)).toBe('-$0.000001');
    expect(formatMicrosExact(-1_000_001n)).toBe('-$1.000001');
  });

  it('preserves precision far above Number.MAX_SAFE_INTEGER', () => {
    // 9_007_199_254_740_993 micros = $9,007,199,254.740993 — a value Number cannot represent exactly.
    expect(formatMicrosExact(9_007_199_254_740_993n)).toBe('$9007199254.740993');
    const huge = 123_456_789_012_345_678_901n; // ~1.2e20 micros
    expect(formatMicrosExact(huge)).toBe('$123456789012345.678901');
    // round-trips exactly back to the same bigint via the whole+fraction parts
    expect(formatMicrosExact(huge)).toContain('123456789012345.678901');
  });

  it('2-decimal display rounds half-up by exact integer arithmetic', () => {
    expect(formatMicros2dp(0n)).toBe('$0.00');
    expect(formatMicros2dp(1_000_000n)).toBe('$1.00');
    expect(formatMicros2dp(1_004_999n)).toBe('$1.00'); // 1.004999 → rounds down
    expect(formatMicros2dp(1_005_000n)).toBe('$1.01'); // 1.005000 → half-up
    expect(formatMicros2dp(1_000_001n)).toBe('$1.00');
    expect(formatMicros2dp(-1_005_000n)).toBe('-$1.01');
    expect(formatMicros2dp(9_007_199_254_740_993n)).toBe('$9007199254.74');
  });

  it('rejects non-bigint input (no implicit Number coercion path)', () => {
    // @ts-expect-error intentional: a number must not be accepted
    expect(() => formatMicrosExact(1)).toThrow(TypeError);
    // @ts-expect-error intentional
    expect(() => formatMicros2dp(1.5)).toThrow(TypeError);
  });

  it('the formatter source contains no Number(/parseFloat/float division of micros', () => {
    const src = readFileSync(join(process.cwd(), 'src/domain/reporting/format-money.ts'), 'utf8');
    expect(src.includes('Number(')).toBe(false);
    expect(src.includes('parseFloat')).toBe(false);
    // no floating-point division of a monetary value: only BigInt `/` (integer) is used
    expect(/\/\s*1_?000_?000\b(?!n)/.test(src.replace(/\/ 1e6/g, ''))).toBe(false);
  });

  it('NO reporting source converts a monetary micros value through Number (audit)', () => {
    // Reporting `Number(` uses are limited to bounded basis-point ratios (<=10000) and a validated top-N
    // string (<=200); none is a monetary micros value. This test pins that invariant by allow-listing the
    // exact call sites and failing if a new, unaudited `Number(` appears.
    const dir = join(process.cwd(), 'src', 'domain', 'reporting');
    const allowed = new Map<string, number>([
      ['m0a.ts', 3], // 3 bounded basis-point conversions ((x*10000n)/y) <= 10000
      ['window.ts', 1], // Number(validated \d+ top-N string) <= 200
    ]);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      const count = (src.match(/Number\(/g) ?? []).length;
      expect(count, `${f} has ${count} Number( calls; allow-list says ${allowed.get(f) ?? 0}`).toBe(allowed.get(f) ?? 0);
    }
  });
});
