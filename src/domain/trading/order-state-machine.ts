import { type PaperOrderState } from '@/types/trading';
import { EXECUTION_MODE, PAPER_DESTINATION, assertPaperDestination, assertPaperExecution } from './execution-mode';

/**
 * Stock Trading — paper-order lifecycle state machine (pure). Every allowed transition is enumerated; anything
 * else is rejected. Reaching `simulated_filled` requires ALL of: a current PASSING risk check, an explicit HUMAN
 * approval, an UNTRIPPED kill switch, a FRESH quote, and a PAPER-only destination — enforced by `assertFillable`.
 */

export type TradingTransition =
  | 'submit' // draft → risk_pending
  | 'risk_pass' // risk_pending → pending_approval
  | 'risk_fail' // risk_pending → risk_rejected
  | 'approve' // pending_approval → approved
  | 'reject' // pending_approval → rejected
  | 'expire' // pending_approval → expired
  | 'dispatch_fill' // approved → fill_pending
  | 'simulate_fill' // fill_pending → simulated_filled  (guarded)
  | 'fill_reject' // fill_pending → rejected  (a fill-time guard failed)
  | 'cancel'; // (any pre-terminal, pre-fill state) → cancelled

const TRANSITIONS: Readonly<Record<TradingTransition, { from: readonly PaperOrderState[]; to: PaperOrderState }>> = {
  submit: { from: ['draft'], to: 'risk_pending' },
  risk_pass: { from: ['risk_pending'], to: 'pending_approval' },
  risk_fail: { from: ['risk_pending'], to: 'risk_rejected' },
  approve: { from: ['pending_approval'], to: 'approved' },
  reject: { from: ['pending_approval'], to: 'rejected' },
  expire: { from: ['pending_approval'], to: 'expired' },
  dispatch_fill: { from: ['approved'], to: 'fill_pending' },
  simulate_fill: { from: ['fill_pending'], to: 'simulated_filled' },
  fill_reject: { from: ['fill_pending'], to: 'rejected' },
  // Cancellation is allowed only before a fill has been simulated; never from a terminal state.
  cancel: { from: ['draft', 'risk_pending', 'pending_approval', 'approved', 'fill_pending'], to: 'cancelled' },
};

export const TERMINAL_STATES: ReadonlySet<PaperOrderState> = new Set(['risk_rejected', 'rejected', 'expired', 'simulated_filled', 'cancelled']);

export class OrderTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderTransitionError';
  }
}

export function isTerminal(state: PaperOrderState): boolean {
  return TERMINAL_STATES.has(state);
}

/** Validate a transition. Returns the resulting state or throws. Pure. */
export function applyTransition(from: PaperOrderState, transition: TradingTransition): PaperOrderState {
  const spec = TRANSITIONS[transition];
  if (!spec) throw new OrderTransitionError(`unknown transition ${transition}`);
  if (!spec.from.includes(from)) throw new OrderTransitionError(`transition ${transition} is not allowed from ${from}`);
  return spec.to;
}

/** All transitions legal from a given state (for UI / exhaustiveness tests). */
export function allowedTransitions(from: PaperOrderState): TradingTransition[] {
  return (Object.keys(TRANSITIONS) as TradingTransition[]).filter((t) => TRANSITIONS[t].from.includes(from));
}

/**
 * The non-negotiable pre-conditions for a simulated fill. EVERY one must hold; the state machine physically
 * cannot reach `simulated_filled` without passing this gate.
 */
export interface FillGate {
  readonly executionMode: string;
  readonly destination: string;
  readonly riskCheckCurrentAndPassing: boolean;
  readonly humanApproved: boolean;
  readonly killSwitchTripped: boolean;
  readonly quoteFresh: boolean;
}

export type FillGateFailure =
  | 'not_fill_pending'
  | 'non_paper_execution'
  | 'non_paper_destination'
  | 'no_passing_risk_check'
  | 'no_human_approval'
  | 'kill_switch_tripped'
  | 'stale_quote';

/** Returns the first failing guard, or null if the fill may proceed. Pure; order is deterministic. */
export function fillGateFailure(state: PaperOrderState, gate: FillGate): FillGateFailure | null {
  if (state !== 'fill_pending') return 'not_fill_pending';
  if (gate.executionMode !== EXECUTION_MODE) return 'non_paper_execution';
  if (gate.destination !== PAPER_DESTINATION) return 'non_paper_destination';
  if (!gate.riskCheckCurrentAndPassing) return 'no_passing_risk_check';
  if (!gate.humanApproved) return 'no_human_approval';
  if (gate.killSwitchTripped) return 'kill_switch_tripped';
  if (!gate.quoteFresh) return 'stale_quote';
  return null;
}

/**
 * Enforce the fill gate and return the terminal state. On any guard failure throws (the caller records a
 * `fill_reject` / structured rejection); ONLY an all-pass yields `simulated_filled`.
 */
export function assertFillable(state: PaperOrderState, gate: FillGate): 'simulated_filled' {
  // Also assert the hard invariants directly (defense-in-depth; these throw LiveTradingBlockedError).
  assertPaperExecution(gate.executionMode);
  assertPaperDestination(gate.destination);
  const failure = fillGateFailure(state, gate);
  if (failure) throw new OrderTransitionError(`fill blocked: ${failure}`);
  return applyTransition(state, 'simulate_fill') as 'simulated_filled';
}
