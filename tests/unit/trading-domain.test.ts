import { describe, expect, it } from 'vitest';
import {
  PAPER_ORDER_STATES,
  TRADING_AUDIT_ACTIONS,
  TRADING_EXECUTION_MODES,
} from '@/types/trading';
import {
  MICROS_PER_USD,
  MoneyError,
  applyBuy,
  applySell,
  microsToUsd,
  notionalMicros,
  unrealizedPnlMicros,
  usdToMicros,
} from '@/domain/trading/money';
import {
  EXECUTION_MODE,
  LiveTradingBlockedError,
  PAPER_DESTINATION,
  assertNoExternalOrderIdentity,
  assertPaperDestination,
  assertPaperExecution,
} from '@/domain/trading/execution-mode';
import {
  type FillGate,
  OrderTransitionError,
  allowedTransitions,
  applyTransition,
  assertFillable,
  fillGateFailure,
  isTerminal,
} from '@/domain/trading/order-state-machine';
import { DEFAULT_RISK_LIMITS, evaluateRiskChecks } from '@/domain/trading/risk-limits';
import { SeededMarketDataAdapter, isQuoteTradeable } from '@/domain/trading/market-data-adapter';
import { DeterministicPaperBroker } from '@/domain/trading/paper-broker-adapter';
import { TRANSITION_AUDIT_ACTION, auditActionForTransition } from '@/domain/trading/audit-actions';

const NOW = new Date('2026-08-01T15:00:00.000Z');
const FRESH = new Date('2026-08-01T14:59:59.000Z');

// -- execution mode (paper only) ---------------------------------------------
describe('trading execution mode is paper-only', () => {
  it('the only mode is paper and it cannot be changed', () => {
    expect(TRADING_EXECUTION_MODES).toEqual(['paper']);
    expect(EXECUTION_MODE).toBe('paper');
    expect(() => assertPaperExecution('paper')).not.toThrow();
    for (const bad of ['live', 'real', 'margin', 'prod', '']) expect(() => assertPaperExecution(bad)).toThrow(LiveTradingBlockedError);
  });
  it('only the internal paper simulator is an allowed destination', () => {
    expect(() => assertPaperDestination(PAPER_DESTINATION)).not.toThrow();
    for (const bad of ['alpaca', 'ibkr', 'nyse', '']) expect(() => assertPaperDestination(bad)).toThrow(LiveTradingBlockedError);
  });
  it('external/live-order identity fields are rejected', () => {
    expect(() => assertNoExternalOrderIdentity({ symbol: 'AAPL' })).not.toThrow();
    for (const f of ['brokerId', 'brokerAccountId', 'liveOrderId', 'externalOrderId', 'venue', 'routeTo']) {
      expect(() => assertNoExternalOrderIdentity({ [f]: 'x' })).toThrow(LiveTradingBlockedError);
    }
  });
});

