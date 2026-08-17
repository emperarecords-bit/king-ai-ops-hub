import 'server-only';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { brokerageAccounts, portfolioTrades, symbolQuotes } from '@/db/schema';
import { type DbTx } from '@/db/client';
import { writeAudit } from '@/domain/audit/audit';
import { AppError, NotFoundError } from '@/lib/errors';
import { type TenantContext } from '@/types/domain';

/**
 * Portfolio ledger (owner directive 2026-08-17): the owner places every trade personally in
 * their own brokerage; the hub tracks what they record here. This module never talks to a
 * brokerage, never executes anything, and never tells anyone to buy or sell — it is bookkeeping
 * (accounts, trades, average-cost positions, realized/unrealized P&L) plus a compact snapshot
 * injected into runs so the research desk works from real holdings.
 */

export interface TradeInput {
  accountId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fees?: number;
  tradedAt?: Date;
  note?: string | null;
}

export interface TradeLeg {
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  fees: number;
}

export interface Position {
  symbol: string;
  quantity: number;
  /** Average cost per share of the open lot (fees folded in). */
  avgCost: number;
  costBasis: number;
  /** Realized P&L accumulated by past sells of this symbol (fees deducted). */
  realizedPnl: number;
}

const SYMBOL_RE = /^[A-Z0-9.-]{1,12}$/;

export function sanitizeSymbol(raw: string): string {
  const s = raw.trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) {
    throw new AppError('validation', 'Ticker symbols are 1-12 characters: letters, digits, dot, dash.');
  }
  return s;
}

/**
 * Average-cost bookkeeping over chronological trades of ONE symbol in ONE account.
 * Buys fold fees into cost basis; sells realize (proceeds - fees) - avgCost * qty.
 * Pure so the math is unit-testable without a database.
 */
export function computePosition(symbol: string, legs: TradeLeg[]): Position {
  let quantity = 0;
  let costBasis = 0;
  let realizedPnl = 0;
  for (const leg of legs) {
    if (leg.side === 'buy') {
      costBasis += leg.quantity * leg.price + leg.fees;
      quantity += leg.quantity;
    } else {
      const avg = quantity > 0 ? costBasis / quantity : 0;
      realizedPnl += leg.quantity * leg.price - leg.fees - avg * leg.quantity;
      costBasis -= avg * leg.quantity;
      quantity -= leg.quantity;
    }
  }
  // Clamp float dust so a fully-closed position reads exactly flat.
  if (Math.abs(quantity) < 1e-9) {
    quantity = 0;
    costBasis = 0;
  }
  return { symbol, quantity, avgCost: quantity > 0 ? costBasis / quantity : 0, costBasis, realizedPnl };
}

export async function createAccount(
  tx: DbTx,
  ctx: TenantContext,
  input: { name: string; broker?: string | null },
): Promise<{ id: string }> {
  const name = input.name.trim();
  if (name.length < 1 || name.length > 80) throw new AppError('validation', 'Account name must be 1-80 characters.');
  const [row] = await tx
    .insert(brokerageAccounts)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      name,
      broker: input.broker?.trim() || null,
      createdBy: ctx.userId,
    })
    .returning({ id: brokerageAccounts.id });
  if (!row) throw new Error('account insert returned no row');
  await writeAudit(tx, ctx, {
    action: 'portfolio.account_created',
    entityType: 'brokerage_account',
    entityId: row.id,
    detail: { name },
  });
  return row;
}

export async function recordTrade(tx: DbTx, ctx: TenantContext, input: TradeInput): Promise<{ id: string }> {
  const symbol = sanitizeSymbol(input.symbol);
  const quantity = input.quantity;
  const price = input.price;
  const fees = input.fees ?? 0;
  if (!Number.isFinite(quantity) || quantity <= 0) throw new AppError('validation', 'Quantity must be a positive number.');
  if (!Number.isFinite(price) || price < 0) throw new AppError('validation', 'Price must be zero or positive.');
  if (!Number.isFinite(fees) || fees < 0) throw new AppError('validation', 'Fees must be zero or positive.');

  const [account] = await tx
    .select({ id: brokerageAccounts.id, status: brokerageAccounts.status })
    .from(brokerageAccounts)
    .where(and(eq(brokerageAccounts.id, input.accountId), eq(brokerageAccounts.projectId, ctx.projectId)));
  if (!account) throw new NotFoundError('Account');
  if (account.status !== 'active') throw new AppError('validation', 'That account is closed.');

  if (input.side === 'sell') {
    const legs = await tradeLegs(tx, account.id, symbol);
    const held = computePosition(symbol, legs).quantity;
    if (quantity > held + 1e-9) {
      throw new AppError(
        'validation',
        `That sell (${quantity}) exceeds the ${held} ${symbol} this account holds. ` +
          'The ledger tracks long positions only — record the missing buys first.',
      );
    }
  }

  const [row] = await tx
    .insert(portfolioTrades)
    .values({
      orgId: ctx.orgId,
      projectId: ctx.projectId,
      accountId: account.id,
      symbol,
      side: input.side,
      quantity: String(quantity),
      price: String(price),
      fees: String(fees),
      tradedAt: input.tradedAt ?? new Date(),
      note: input.note?.trim() || null,
      createdBy: ctx.userId,
    })
    .returning({ id: portfolioTrades.id });
  if (!row) throw new Error('trade insert returned no row');
  await writeAudit(tx, ctx, {
    action: 'portfolio.trade_recorded',
    entityType: 'portfolio_trade',
    entityId: row.id,
    detail: { symbol, side: input.side, quantity, price },
  });
  return row;
}

