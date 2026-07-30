import { describe, expect, it } from 'vitest';
import { mayRankModelsByEfficiency, sampleAllowance } from '@/domain/reporting/small-sample';

describe('M0a small-sample gating', () => {
  it('n < 5 → count/total/min/max only; no median/percentiles/ranking', () => {
    const a = sampleAllowance(4);
    expect(a.tier).toBe('insufficient');
    expect(a.allowMedian).toBe(false);
    expect(a.allowP90).toBe(false);
    expect(a.allowP95).toBe(false);
    expect(a.allowModelRanking).toBe(false);
    expect(a.warning).toBeTruthy();
  });

  it('5 ≤ n < 20 → median + range with warning; no p90', () => {
    const a = sampleAllowance(19);
    expect(a.tier).toBe('median_only');
    expect(a.allowMedian).toBe(true);
    expect(a.allowP90).toBe(false);
    expect(a.warning).toBeTruthy();
  });

  it('20 ≤ n < 100 → p90 permitted, p95 withheld', () => {
    const a = sampleAllowance(20);
    expect(a.tier).toBe('p90');
    expect(a.allowP90).toBe(true);
    expect(a.allowP95).toBe(false);
  });

  it('n ≥ 100 → p95 permitted, no warning', () => {
    const a = sampleAllowance(100);
    expect(a.tier).toBe('p95');
    expect(a.allowP95).toBe(true);
    expect(a.warning).toBeNull();
  });

  it('rejects invalid sample size', () => {
    expect(() => sampleAllowance(-1)).toThrow();
    expect(() => sampleAllowance(1.5)).toThrow();
  });

  it('model ranking is blocked unless size + coverage + homogeneity + quality all hold', () => {
    const big = sampleAllowance(200);
    expect(mayRankModelsByEfficiency({ allowance: big, pricingCoverageComplete: false, taskTypesHomogeneous: true, outputQualityAvailable: true }).allowed).toBe(false);
    expect(mayRankModelsByEfficiency({ allowance: big, pricingCoverageComplete: true, taskTypesHomogeneous: false, outputQualityAvailable: true }).allowed).toBe(false);
    expect(mayRankModelsByEfficiency({ allowance: big, pricingCoverageComplete: true, taskTypesHomogeneous: true, outputQualityAvailable: false }).allowed).toBe(false);
    // small sample blocks regardless of the other flags
    expect(mayRankModelsByEfficiency({ allowance: sampleAllowance(4), pricingCoverageComplete: true, taskTypesHomogeneous: true, outputQualityAvailable: true }).allowed).toBe(false);
    // all conditions met
    expect(mayRankModelsByEfficiency({ allowance: big, pricingCoverageComplete: true, taskTypesHomogeneous: true, outputQualityAvailable: true }).allowed).toBe(true);
  });
});