// -- money: exact decimal semantics ------------------------------------------
describe('trading money math is exact', () => {
  it('usdToMicros / microsToUsd round-trip exactly (no float drift)', () => {
    expect(usdToMicros('123.45')).toBe(123_450_000n);
    expect(usdToMicros('0.01')).toBe(10_000n);
    expect(usdToMicros('1000000.000001')).toBe(1_000_000_000_001n);
    expect(microsToUsd(123_450_000n)).toBe('123.45');
    expect(microsToUsd(10_005_000n)).toBe('10.01'); // half-up rounding at 2dp
    expect(() => usdToMicros('1.2345678')).toThrow(MoneyError); // >6dp
    expect(() => usdToMicros('abc')).toThrow(MoneyError);
  });
  it('buy then partial sell computes exact avg cost, realized P&L, and cash', () => {
    const cash0 = { cashMicros: 100_000n * MICROS_PER_USD }; // $100,000
    let pos = { qty: 0, avgCostMicros: 0n, realizedPnlMicros: 0n };
    let cash = cash0;
    ({ pos, cash } = applyBuy(pos, cash, 100, usdToMicros('150.00'))); // buy 100 @ 150 → -$15,000
    expect(pos.qty).toBe(100);
    expect(pos.avgCostMicros).toBe(usdToMicros('150.00'));
    expect(cash.cashMicros).toBe(85_000n * MICROS_PER_USD);
    ({ pos, cash } = applyBuy(pos, cash, 100, usdToMicros('160.00'))); // avg = (150+160)/2 = 155
    expect(pos.qty).toBe(200);
    expect(pos.avgCostMicros).toBe(usdToMicros('155.00'));
    ({ pos, cash } = applySell(pos, cash, 50, usdToMicros('165.00'))); // realized = (165-155)*50 = $500
    expect(pos.qty).toBe(150);
    expect(pos.realizedPnlMicros).toBe(500n * MICROS_PER_USD);
    expect(cash.cashMicros).toBe(85_000n * MICROS_PER_USD - 16_000n * MICROS_PER_USD + 8_250n * MICROS_PER_USD);
    expect(unrealizedPnlMicros(pos, usdToMicros('170.00'))).toBe((usdToMicros('170.00') - usdToMicros('155.00')) * 150n); // (170-155)*150 = $2,250
  });
  it('rejects short-selling, over-selling, fractional shares, and insufficient cash', () => {
    const pos = { qty: 10, avgCostMicros: usdToMicros('100.00'), realizedPnlMicros: 0n };
    expect(() => applySell(pos, { cashMicros: 0n }, 11, usdToMicros('100.00'))).toThrow(/no shorting/);
    expect(() => notionalMicros(usdToMicros('10.00'), 1.5)).toThrow(MoneyError); // fractional
    expect(() => applyBuy({ qty: 0, avgCostMicros: 0n, realizedPnlMicros: 0n }, { cashMicros: 100n }, 1, usdToMicros('100.00'))).toThrow(/insufficient cash/);
  });
});

// -- state machine + fill gate -----------------------------------------------
describe('trading order state machine', () => {
  it('has all 10 states and correct terminals', () => {
    expect(PAPER_ORDER_STATES.length).toBe(10);
    for (const s of ['risk_rejected', 'rejected', 'expired', 'simulated_filled', 'cancelled']) expect(isTerminal(s as never)).toBe(true);
    for (const s of ['draft', 'risk_pending', 'pending_approval', 'approved', 'fill_pending']) expect(isTerminal(s as never)).toBe(false);
  });
  it('happy path draft→…→simulated_filled only via valid transitions', () => {
    let s = applyTransition('draft', 'submit');
    expect(s).toBe('risk_pending');
    s = applyTransition(s, 'risk_pass');
    expect(s).toBe('pending_approval');
    s = applyTransition(s, 'approve');
    expect(s).toBe('approved');
    s = applyTransition(s, 'dispatch_fill');
    expect(s).toBe('fill_pending');
    s = applyTransition(s, 'simulate_fill');
    expect(s).toBe('simulated_filled');
  });
  it('rejects illegal transitions and cancellation of terminal states', () => {
    expect(() => applyTransition('draft', 'approve')).toThrow(OrderTransitionError);
    expect(() => applyTransition('simulated_filled', 'cancel')).toThrow(OrderTransitionError);
    expect(() => applyTransition('pending_approval', 'simulate_fill')).toThrow(OrderTransitionError); // must go through approve+dispatch
    expect(allowedTransitions('pending_approval').sort()).toEqual(['approve', 'cancel', 'expire', 'reject']);
  });

  const goodGate: FillGate = { executionMode: 'paper', destination: PAPER_DESTINATION, riskCheckCurrentAndPassing: true, humanApproved: true, killSwitchTripped: false, quoteFresh: true };
  it('simulated_filled requires ALL guards (risk + approval + kill-switch + fresh quote + paper)', () => {
    expect(fillGateFailure('fill_pending', goodGate)).toBeNull();
    expect(assertFillable('fill_pending', goodGate)).toBe('simulated_filled');
    expect(fillGateFailure('approved', goodGate)).toBe('not_fill_pending');
    expect(fillGateFailure('fill_pending', { ...goodGate, riskCheckCurrentAndPassing: false })).toBe('no_passing_risk_check');
    expect(fillGateFailure('fill_pending', { ...goodGate, humanApproved: false })).toBe('no_human_approval');
    expect(fillGateFailure('fill_pending', { ...goodGate, killSwitchTripped: true })).toBe('kill_switch_tripped');
    expect(fillGateFailure('fill_pending', { ...goodGate, quoteFresh: false })).toBe('stale_quote');
    expect(fillGateFailure('fill_pending', { ...goodGate, executionMode: 'live' })).toBe('non_paper_execution');
    expect(fillGateFailure('fill_pending', { ...goodGate, destination: 'alpaca' })).toBe('non_paper_destination');
  });
  it('a passing risk check alone cannot fill (needs approval); approval alone cannot fill (needs risk)', () => {
    expect(() => assertFillable('fill_pending', { ...goodGate, humanApproved: false })).toThrow(/no_human_approval/);
    expect(() => assertFillable('fill_pending', { ...goodGate, riskCheckCurrentAndPassing: false })).toThrow(/no_passing_risk_check/);
    expect(() => assertFillable('fill_pending', { ...goodGate, killSwitchTripped: true })).toThrow(/kill_switch_tripped/);
    expect(() => assertFillable('fill_pending', { ...goodGate, quoteFresh: false })).toThrow(/stale_quote/);
  });
});

