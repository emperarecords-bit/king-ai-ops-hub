import type { ExecutorExecutionState } from '@/types/domain';

const TRANSITIONS: Readonly<Record<ExecutorExecutionState, readonly ExecutorExecutionState[]>> = {
  proposed: ['confirmed', 'blocked'], confirmed: ['claimed', 'blocked'],
  claimed: ['sandbox_starting', 'definitely_not_executed', 'failed', 'ambiguous'],
  sandbox_starting: ['precondition_verified', 'definitely_not_executed', 'failed', 'ambiguous'],
  precondition_verified: ['writing', 'definitely_not_executed', 'failed', 'ambiguous'],
  writing: ['verifying', 'failed', 'ambiguous'], verifying: ['succeeded', 'failed', 'ambiguous'],
  ambiguous: ['reconciling', 'manual_resolution_required'], reconciling: ['reconciled_succeeded', 'reconciled_not_executed', 'manual_resolution_required'],
  succeeded: [], blocked: [], definitely_not_executed: [], failed: [], reconciled_succeeded: [], reconciled_not_executed: [], manual_resolution_required: [],
};

export const canTransitionExecutorLifecycle = (from: ExecutorExecutionState, to: ExecutorExecutionState): boolean =>
  TRANSITIONS[from].includes(to);

export function requireExecutorLifecycleTransition(from: ExecutorExecutionState, to: ExecutorExecutionState): void {
  if (!canTransitionExecutorLifecycle(from, to)) throw new Error(`Invalid executor lifecycle transition: ${from} -> ${to}`);
}

export type ExecutionInterruption = 'worker_crash' | 'timeout' | 'transport_loss' | 'result_persistence_failure';
export function interruptionOutcome(interruption: ExecutionInterruption, sideEffectWasPossible: boolean): ExecutorExecutionState {
  if (sideEffectWasPossible || interruption === 'result_persistence_failure') return 'ambiguous';
  return 'definitely_not_executed';
}

export type IdempotencyDecision = 'new' | 'same_request' | 'conflict';
export function classifyIdempotency(existingBinding: string | null, requestedBinding: string): IdempotencyDecision {
  if (existingBinding === null) return 'new';
  return existingBinding === requestedBinding ? 'same_request' : 'conflict';
}

export function mayClaimAttempt(currentState: ExecutorExecutionState, currentAttempt: number, requestedAttempt: number, activeLease: boolean): boolean {
  return currentState === 'confirmed' && !activeLease && requestedAttempt === currentAttempt + 1;
}
