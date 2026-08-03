import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INSTRUMENT_KINDS,
  ORDER_SIDES,
  THESIS_DIRECTIONS,
  TRADING_CURRENCIES,
  TRADING_EXECUTION_MODES,
} from '@/types/trading';
import * as schema from '@/db/schema';

/**
 * Stock Trading P1 — static architecture guard. Trading domain modules must be pure/offline: NO live brokerage or
 * money-movement client, NO network client. Also pins the hard phase invariants (paper-only, USD-only, long-only,
 * equity/ETF-only) and proves every trading table is (org, project) tenant-scoped.
 */

const ROOT = process.cwd();
const DIR = join(ROOT, 'src', 'domain', 'trading');

function tradingSources(): { file: string; src: string }[] {
  return readdirSync(DIR)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => ({ file: f, src: readFileSync(join(DIR, f), 'utf8') }));
}

// Live brokerage / money-movement SDKs and network clients that trading logic must never IMPORT. These are matched
// against actual import/require specifiers (not prose), so a comment like "no live brokerage" is not a false match.
const FORBIDDEN_MODULES = [
  'alpaca', 'ibkr', 'interactive-brokers', 'e-trade', 'etrade', 'td-ameritrade', 'robinhood',
  'stripe', 'plaid', 'coinbase', 'binance', 'ccxt',
  'node:http', 'node:https', 'node:net', 'node:dgram', 'node-fetch', 'undici', 'axios', 'got', 'ws', 'dotenv',
];

/** Extract every import/require module specifier from a source file. */
function importSpecifiers(src: string): string[] {
  const specs: string[] = [];
  for (const re of [/from\s+['"]([^'"]+)['"]/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of src.matchAll(re)) specs.push(m[1]!);
  }
  return specs;
}

describe('Trading P1 import boundary', () => {
  it('has the expected trading domain modules', () => {
    const files = tradingSources().map((r) => r.file).sort();
    expect(files).toEqual(
      expect.arrayContaining([
        'audit-actions.ts',
        'execution-mode.ts',
        'market-data-adapter.ts',
        'money.ts',
        'order-state-machine.ts',
        'paper-broker-adapter.ts',
        'risk-limits.ts',
      ]),
    );
  });

  it('imports no live brokerage / money-movement SDK and no network/credentials module', () => {
    for (const { file, src } of tradingSources()) {
      const specs = importSpecifiers(src);
      for (const spec of specs) {
        for (const bad of FORBIDDEN_MODULES) {
          expect(spec === bad || spec.includes(bad + '/') || spec.startsWith(bad + '@'), `${file} must not import ${bad} (found ${spec})`).toBe(false);
        }
      }
      // No environment/credential access at all.
      expect(/process\.env/.test(src), `${file} must not read process.env`).toBe(false);
    }
  });

  it('performs no network I/O primitives (fetch/XMLHttpRequest/WebSocket)', () => {
    for (const { file, src } of tradingSources()) {
      for (const re of [/\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bWebSocket\b/, /\.request\s*\(/]) {
        expect(re.test(src), `${file} must not perform network I/O (${re})`).toBe(false);
      }
    }
  });

  it('pins the hard phase invariants', () => {
    expect(TRADING_EXECUTION_MODES).toEqual(['paper']); // paper only — live is not representable
    expect(TRADING_CURRENCIES).toEqual(['USD']); // USD only
    expect(INSTRUMENT_KINDS).toEqual(['equity', 'etf']); // equities + (unleveraged) ETFs only
    expect(ORDER_SIDES).toEqual(['buy', 'sell']); // long-only: buy opens, sell closes
    expect(THESIS_DIRECTIONS).toEqual(['long']); // long only
  });

  it('every trading table is (org, project) tenant-scoped', () => {
    const tables = [
      schema.instruments, schema.watchlists, schema.watchlistItems, schema.marketQuotes, schema.researchNotes,
      schema.tradeTheses, schema.paperPortfolios, schema.paperPositions, schema.paperOrders, schema.paperFills,
      schema.riskLimits, schema.restrictedSymbols, schema.riskChecks, schema.killSwitches,
    ];
    expect(tables.length).toBe(14);
    for (const t of tables) {
      const cols = t as unknown as Record<string, unknown>;
      expect(cols.orgId, 'table missing orgId').toBeTruthy();
      expect(cols.projectId, 'table missing projectId').toBeTruthy();
    }
  });
});
