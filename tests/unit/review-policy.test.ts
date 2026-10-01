import { describe, expect, it } from 'vitest';
import {
  deriveReviewPlan,
  evaluateReviewRequirementSafe,
  resolveReviewRequirement,
} from '@/domain/tasks/review-policy';

describe('review-policy — resolveReviewRequirement (conservative default)', () => {
  it('requires review by default when not exempt', () => {
    expect(resolveReviewRequirement({})).toEqual({ required: true, reason: 'default_required' });
    expect(resolveReviewRequirement({ quickExempt: null })).toEqual({ required: true, reason: 'default_required' });
    expect(resolveReviewRequirement({ quickExempt: false })).toEqual({ required: true, reason: 'default_required' });
  });

  it('does NOT require review only when explicitly exempt (=== true)', () => {
    expect(resolveReviewRequirement({ quickExempt: true })).toEqual({
      required: false,
      reason: 'task_explicitly_exempt',
    });
  });
});

describe('review-policy — evaluateReviewRequirementSafe (fail-safe)', () => {
  it('fails safe to REQUIRED when the policy read throws', () => {
    const faulting = {
      get quickExempt(): boolean {
        throw new Error('policy source unavailable');
      },
    };
    expect(evaluateReviewRequirementSafe(faulting)).toEqual({ required: true, reason: 'policy_eval_error' });
  });

  it('passes through the normal decision when the read succeeds', () => {
    expect(evaluateReviewRequirementSafe({ quickExempt: true }).required).toBe(false);
    expect(evaluateReviewRequirementSafe({ quickExempt: false }).required).toBe(true);
  });
});

describe('review-policy — deriveReviewPlan (mode derivation + forced override)', () => {
  it('Quick requested + exempt → runs Quick, not forced', () => {
    expect(deriveReviewPlan({ reviewRequested: false, quickExempt: true })).toEqual({
      requestedMode: 'quick',
      effectiveMode: 'quick',
      required: false,
      reason: 'task_explicitly_exempt',
      forced: false,
    });
  });

  it('Quick requested + NOT exempt → FORCED to Reviewed', () => {
    expect(deriveReviewPlan({ reviewRequested: false, quickExempt: false })).toEqual({
      requestedMode: 'quick',
      effectiveMode: 'reviewed',
      required: true,
      reason: 'default_required',
      forced: true,
    });
  });

  it('Reviewed requested → Reviewed, never forced (even when also required)', () => {
    expect(deriveReviewPlan({ reviewRequested: true, quickExempt: false })).toEqual({
      requestedMode: 'reviewed',
      effectiveMode: 'reviewed',
      required: true,
      reason: 'default_required',
      forced: false,
    });
  });

  it('Reviewed requested + exempt → Reviewed (optional), not forced', () => {
    expect(deriveReviewPlan({ reviewRequested: true, quickExempt: true })).toEqual({
      requestedMode: 'reviewed',
      effectiveMode: 'reviewed',
      required: false,
      reason: 'task_explicitly_exempt',
      forced: false,
    });
  });
});
