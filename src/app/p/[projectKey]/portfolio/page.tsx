import { requireTenant } from '@/domain/auth/guard';
import { withTenant } from '@/db/tenant';
import { listRecentTrades, loadPortfolio, loadQuotes } from '@/domain/portfolio/portfolio';
import { Card, EmptyState, PageHeader } from '@/components/ui';
import { AddAccountForm, AddTradeForm, DeleteTradeButton, RefreshQuotesButton } from './forms';

/**
 * The owner's position ledger (owner directive 2026-08-17): "I make the trades, but all my
 * accounts are being tracked." The hub never touches a brokerage — every row here is
 * owner-entered, and the same snapshot feeds this workspace's AI runs as context.
 */
export default async function PortfolioPage({ params }: { params: Promise<{ projectKey: string }> }) {
  const { projectKey } = await params;
  const ctx = await requireTenant(projectKey);
  const canEdit = ctx.projectRole === 'admin';
  const [accounts, trades] = await Promise.all([
    withTenant(ctx, (tx) => loadPortfolio(tx, ctx)),
    withTenant(ctx, (tx) => listRecentTrades(tx, ctx)),
  ]);
  const symbols = [...new Set(accounts.flatMap((a) => a.positions.map((p) => p.symbol)))];
  const quotes = await withTenant(ctx, (tx) => loadQuotes(tx, ctx, symbols));
  const money = (n: number): string =>
    n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const openAccounts = accounts.filter((a) => a.status === 'active');

  let totalValue = 0;
  let totalBasis = 0;
  let priced = 0;
  let openCount = 0;
  for (const a of accounts) {
    for (const p of a.positions) {
      if (p.quantity <= 0) continue;
      openCount++;
      totalBasis += p.costBasis;
      const q = quotes.get(p.symbol);
      if (q) {
        totalValue += p.quantity * q.price;
        priced++;
      }
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Portfolio"
        subtitle="Your positions, tracked. You place every trade in your brokerage — record it here and the whole desk works from what you actually own."
      />

      {accounts.length === 0 ? (
        <EmptyState>
          No accounts yet. Add one per brokerage (Robinhood, Fidelity, …), then record your buys
          and sells — positions, cost basis, and P&L appear here and your team sees the snapshot.
        </EmptyState>
      ) : (
        <>
          {openCount > 0 ? (
            <Card className="mb-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm">
                  <span className="font-semibold">{openCount}</span> open position{openCount === 1 ? '' : 's'} · cost
                  basis <span className="font-semibold">${money(totalBasis)}</span>
                  {priced > 0 ? (
                    <>
                      {' '}
                      · marked value <span className="font-semibold">${money(totalValue)}</span>
                      {priced < openCount ? (
                        <span className="text-[var(--muted)]"> ({priced} of {openCount} priced)</span>
                      ) : null}
                    </>
                  ) : (
                    <span className="text-[var(--muted)]"> · no prices yet — refresh to mark</span>
                  )}
                </p>
                {canEdit ? <RefreshQuotesButton projectKey={projectKey} /> : null}
              </div>
            </Card>
          ) : null}

          <div className="space-y-6">
            {accounts.map((a) => (
              <Card key={a.id}>
                <p className="mb-3 text-sm font-semibold">
                  {a.name}
                  {a.broker ? <span className="font-normal text-[var(--muted)]"> · {a.broker}</span> : null}
                  {a.status === 'closed' ? <span className="font-normal text-[var(--muted)]"> · closed</span> : null}
                </p>
                {a.positions.length === 0 ? (
                  <p className="text-sm text-[var(--muted)]">No positions recorded.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                          <th className="py-1 pr-4">Symbol</th>
                          <th className="py-1 pr-4">Shares</th>
                          <th className="py-1 pr-4">Avg cost</th>
                          <th className="py-1 pr-4">Cost basis</th>
                          <th className="py-1 pr-4">Last price</th>
                          <th className="py-1 pr-4">Value</th>
                          <th className="py-1 pr-4">Unrealized</th>
                          <th className="py-1">Realized</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.positions.map((p) => {
                          const q = quotes.get(p.symbol);
                          const value = q && p.quantity > 0 ? p.quantity * q.price : null;
                          const unreal = value != null ? value - p.costBasis : null;
                          return (
                            <tr key={p.symbol} className="border-t border-[var(--border)]">
                              <td className="py-1.5 pr-4 font-semibold">{p.symbol}</td>
                              <td className="py-1.5 pr-4">{p.quantity > 0 ? p.quantity : '—'}</td>
                              <td className="py-1.5 pr-4">{p.quantity > 0 ? `$${money(p.avgCost)}` : '—'}</td>
                              <td className="py-1.5 pr-4">{p.quantity > 0 ? `$${money(p.costBasis)}` : '—'}</td>
                              <td className="py-1.5 pr-4">{q ? `$${money(q.price)}` : '—'}</td>
                              <td className="py-1.5 pr-4">{value != null ? `$${money(value)}` : '—'}</td>
                              <td className={`py-1.5 pr-4 ${unreal != null ? (unreal >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]') : ''}`}>
                                {unreal != null ? `${unreal >= 0 ? '+' : '−'}$${money(Math.abs(unreal))}` : '—'}
                              </td>
                              <td className={`py-1.5 ${Math.abs(p.realizedPnl) > 1e-9 ? (p.realizedPnl >= 0 ? 'text-[var(--success)]' : 'text-[var(--danger)]') : ''}`}>
                                {Math.abs(p.realizedPnl) > 1e-9 ? `${p.realizedPnl >= 0 ? '+' : '−'}$${money(Math.abs(p.realizedPnl))}` : '—'}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            ))}
          </div>
        </>
      )}

      {canEdit ? (
        <div className="mt-6 space-y-4">
          {openAccounts.length > 0 ? (
            <Card>
              <p className="mb-3 text-sm font-semibold">Record a trade</p>
              <AddTradeForm projectKey={projectKey} accounts={openAccounts.map((a) => ({ id: a.id, name: a.name }))} />
            </Card>
          ) : null}
          <Card>
            <p className="mb-3 text-sm font-semibold">Add an account</p>
            <AddAccountForm projectKey={projectKey} />
          </Card>
        </div>
      ) : null}

      {trades.length > 0 ? (
        <Card className="mt-6">
          <p className="mb-3 text-sm font-semibold">Recent trades</p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-[var(--muted)]">
                  <th className="py-1 pr-4">Date</th>
                  <th className="py-1 pr-4">Account</th>
                  <th className="py-1 pr-4">Side</th>
                  <th className="py-1 pr-4">Symbol</th>
                  <th className="py-1 pr-4">Shares</th>
                  <th className="py-1 pr-4">Price</th>
                  <th className="py-1 pr-4">Fees</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {trades.map((t) => (
                  <tr key={t.id} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-4">{t.tradedAt.toISOString().slice(0, 10)}</td>
                    <td className="py-1.5 pr-4">{t.accountName}</td>
                    <td className="py-1.5 pr-4">{t.side}</td>
                    <td className="py-1.5 pr-4 font-semibold">{t.symbol}</td>
                    <td className="py-1.5 pr-4">{t.quantity}</td>
                    <td className="py-1.5 pr-4">${money(t.price)}</td>
                    <td className="py-1.5 pr-4">{t.fees > 0 ? `$${money(t.fees)}` : '—'}</td>
                    <td className="py-1.5">{canEdit ? <DeleteTradeButton projectKey={projectKey} tradeId={t.id} /> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}
    </div>
  );
}