// -- audit map completeness --------------------------------------------------
describe('every order transition maps to a trading audit action', () => {
  it('TRANSITION_AUDIT_ACTION is total over transitions and every action is in the vocabulary', () => {
    const transitions = ['submit', 'risk_pass', 'risk_fail', 'approve', 'reject', 'expire', 'dispatch_fill', 'simulate_fill', 'fill_reject', 'cancel'] as const;
    for (const t of transitions) {
      const a = auditActionForTransition(t);
      expect(TRANSITION_AUDIT_ACTION[t]).toBe(a);
      expect(TRADING_AUDIT_ACTIONS).toContain(a);
    }
    expect(Object.keys(TRANSITION_AUDIT_ACTION).sort()).toEqual([...transitions].sort());
  });
});

// -- risk limits -------------------------------------------------------------
describe('hard risk-limit defaults + evaluation', () => {
  it('defaults are exactly the mandated hard values and non-overridable', () => {
    const byKind = Object.fromEntries(DEFAULT_RISK_LIMITS.map((l) => [l.kind, l]));
    expect(byKind.max_symbol_position!.limitBps).toBe(1000); // 10%
    expect(byKind.max_sector_concentration!.limitBps).toBe(2500); // 25%
    expect(byKind.max_gross_exposure!.limitBps).toBe(10000); // 100%
    expect(byKind.daily_loss_limit!.limitBps).toBe(200); // 2%
    expect(byKind.weekly_loss_limit!.limitBps).toBe(500); // 5%
    expect(DEFAULT_RISK_LIMITS.every((l) => l.overridable === false)).toBe(true);
  });
  it('passes within limits and fails each limit independently', () => {
    const nav = 100_000n * MICROS_PER_USD;
    const base = { navMicros: nav, postTradeSymbolValueMicros: 5_000n * MICROS_PER_USD, postTradeSectorValueMicros: 10_000n * MICROS_PER_USD, postTradeGrossExposureMicros: 50_000n * MICROS_PER_USD, dayPnlMicros: 0n, weekPnlMicros: 0n };
    expect(evaluateRiskChecks(base).result).toBe('pass');
    expect(evaluateRiskChecks({ ...base, postTradeSymbolValueMicros: 11_000n * MICROS_PER_USD }).result).toBe('fail'); // 11% > 10%
    expect(evaluateRiskChecks({ ...base, postTradeSectorValueMicros: 26_000n * MICROS_PER_USD }).result).toBe('fail'); // 26% > 25%
    expect(evaluateRiskChecks({ ...base, postTradeGrossExposureMicros: 101_000n * MICROS_PER_USD }).result).toBe('fail'); // >100%
    expect(evaluateRiskChecks({ ...base, dayPnlMicros: -2_100n * MICROS_PER_USD }).result).toBe('fail'); // -2.1% > 2%
    expect(evaluateRiskChecks({ ...base, weekPnlMicros: -5_100n * MICROS_PER_USD }).result).toBe('fail'); // -5.1% > 5%
    // exactly at the limit passes
    expect(evaluateRiskChecks({ ...base, postTradeSymbolValueMicros: 10_000n * MICROS_PER_USD }).result).toBe('pass'); // 10%
  });
  it('fails closed when NAV is zero', () => {
    expect(evaluateRiskChecks({ navMicros: 0n, postTradeSymbolValueMicros: 1n, postTradeSectorValueMicros: 0n, postTradeGrossExposureMicros: 0n, dayPnlMicros: 0n, weekPnlMicros: 0n }).result).toBe('fail');
  });
});

