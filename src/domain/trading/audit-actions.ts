import { type TradingAuditAction } from '@/types/trading';
import { type TradingTransition } from './order-state-machine';

/**
 * Stock Trading — the binding between paper-order state transitions and the append-only, hash-chained Hub audit
 * trail. EVERY order-lifecycle transition maps to exactly one trading audit action, so no state change can occur
 * without a corresponding immutable audit event. A test proves this map is total over the transition set.
 */

export const TRANSITION_AUDIT_ACTION: Readonly<Record<TradingTransition, TradingAuditAction>> = {
  submit: 'trading.proposal.risk_checked', // submit enters risk_pending; the check + its record are one step
  risk_pass: 'trading.proposal.submitted_for_approval',
  risk_fail: 'trading.proposal.risk_rejected',
  approve: 'trading.proposal.approved',
  reject: 'trading.proposal.rejected',
  expire: 'trading.proposal.expired',
  dispatch_fill: 'trading.order.fill_dispatched',
  simulate_fill: 'trading.order.simulated_filled',
  fill_reject: 'trading.proposal.rejected',
  cancel: 'trading.proposal.cancelled',
};

/** Non-order trading events that must also be audited (proposal creation, theses, risk/limit/kill-switch changes). */
export const TRADING_EVENT_AUDIT_ACTIONS: readonly TradingAuditAction[] = [
  'trading.signal.recorded',
  'trading.thesis.created',
  'trading.thesis.changed',
  'trading.proposal.created',
  'trading.risk_limit.changed',
  'trading.restricted_symbol.changed',
  'trading.kill_switch.tripped',
  'trading.kill_switch.reset',
];

/** The audit action required for a given order transition (throws if a transition is unmapped — a bug). */
export function auditActionForTransition(t: TradingTransition): TradingAuditAction {
  const a = TRANSITION_AUDIT_ACTION[t];
  if (!a) throw new Error(`no audit action mapped for transition ${t}`);
  return a;
}
