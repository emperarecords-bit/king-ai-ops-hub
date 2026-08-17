'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { toPublicMessage } from '@/lib/errors';
import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import {
  createAccount,
  deleteTrade,
  fetchQuotesFromStooq,
  loadPortfolio,
  recordTrade,
  upsertQuotes,
} from '@/domain/portfolio/portfolio';

export interface PortfolioActionState {
  error: string | null;
  ok: string | null;
}

/** All mutations are admin-only: the ledger is the owner's book, not the team's. */
async function requireAdmin(projectKey: string) {
  const ctx = await requireTenant(projectKey);
  if (ctx.projectRole !== 'admin') throw new Error('Only workspace admins can edit the portfolio.');
  return ctx;
}

const accountSchema = z.object({
  projectKey: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  broker: z.string().trim().max(80).optional(),
});

export async function addAccountAction(_prev: PortfolioActionState, formData: FormData): Promise<PortfolioActionState> {
  const parsed = accountSchema.safeParse({
    projectKey: formData.get('projectKey'),
    name: formData.get('name'),
    broker: formData.get('broker') || undefined,
  });
  if (!parsed.success) return { error: 'Give the account a name (up to 80 characters).', ok: null };
  try {
    const ctx = await requireAdmin(parsed.data.projectKey);
    await withTenant(ctx, (tx) => createAccount(tx, ctx, { name: parsed.data.name, broker: parsed.data.broker }));
    revalidatePath(`/p/${parsed.data.projectKey}/portfolio`);
    return { error: null, ok: `Account "${parsed.data.name}" added.` };
  } catch (err) {
    return { error: toPublicMessage(err), ok: null };
  }
}

const tradeSchema = z.object({
  projectKey: z.string().min(1),
  accountId: z.string().uuid(),
  symbol: z.string().trim().min(1).max(12),
  side: z.enum(['buy', 'sell']),
  quantity: z.coerce.number().positive(),
  price: z.coerce.number().min(0),
  fees: z.coerce.number().min(0).default(0),
  tradedAt: z.string().optional(),
  note: z.string().trim().max(500).optional(),
});

export async function addTradeAction(_prev: PortfolioActionState, formData: FormData): Promise<PortfolioActionState> {
  const parsed = tradeSchema.safeParse({
    projectKey: formData.get('projectKey'),
    accountId: formData.get('accountId'),
    symbol: formData.get('symbol'),
    side: formData.get('side'),
    quantity: formData.get('quantity'),
    price: formData.get('price'),
    fees: formData.get('fees') || 0,
    tradedAt: formData.get('tradedAt') || undefined,
    note: formData.get('note') || undefined,
  });
  if (!parsed.success) return { error: 'Check the trade: account, symbol, side, quantity, and price are required.', ok: null };
  const tradedAt = parsed.data.tradedAt ? new Date(parsed.data.tradedAt) : undefined;
  if (tradedAt && Number.isNaN(tradedAt.getTime())) return { error: 'That trade date is not a real date.', ok: null };
  try {
    const ctx = await requireAdmin(parsed.data.projectKey);
    await withTenant(ctx, (tx) =>
      recordTrade(tx, ctx, {
        accountId: parsed.data.accountId,
        symbol: parsed.data.symbol,
        side: parsed.data.side,
        quantity: parsed.data.quantity,
        price: parsed.data.price,
        fees: parsed.data.fees,
        tradedAt,
        note: parsed.data.note,
      }),
    );
    revalidatePath(`/p/${parsed.data.projectKey}/portfolio`);
    return { error: null, ok: `${parsed.data.side === 'buy' ? 'Bought' : 'Sold'} ${parsed.data.quantity} ${parsed.data.symbol.toUpperCase()}.` };
  } catch (err) {
    return { error: toPublicMessage(err), ok: null };
  }
}

const deleteSchema = z.object({ projectKey: z.string().min(1), tradeId: z.string().uuid() });

export async function deleteTradeAction(_prev: PortfolioActionState, formData: FormData): Promise<PortfolioActionState> {
  const parsed = deleteSchema.safeParse({ projectKey: formData.get('projectKey'), tradeId: formData.get('tradeId') });
  if (!parsed.success) return { error: 'Invalid request.', ok: null };
  try {
    const ctx = await requireAdmin(parsed.data.projectKey);
    await withTenant(ctx, (tx) => deleteTrade(tx, ctx, parsed.data.tradeId));
    revalidatePath(`/p/${parsed.data.projectKey}/portfolio`);
    return { error: null, ok: 'Trade removed.' };
  } catch (err) {
    return { error: toPublicMessage(err), ok: null };
  }
}

const refreshSchema = z.object({ projectKey: z.string().min(1) });

export async function refreshQuotesAction(_prev: PortfolioActionState, formData: FormData): Promise<PortfolioActionState> {
  const parsed = refreshSchema.safeParse({ projectKey: formData.get('projectKey') });
  if (!parsed.success) return { error: 'Invalid request.', ok: null };
  try {
    const ctx = await requireAdmin(parsed.data.projectKey);
    const accounts = await withTenant(ctx, (tx) => loadPortfolio(tx, ctx));
    const symbols = [...new Set(accounts.flatMap((a) => a.positions.filter((p) => p.quantity > 0).map((p) => p.symbol)))];
    if (symbols.length === 0) return { error: null, ok: 'No open positions to price.' };
    const prices = await fetchQuotesFromStooq(symbols);
    const written = await withTenant(ctx, (tx) => upsertQuotes(tx, ctx, prices));
    revalidatePath(`/p/${parsed.data.projectKey}/portfolio`);
    return written === 0
      ? { error: 'The price source returned nothing — try again in a minute.', ok: null }
      : { error: null, ok: `Updated ${written} of ${symbols.length} prices.` };
  } catch (err) {
    return { error: toPublicMessage(err), ok: null };
  }
}