/** Owner typo correction. The audit row is the durable record of the removal. */
export async function deleteTrade(tx: DbTx, ctx: TenantContext, tradeId: string): Promise<void> {
  const [row] = await tx
    .delete(portfolioTrades)
    .where(and(eq(portfolioTrades.id, tradeId), eq(portfolioTrades.projectId, ctx.projectId)))
    .returning({ symbol: portfolioTrades.symbol, side: portfolioTrades.side, quantity: portfolioTrades.quantity });
  if (!row) throw new NotFoundError('Trade');
  await writeAudit(tx, ctx, {
    action: 'portfolio.trade_deleted',
    entityType: 'portfolio_trade',
    entityId: tradeId,
    detail: { symbol: row.symbol, side: row.side, quantity: row.quantity },
  });
}

async function tradeLegs(tx: DbTx, accountId: string, symbol: string): Promise<TradeLeg[]> {
  const rows = await tx
    .select({
      side: portfolioTrades.side,
      quantity: portfolioTrades.quantity,
      price: portfolioTrades.price,
      fees: portfolioTrades.fees,
      tradedAt: portfolioTrades.tradedAt,
    })
    .from(portfolioTrades)
    .where(and(eq(portfolioTrades.accountId, accountId), eq(portfolioTrades.symbol, symbol)))
    .orderBy(asc(portfolioTrades.tradedAt), asc(portfolioTrades.createdAt));
  return rows.map((r) => ({
    side: r.side as 'buy' | 'sell',
    quantity: Number(r.quantity),
    price: Number(r.price),
    fees: Number(r.fees),
  }));
}

export interface AccountView {
  id: string;
  name: string;
  broker: string | null;
  status: string;
  positions: Position[];
}

export async function loadPortfolio(tx: DbTx, ctx: TenantContext): Promise<AccountView[]> {
  const accounts = await tx
    .select({
      id: brokerageAccounts.id,
      name: brokerageAccounts.name,
      broker: brokerageAccounts.broker,
      status: brokerageAccounts.status,
    })
    .from(brokerageAccounts)
    .where(eq(brokerageAccounts.projectId, ctx.projectId))
    .orderBy(asc(brokerageAccounts.name));
  if (accounts.length === 0) return [];

  const rows = await tx
    .select({
      accountId: portfolioTrades.accountId,
      symbol: portfolioTrades.symbol,
      side: portfolioTrades.side,
      quantity: portfolioTrades.quantity,
      price: portfolioTrades.price,
      fees: portfolioTrades.fees,
    })
    .from(portfolioTrades)
    .where(eq(portfolioTrades.projectId, ctx.projectId))
    .orderBy(asc(portfolioTrades.tradedAt), asc(portfolioTrades.createdAt));

  const byAccountSymbol = new Map<string, TradeLeg[]>();
  for (const r of rows) {
    const key = `${r.accountId} ${r.symbol}`;
    const legs = byAccountSymbol.get(key) ?? [];
    legs.push({ side: r.side as 'buy' | 'sell', quantity: Number(r.quantity), price: Number(r.price), fees: Number(r.fees) });
    byAccountSymbol.set(key, legs);
  }

  return accounts.map((a) => {
    const positions: Position[] = [];
    for (const [key, legs] of byAccountSymbol) {
      const sep = key.indexOf(' ');
      const accountId = key.slice(0, sep);
      const symbol = key.slice(sep + 1);
      if (accountId !== a.id) continue;
      const p = computePosition(symbol, legs);
      if (p.quantity > 0 || Math.abs(p.realizedPnl) > 1e-9) positions.push(p);
    }
    positions.sort((x, y) => x.symbol.localeCompare(y.symbol));
    return { ...a, positions };
  });
}

export interface TradeView {
  id: string;
  accountName: string;
  symbol: string;
  side: string;
  quantity: number;
  price: number;
  fees: number;
  tradedAt: Date;
  note: string | null;
}

