import { type RiskCheckResult, type RiskLimitKind } from '@/types/trading';

/**
 * Stock Trading — HARD risk limits. In the MVP these defaults are non-overridable: the evaluator is pure and every
 * limit is expressed in basis points of portfolio NAV so all comparisons are exact integer math.
 */

export interface RiskLimitDefault {
  readonly kind: RiskLimitKind;
  readonly limitBps: number; // basis points of NAV (10000 = 100%)
  readonly window: 'per_order' | 'daily' | 'weekly';
  readonly overridable: false;
}

export const DEFAULT_RISK_LIMITS: readonly RiskLimitDefault[] = [
  { kind: 'max_symbol_position', limitBps: 1000, window: 'per_order', overridable: false }, // 10% NAV / symbol
  { kind: 'max_sector_concentration', limitBps: 2500, window: 'per_order', overridable: false }, // 25% NAV / sector
  { kind: 'max_gross_exposure', limitBps: 10000, window: 'per_order', overridable: false }, // 100% NAV gross
  { kind: 'daily_loss_limit', limitBps: 200, window: 'daily', overridable: false }, // 2% NAV / day
  { kind: 'weekly_loss_limit', limitBps: 500, window: 'weekly', overridable: false }, // 5% NAV / week
];

/** Snapshot the evaluator needs; all monetary values are integer micro-dollars. */
export interface RiskEvalInput {
  readonly navMicros: bigint; // portfolio NAV (cash + long market value)
  readonly postTradeSymbolValueMicros: bigint; // this symbol's market value AFTER the proposed fill
  readonly postTradeSectorValueMicros: bigint; // the symbol's sector market value AFTER the proposed fill
  readonly postTradeGrossExposureMicros: bigint; // total long market value AFTER the proposed fill
  readonly dayPnlMicros: bigint; // realized+unrealized P&L so far today (negative = loss)
  readonly weekPnlMicros: bigint; // realized+unrealized P&L over the trailing week (negative = loss)
}

export interface RiskCheckLine {
  readonly kind: RiskLimitKind;
  readonly limitBps: number;
  readonly observedBps: number;
  readonly result: RiskCheckResult;
  readonly detail: string;
}
export interface RiskEvaluation {
  readonly result: RiskCheckResult; // 'fail' if ANY line fails
  readonly checks: readonly RiskCheckLine[];
}

/** bps of NAV for a non-negative exposure value. NAV must be positive. Rounds up so a limit is never under-reported. */
function bpsOfNav(valueMicros: bigint, navMicros: bigint): number {
  if (navMicros <= 0n) return Number.MAX_SAFE_INTEGER; // fail-closed: no NAV ⇒ any exposure is over-limit
  const v = valueMicros < 0n ? 0n : valueMicros;
  // ceil((v * 10000) / nav)
  return Number((v * 10000n + navMicros - 1n) / navMicros);
}

/** Loss expressed as bps of NAV (0 when P&L is non-negative). */
function lossBpsOfNav(pnlMicros: bigint, navMicros: bigint): number {
  if (pnlMicros >= 0n) return 0;
  return bpsOfNav(-pnlMicros, navMicros);
}

/** Pure evaluation of ALL hard limits for a proposed order. `result` is 'fail' if any single line fails. */
export function evaluateRiskChecks(input: RiskEvalInput, limits: readonly RiskLimitDefault[] = DEFAULT_RISK_LIMITS): RiskEvaluation {
  const checks: RiskCheckLine[] = limits.map((lim) => {
    let observedBps: number;
    switch (lim.kind) {
      case 'max_symbol_position':
        observedBps = bpsOfNav(input.postTradeSymbolValueMicros, input.navMicros);
        break;
      case 'max_sector_concentration':
        observedBps = bpsOfNav(input.postTradeSectorValueMicros, input.navMicros);
        break;
      case 'max_gross_exposure':
        observedBps = bpsOfNav(input.postTradeGrossExposureMicros, input.navMicros);
        break;
      case 'daily_loss_limit':
        observedBps = lossBpsOfNav(input.dayPnlMicros, input.navMicros);
        break;
      case 'weekly_loss_limit':
        observedBps = lossBpsOfNav(input.weekPnlMicros, input.navMicros);
        break;
    }
    const result: RiskCheckResult = observedBps <= lim.limitBps ? 'pass' : 'fail';
    return { kind: lim.kind, limitBps: lim.limitBps, observedBps, result, detail: `${observedBps}bps vs limit ${lim.limitBps}bps (${lim.window})` };
  });
  return { result: checks.some((c) => c.result === 'fail') ? 'fail' : 'pass', checks };
}
