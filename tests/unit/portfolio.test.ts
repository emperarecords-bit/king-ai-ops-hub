import { describe, expect, it } from 'vitest';
import { computePosition, sanitizeSymbol, type TradeLeg } from '@/domain/portfolio/portfolio';

/** Portfolio ledger — the average-cost math and symbol hygiene, pure (no database). */

const buy = (quantity: number, price: number, fees = 0): TradeLeg => ({ side: 'buy', quantity, price, fees });
const sell = (quantity: number, price: number, fees = 0): TradeLeg => ({ side: 'sell', quantity, price, fees });

describe('portfolio position math (average cost)', () => {
  it('averages cost across buys, folding fees into basis', () => {
    const p = computePosition('AAPL', [buy(10, 100, 5), buy(10, 200, 5)]);
    expect(p.quantity).toBe(20);
    // (10*100 + 5 + 10*200 + 5) / 20 = 3010 / 20
    expect(p.avgCost).toBeCloseTo(150.5, 8);
    expect(p.costBasis).toBeCloseTo(3010, 8);
    expect(p.realizedPnl).toBe(0);
  });

  it('realizes P&L on sells at average cost and reduces the basis', () => {
    const p = computePosition('MSFT', [buy(10, 100), sell(4, 150, 2)]);
    // Realized: 4*150 - 2 - 100*4 = 198. Remaining: 6 @ 100.
    expect(p.realizedPnl).toBeCloseTo(198, 8);
    expect(p.quantity).toBe(6);
    expect(p.avgCost).toBeCloseTo(100, 8);
    expect(p.costBasis).toBeCloseTo(600, 8);
  });

  it('a fully closed position reads exactly flat (no float dust)', () => {
    const p = computePosition('NVDA', [buy(3, 33.33), sell(1, 40), sell(2, 50)]);
    expect(p.quantity).toBe(0);
    expect(p.costBasis).toBe(0);
    expect(p.avgCost).toBe(0);
    // Realized: (40 - 33.33) + 2*(50 - 33.33)
    expect(p.realizedPnl).toBeCloseTo(6.67 + 33.34, 6);
  });

  it('losses realize as negative P&L', () => {
    const p = computePosition('GME', [buy(5, 200), sell(5, 40)]);
    expect(p.realizedPnl).toBeCloseTo(-800, 8);
    expect(p.quantity).toBe(0);
  });

  it('handles fractional shares', () => {
    const p = computePosition('VOO', [buy(0.5, 400), buy(0.25, 440)]);
    expect(p.quantity).toBeCloseTo(0.75, 8);
    expect(p.costBasis).toBeCloseTo(310, 8);
  });
});

describe('symbol hygiene', () => {
  it('normalizes case and whitespace', () => {
    expect(sanitizeSymbol(' aapl ')).toBe('AAPL');
    expect(sanitizeSymbol('brk.b')).toBe('BRK.B');
  });

  it('refuses junk instead of repairing it', () => {
    expect(() => sanitizeSymbol('')).toThrow();
    expect(() => sanitizeSymbol('DROP TABLE')).toThrow(); // space
    expect(() => sanitizeSymbol('WAYTOOLONGSYMBOL')).toThrow();
    expect(() => sanitizeSymbol('a$b')).toThrow();
  });
});
