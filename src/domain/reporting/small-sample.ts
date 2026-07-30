/**
 * M0a small-sample gating — pure. Statistics on tiny samples mislead, so the report is only allowed to show
 * a statistic the sample size supports (M0a §10). This module decides what is permitted; it never ranks or
 * concludes on its own.
 *
 * Thresholds (n = qualifying observations):
 *   n < 5    → count, total, min, max only; comparative model conclusions suppressed.
 *   5 ≤ n<20 → median + range permitted, with a strong small-sample warning.
 *   20 ≤ n<100 → p90 permitted.
 *   n ≥ 100  → p95 and trend comparisons permitted.
 */

export type SampleTier = 'insufficient' | 'median_only' | 'p90' | 'p95';

export interface SampleAllowance {
  readonly n: number;
  readonly tier: SampleTier;
  readonly allowMedian: boolean;
  readonly allowP90: boolean;
  readonly allowP95: boolean;
  /** True when any comparative "which model is more efficient" conclusion may be drawn on size grounds. */
  readonly allowModelRanking: boolean;
  readonly warning: string | null;
}

export function sampleAllowance(n: number): SampleAllowance {
  if (!Number.isInteger(n) || n < 0) throw new Error('sample size must be a non-negative integer');
  if (n < 5) {
    return {
      n,
      tier: 'insufficient',
      allowMedian: false,
      allowP90: false,
      allowP95: false,
      allowModelRanking: false,
      warning: 'Insufficient sample (n < 5): count, total, min and max only; comparisons suppressed.',
    };
  }
  if (n < 20) {
    return {
      n,
      tier: 'median_only',
      allowMedian: true,
      allowP90: false,
      allowP95: false,
      allowModelRanking: false,
      warning: 'Small sample (5 ≤ n < 20): median and range only; treat comparisons as indicative, not conclusive.',
    };
  }
  if (n < 100) {
    return {
      n,
      tier: 'p90',
      allowMedian: true,
      allowP90: true,
      allowP95: false,
      allowModelRanking: true,
      warning: 'Moderate sample (20 ≤ n < 100): up to p90; p95 withheld.',
    };
  }
  return {
    n,
    tier: 'p95',
    allowMedian: true,
    allowP90: true,
    allowP95: true,
    allowModelRanking: true,
    warning: null,
  };
}

/**
 * Model-efficiency ranking is additionally blocked (regardless of size) when task types are materially
 * heterogeneous, estimated pricing coverage is incomplete, or recorded output quality is unavailable — none
 * of which M0a can establish (M0a §10). M0a has no quality signal and per-window coverage is frequently
 * partial, so this returns false with a stated reason unless the caller explicitly proves otherwise.
 */
export interface RankingGuardInput {
  readonly allowance: SampleAllowance;
  readonly pricingCoverageComplete: boolean;
  readonly taskTypesHomogeneous: boolean;
  readonly outputQualityAvailable: boolean;
}

export function mayRankModelsByEfficiency(input: RankingGuardInput): { allowed: boolean; reason: string | null } {
  if (!input.allowance.allowModelRanking) return { allowed: false, reason: input.allowance.warning };
  if (!input.pricingCoverageComplete) return { allowed: false, reason: 'Estimated pricing coverage is incomplete.' };
  if (!input.taskTypesHomogeneous) return { allowed: false, reason: 'Task types are materially heterogeneous.' };
  if (!input.outputQualityAvailable) return { allowed: false, reason: 'Recorded output quality is unavailable.' };
  return { allowed: true, reason: null };
}