export async function listRecentTrades(tx: DbTx, ctx: TenantContext, limit = 30): Promise<TradeView[]> {
  const rows = await tx
    .select({
      id: portfolioTrades.id,
      accountName: brokerageAccounts.name,
      symbol: portfolioTrades.symbol,
      side: portfolioTrades.side,
      quantity: portfolioTrades.quantity,
      price: portfolioTrades.price,
      fees: portfolioTrades.fees,
      tradedAt: portfolioTrades.tradedAt,
      note: portfolioTrades.note,
    })
    .from(portfolioTrades)
    .innerJoin(brokerageAccounts, eq(portfolioTrades.accountId, brokerageAccounts.id))
    .where(eq(portfolioTrades.projectId, ctx.projectId))
    .orderBy(desc(portfolioTrades.tradedAt), desc(portfolioTrades.createdAt))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    quantity: Number(r.quantity),
    price: Number(r.price),
    fees: Number(r.fees),
  }));
}

export interface QuoteView {
  symbol: string;
  price: number;
  asOf: Date;
}

export async function loadQuotes(tx: DbTx, ctx: TenantContext, symbols: string[]): Promise<Map<string, QuoteView>> {
  if (symbols.length === 0) return new Map();
  const rows = await tx
    .select({ symbol: symbolQuotes.symbol, price: symbolQuotes.price, asOf: symbolQuotes.asOf })
    .from(symbolQuotes)
    .where(and(eq(symbolQuotes.projectId, ctx.projectId), inArray(symbolQuotes.symbol, symbols)));
  return new Map(rows.map((r) => [r.symbol, { symbol: r.symbol, price: Number(r.price), asOf: r.asOf }]));
}

/**
 * Best-effort end-of-day prices from Stooq's free CSV endpoint (no key, US listings as
 * `<sym>.us`). Failures skip the symbol — the ledger works without prices; they only
 * feed the unrealized P&L display. Called from an owner-initiated action, never a render.
 */
export async function fetchQuotesFromStooq(
  symbols: string[],
  fetcher: typeof fetch = fetch,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const symbol of symbols.slice(0, 50)) {
    try {
      const s = symbol.toLowerCase().replace(/[^a-z0-9.-]/g, '');
      const res = await fetcher(`https://stooq.com/q/l/?s=${s}.us&f=sd2t2ohlcv&h&e=csv`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) continue;
      const text = await res.text();
      const line = text.trim().split('\n')[1];
      if (!line) continue;
      const close = Number(line.split(',')[6]);
      if (Number.isFinite(close) && close > 0) out.set(symbol, close);
    } catch {
      // Unpriced symbols simply stay unpriced.
    }
  }
  return out;
}

export async function upsertQuotes(tx: DbTx, ctx: TenantContext, prices: Map<string, number>): Promise<number> {
  const asOf = new Date();
  let written = 0;
  for (const [symbol, price] of prices) {
    await tx
      .insert(symbolQuotes)
      .values({ orgId: ctx.orgId, projectId: ctx.projectId, symbol, price: String(price), asOf })
      .onConflictDoUpdate({
        target: [symbolQuotes.projectId, symbolQuotes.symbol],
        set: { price: String(price), asOf, updatedAt: asOf },
      });
    written++;
  }
  return written;
}

const BRIEFING_CAP = 4000;

/**
 * Compact holdings snapshot for run context (HUB_STATE). Null when the workspace has no
 * accounts, so the injection costs nothing everywhere portfolios aren't used.
 */
export async function assemblePortfolioBriefing(tx: DbTx, ctx: TenantContext): Promise<string | null> {
  const accounts = await loadPortfolio(tx, ctx);
  if (accounts.length === 0) return null;
  const symbols = [...new Set(accounts.flatMap((a) => a.positions.map((p) => p.symbol)))];
  const quotes = await loadQuotes(tx, ctx, symbols);
  const lines: string[] = [
    'OWNER PORTFOLIO SNAPSHOT (owner-entered ledger; the owner places all trades personally).',
    'This desk researches and frames risk. It never executes trades and never issues buy/sell directives.',
    '',
  ];
  for (const a of accounts) {
    lines.push(`Account: ${a.name}${a.broker ? ` (${a.broker})` : ''}${a.status === 'closed' ? ' [closed]' : ''}`);
    if (a.positions.length === 0) {
      lines.push('  (no positions recorded)');
      continue;
    }
    for (const p of a.positions) {
      const q = quotes.get(p.symbol);
      const mark = q ? ` | last ${q.price.toFixed(2)} (${q.asOf.toISOString().slice(0, 10)})` : '';
      const open =
        p.quantity > 0 ? `${p.quantity} @ avg ${p.avgCost.toFixed(2)} (basis ${p.costBasis.toFixed(2)})` : 'closed';
      const realized = Math.abs(p.realizedPnl) > 1e-9 ? ` | realized ${p.realizedPnl.toFixed(2)}` : '';
      lines.push(`  ${p.symbol}: ${open}${mark}${realized}`);
    }
  }
  const text = lines.join('\n');
  return text.length > BRIEFING_CAP ? `${text.slice(0, BRIEFING_CAP)}\n[truncated]` : text;
}