// -- adapters (deterministic, no network/credentials) ------------------------
describe('deterministic adapters need no network or credentials', () => {
  const md = new SeededMarketDataAdapter([
    { symbol: 'AAPL', priceMicros: usdToMicros('150.00'), asOf: FRESH, session: 'open' },
    { symbol: 'SPY', priceMicros: usdToMicros('500.00'), asOf: new Date('2026-08-01T10:00:00.000Z'), session: 'closed' },
  ]);
  it('seeded quotes are returned verbatim and case-insensitively; unknown → null', () => {
    expect(md.getQuote('aapl')!.priceMicros).toBe(usdToMicros('150.00'));
    expect(md.getQuote('MSFT')).toBeNull();
  });
  it('freshness + session gating: open+fresh ok; closed or stale rejected', () => {
    expect(isQuoteTradeable(md.getQuote('AAPL')!, NOW, 60_000).ok).toBe(true);
    expect(isQuoteTradeable(md.getQuote('SPY')!, NOW, 60_000)).toEqual({ ok: false, reason: 'market_closed' });
    const stale = { ...md.getQuote('AAPL')!, asOf: new Date('2026-08-01T14:00:00.000Z') };
    expect(isQuoteTradeable(stale, NOW, 60_000)).toEqual({ ok: false, reason: 'stale_quote' });
  });
  it('paper broker fills deterministically and auditable; limit marketability respected', () => {
    const broker = new DeterministicPaperBroker();
    const q = md.getQuote('AAPL')!;
    const f1 = broker.simulateFill({ symbol: 'AAPL', side: 'buy', qty: 10, orderType: 'market', executionMode: 'paper' }, q, NOW)!;
    const f2 = broker.simulateFill({ symbol: 'AAPL', side: 'buy', qty: 10, orderType: 'market', executionMode: 'paper' }, q, NOW)!;
    expect(f1).toEqual(f2); // deterministic
    expect(f1.destination).toBe(PAPER_DESTINATION);
    expect(f1.fillPriceMicros).toBe(usdToMicros('150.00'));
    expect(f1.model).toBe('quote-at-touch/v1');
    // limit BUY below market → not marketable → null
    expect(broker.simulateFill({ symbol: 'AAPL', side: 'buy', qty: 1, orderType: 'limit', limitPriceMicros: usdToMicros('149.00'), executionMode: 'paper' }, q, NOW)).toBeNull();
    // limit BUY at/above market → fills at market
    expect(broker.simulateFill({ symbol: 'AAPL', side: 'buy', qty: 1, orderType: 'limit', limitPriceMicros: usdToMicros('151.00'), executionMode: 'paper' }, q, NOW)!.fillPriceMicros).toBe(usdToMicros('150.00'));
    // non-paper mode is refused at the adapter too
    expect(() => broker.simulateFill({ symbol: 'AAPL', side: 'buy', qty: 1, orderType: 'market', executionMode: 'live' }, q, NOW)).toThrow(LiveTradingBlockedError);
  });
});
