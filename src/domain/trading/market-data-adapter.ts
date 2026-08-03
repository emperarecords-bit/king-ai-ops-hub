import { type MarketSession } from '@/types/trading';

/**
 * Stock Trading — MarketDataAdapter boundary. The core never depends on a vendor. P1 ships ONLY a deterministic,
 * seeded in-memory adapter: no network calls, no credentials, no clock of its own (the caller injects `now`).
 * Every quote carries `asOf` + `session` so the risk layer can enforce stale-price and market-closed rejections.
 */

export interface Quote {
  readonly symbol: string;
  readonly priceMicros: bigint;
  readonly asOf: Date;
  readonly session: MarketSession;
  readonly source: string;
}

export interface MarketDataAdapter {
  /** Latest known quote for a symbol, or null if unknown. MUST NOT perform I/O in P1. */
  getQuote(symbol: string): Quote | null;
  readonly source: string;
}

/** True when the quote is fresh enough AND the market session permits trading (open only). */
export function isQuoteTradeable(quote: Quote, now: Date, maxAgeMs: number): { ok: true } | { ok: false; reason: 'stale_quote' | 'market_closed' } {
  if (quote.session !== 'open') return { ok: false, reason: 'market_closed' };
  const ageMs = now.getTime() - quote.asOf.getTime();
  if (!(ageMs >= 0) || ageMs > maxAgeMs) return { ok: false, reason: 'stale_quote' };
  return { ok: true };
}

export interface SeededQuote {
  readonly symbol: string;
  readonly priceMicros: bigint;
  readonly asOf: Date;
  readonly session: MarketSession;
}

/**
 * Deterministic, offline market-data adapter. Quotes are exactly what the caller seeds — no synthesis, no network,
 * no randomness. Symbols are matched case-insensitively and stored canonically upper-cased.
 */
export class SeededMarketDataAdapter implements MarketDataAdapter {
  readonly source = 'seeded-deterministic';
  private readonly quotes = new Map<string, Quote>();
  constructor(seed: readonly SeededQuote[]) {
    for (const q of seed) {
      if (q.priceMicros <= 0n) throw new Error(`seeded quote for ${q.symbol} must have a positive price`);
      const sym = q.symbol.toUpperCase();
      this.quotes.set(sym, { symbol: sym, priceMicros: q.priceMicros, asOf: q.asOf, session: q.session, source: this.source });
    }
  }
  getQuote(symbol: string): Quote | null {
    return this.quotes.get(symbol.toUpperCase()) ?? null;
  }
}
