import { type OrderSide, type OrderType } from '@/types/trading';
import { type Quote } from './market-data-adapter';
import { PAPER_DESTINATION, assertPaperExecution } from './execution-mode';
import { MoneyError, assertWholeShares } from './money';

/**
 * Stock Trading — PaperBrokerAdapter boundary. P1 ships ONLY a deterministic internal simulator: it moves no money,
 * needs no credentials, performs no I/O, and its destination is always the internal paper simulator (never a live
 * venue). Given the same order + quote it always returns the same fill.
 */

export interface PaperOrderRequest {
  readonly symbol: string;
  readonly side: OrderSide; // long-only: buy | sell
  readonly qty: number; // whole shares
  readonly orderType: OrderType; // market | limit
  readonly limitPriceMicros?: bigint; // required for limit
  readonly executionMode: string; // must be 'paper'
}

export interface SimulatedFill {
  readonly destination: typeof PAPER_DESTINATION;
  readonly symbol: string;
  readonly side: OrderSide;
  readonly qty: number;
  readonly fillPriceMicros: bigint;
  readonly quoteAsOf: Date;
  readonly simulatedAt: Date;
  readonly model: 'quote-at-touch/v1';
}

export interface PaperBrokerAdapter {
  /** Deterministically simulate a fill. Returns null if the (limit) order is not marketable at the quote. */
  simulateFill(order: PaperOrderRequest, quote: Quote, now: Date): SimulatedFill | null;
  readonly destination: typeof PAPER_DESTINATION;
}

/**
 * Deterministic paper simulator. Fill model `quote-at-touch/v1`:
 *   - market orders fill fully at the quoted price;
 *   - limit BUY fills at the quote iff quote ≤ limit; limit SELL fills iff quote ≥ limit (else not marketable → null);
 *   - fill price = the quoted price (no synthetic slippage in P1; a slippage model is a later, explicit decision).
 * No randomness, no network, no credentials, no partial fills in P1.
 */
export class DeterministicPaperBroker implements PaperBrokerAdapter {
  readonly destination = PAPER_DESTINATION;
  simulateFill(order: PaperOrderRequest, quote: Quote, now: Date): SimulatedFill | null {
    assertPaperExecution(order.executionMode);
    assertWholeShares(order.qty);
    if (order.symbol.toUpperCase() !== quote.symbol.toUpperCase()) throw new MoneyError('quote symbol does not match order symbol');
    if (quote.priceMicros <= 0n) throw new MoneyError('quote price must be positive');

    let fillPriceMicros: bigint;
    if (order.orderType === 'market') {
      fillPriceMicros = quote.priceMicros;
    } else {
      if (order.limitPriceMicros === undefined || order.limitPriceMicros <= 0n) throw new MoneyError('limit order requires a positive limit price');
      const marketable = order.side === 'buy' ? quote.priceMicros <= order.limitPriceMicros : quote.priceMicros >= order.limitPriceMicros;
      if (!marketable) return null;
      fillPriceMicros = quote.priceMicros;
    }
    return {
      destination: PAPER_DESTINATION,
      symbol: quote.symbol.toUpperCase(),
      side: order.side,
      qty: order.qty,
      fillPriceMicros,
      quoteAsOf: quote.asOf,
      simulatedAt: now,
      model: 'quote-at-touch/v1',
    };
  }
}
