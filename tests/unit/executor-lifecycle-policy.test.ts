import { describe, expect, it } from 'vitest';
import { canTransitionExecutorLifecycle, classifyIdempotency, interruptionOutcome, mayClaimAttempt, requireExecutorLifecycleTransition } from '@/domain/execution/executor-lifecycle-policy';

describe('executor lifecycle policy', () => {
  it('permits the normal success and reconciliation paths', () => {
    const success = ['proposed', 'confirmed', 'claimed', 'sandbox_starting', 'precondition_verified', 'writing', 'verifying', 'succeeded'] as const;
    success.slice(0, -1).forEach((state, i) => expect(canTransitionExecutorLifecycle(state, success[i + 1]!)).toBe(true));
    expect(canTransitionExecutorLifecycle('ambiguous', 'reconciling')).toBe(true);
    expect(canTransitionExecutorLifecycle('reconciling', 'reconciled_succeeded')).toBe(true);
    expect(canTransitionExecutorLifecycle('reconciling', 'reconciled_not_executed')).toBe(true);
  });
  it('fails closed on invalid, duplicate, and terminal transitions', () => {
    expect(() => requireExecutorLifecycleTransition('proposed', 'writing')).toThrow(/invalid/i);
    expect(canTransitionExecutorLifecycle('succeeded', 'claimed')).toBe(false);
    expect(canTransitionExecutorLifecycle('claimed', 'claimed')).toBe(false);
  });
  it('never maps a possible side effect or missing result to not-executed', () => {
    for (const event of ['worker_crash', 'timeout', 'transport_loss', 'result_persistence_failure'] as const) {
      expect(interruptionOutcome(event, true)).toBe('ambiguous');
    }
    expect(interruptionOutcome('result_persistence_failure', false)).toBe('ambiguous');
    expect(interruptionOutcome('worker_crash', false)).toBe('definitely_not_executed');
  });
  it('classifies duplicate idempotency and prevents claim/attempt races', () => {
    expect(classifyIdempotency(null, 'a')).toBe('new');
    expect(classifyIdempotency('a', 'a')).toBe('same_request');
    expect(classifyIdempotency('a', 'b')).toBe('conflict');
    expect(mayClaimAttempt('confirmed', 1, 2, false)).toBe(true);
    expect(mayClaimAttempt('confirmed', 1, 2, true)).toBe(false);
    expect(mayClaimAttempt('confirmed', 1, 3, false)).toBe(false);
    expect(mayClaimAttempt('claimed', 1, 2, false)).toBe(false);
  });
});
