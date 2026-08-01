/**
 * Stock Trading — EXACT decimal money math. All monetary values are integer micro-dollars (`bigint`,
 * 1 USD = 1_000_000 micros) and all share quantities are whole integers (no fractional shares in P1). Every
 * cash / position / P&L computation is integer arithmetic, so there is never floating-point drift.
 */

export const MICROS_PER_USD = 1_000_000n;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** Parse a decimal USD string (e.g. "123.45", up to 6 dp) into exact micro-dollars. Rejects junk / >6 dp. */
export function usdToMicros(usd: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(usd.trim());
  if (!m) throw new MoneyError(`not a valid USD amount (max 6 dp): ${JSON.stringify(usd)}`);
  const [, sign, whole, frac = ''] = m;
  const micros = BigInt(whole!) * MICROS_PER_USD + BigInt((frac + '000000').slice(0, 6));
  return sign === '-' ? -micros : micros;
}

/** Format micro-dollars as a fixed 2-dp USD string (banker-free truncation is avoided; we round half-up). */
export function microsToUsd(micros: bigint, dp = 2): string {
  const neg = micros < 0n;
  let v = neg ? -micros : micros;
  // round to `dp` decimals
  const scale = 10n ** BigInt(6 - dp);
  const rounded = (v + scale / 2n) / scale; // half-up
  v = rounded * scale;
  const whole = v / MICROS_PER_USD;
  const frac = (v % MICROS_PER_USD).toString().padStart(6, '0').slice(0, dp);
  return `${neg ? '-' : ''}${whole}${dp > 0 ? '.' + frac : ''}`;
}

/** Whole-share quantity guard. */
export function assertWholeShares(qty: number): void {
  if (!Number.isInteger(qty) || qty <= 0) throw new MoneyError(`share quantity must be a positive integer, got ${qty}`);
}

/** Notional value (micros) of `shares` at `priceMicros`. Exact. */
export function notionalMicros(priceMicros: bigint, shares: number): bigint {
  assertWholeShares(shares);
  if (priceMicros <= 0n) throw new MoneyError('price must be positive');
  return priceMicros * BigInt(shares);
}

export interface PositionState {
  readonly qty: number;
  readonly avgCostMicros: bigint;
  readonly realizedPnlMicros: bigint;
}
export interface CashState {
  readonly cashMicros: bigint;
}

/** Apply a LONG BUY: increases qty, recomputes weighted-average cost, debits cash. Exact integer math. */
export function applyBuy(pos: PositionState, cash: CashState, shares: number, priceMicros: bigint): { pos: PositionState; cash: CashState } {
  assertWholeShares(shares);
  const cost = notionalMicros(priceMicros, shares);
  if (cost > cash.cashMicros) throw new MoneyError('insufficient cash for buy (no margin in P1)');
  const newQty = pos.qty + shares;
  // weighted average cost = (oldQty*oldAvg + shares*price) / newQty, kept in micros; integer division truncates
  // toward zero — acceptable because avgCost is only a cost basis reference; realized P&L uses it consistently.
  const newAvg = (BigInt(pos.qty) * pos.avgCostMicros + cost) / BigInt(newQty);
  return {
    pos: { qty: newQty, avgCostMicros: newAvg, realizedPnlMicros: pos.realizedPnlMicros },
    cash: { cashMicros: cash.cashMicros - cost },
  };
}

/** Apply a LONG SELL (close/reduce): cannot exceed holdings (no shorting), credits cash, realizes P&L. */
export function applySell(pos: PositionState, cash: CashState, shares: number, priceMicros: bigint): { pos: PositionState; cash: CashState } {
  assertWholeShares(shares);
  if (shares > pos.qty) throw new MoneyError('cannot sell more than the long position holds (no shorting in P1)');
  const proceeds = notionalMicros(priceMicros, shares);
  const realized = (priceMicros - pos.avgCostMicros) * BigInt(shares);
  const newQty = pos.qty - shares;
  return {
    pos: {
      qty: newQty,
      avgCostMicros: newQty === 0 ? 0n : pos.avgCostMicros, // basis unchanged on partial close; reset when flat
      realizedPnlMicros: pos.realizedPnlMicros + realized,
    },
    cash: { cashMicros: cash.cashMicros + proceeds },
  };
}

/** Unrealized P&L (micros) of a long position at `markMicros`. */
export function unrealizedPnlMicros(pos: PositionState, markMicros: bigint): bigint {
  if (pos.qty === 0) return 0n;
  return (markMicros - pos.avgCostMicros) * BigInt(pos.qty);
}

/** Gross exposure (micros) = |position notional at mark|, summed by the caller across positions. */
export function positionMarketValueMicros(pos: PositionState, markMicros: bigint): bigint {
  return markMicros * BigInt(pos.qty);
}
