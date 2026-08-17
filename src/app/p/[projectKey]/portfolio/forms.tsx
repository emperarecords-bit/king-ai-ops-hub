'use client';

import { useActionState } from 'react';
import {
  addAccountAction,
  addTradeAction,
  deleteTradeAction,
  refreshQuotesAction,
  type PortfolioActionState,
} from './actions';

const INITIAL: PortfolioActionState = { error: null, ok: null };

const inputCls = 'rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 text-sm';
const buttonCls = 'rounded bg-[var(--accent)] px-3 py-1.5 text-sm font-semibold text-[#0b0e14] disabled:opacity-60';

function Feedback({ state }: { state: PortfolioActionState }) {
  if (state.error) return <span className="text-sm text-[var(--danger)]">{state.error}</span>;
  if (state.ok) return <span className="text-sm text-[var(--success)]">{state.ok}</span>;
  return null;
}

export function AddAccountForm({ projectKey }: { projectKey: string }) {
  const [state, formAction, pending] = useActionState(addAccountAction, INITIAL);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input name="name" placeholder="Account name (e.g. Robinhood — personal)" maxLength={80} required className={`${inputCls} w-64`} />
      <input name="broker" placeholder="Broker (optional)" maxLength={80} className={`${inputCls} w-40`} />
      <button type="submit" disabled={pending} className={buttonCls}>
        {pending ? 'Adding…' : 'Add account'}
      </button>
      <Feedback state={state} />
    </form>
  );
}

export function AddTradeForm({
  projectKey,
  accounts,
}: {
  projectKey: string;
  accounts: { id: string; name: string }[];
}) {
  const [state, formAction, pending] = useActionState(addTradeAction, INITIAL);
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <label className="text-sm">
        <span className="mb-1 block text-xs text-[var(--muted)]">Account</span>
        <select name="accountId" required className={inputCls}>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-xs text-[var(--muted)]">Side</span>
        <select name="side" required className={inputCls}>
          <option value="buy">Buy</option>
          <option value="sell">Sell</option>
        </select>
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-xs text-[var(--muted)]">Symbol</span>
        <input name="symbol" placeholder="AAPL" maxLength={12} required className={`${inputCls} w-24 uppercase`} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-xs text-[var(--muted)]">Shares</span>
        <input name="quantity" type="number" step="any" min="0" required className={`${inputCls} w-24`} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-xs text-[var(--muted)]">Price</span>
        <input name="price" type="number" step="any" min="0" required className={`${inputCls} w-24`} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-xs text-[var(--muted)]">Fees</span>
        <input name="fees" type="number" step="any" min="0" placeholder="0" className={`${inputCls} w-20`} />
      </label>
      <label className="text-sm">
        <span className="mb-1 block text-xs text-[var(--muted)]">Date</span>
        <input name="tradedAt" type="date" className={inputCls} />
      </label>
      <button type="submit" disabled={pending} className={buttonCls}>
        {pending ? 'Recording…' : 'Record trade'}
      </button>
      <Feedback state={state} />
    </form>
  );
}

export function DeleteTradeButton({ projectKey, tradeId }: { projectKey: string; tradeId: string }) {
  const [state, formAction, pending] = useActionState(deleteTradeAction, INITIAL);
  return (
    <form action={formAction} className="inline">
      <input type="hidden" name="projectKey" value={projectKey} />
      <input type="hidden" name="tradeId" value={tradeId} />
      <button
        type="submit"
        disabled={pending}
        title="Remove this trade (typo correction)"
        className="text-xs text-[var(--muted)] underline disabled:opacity-60"
      >
        {pending ? '…' : 'remove'}
      </button>
      {state.error ? <span className="ml-1 text-xs text-[var(--danger)]">{state.error}</span> : null}
    </form>
  );
}

export function RefreshQuotesButton({ projectKey }: { projectKey: string }) {
  const [state, formAction, pending] = useActionState(refreshQuotesAction, INITIAL);
  return (
    <form action={formAction} className="flex items-center gap-2">
      <input type="hidden" name="projectKey" value={projectKey} />
      <button type="submit" disabled={pending} className="rounded border border-[var(--border)] px-3 py-1.5 text-sm disabled:opacity-60">
        {pending ? 'Fetching prices…' : 'Refresh prices'}
      </button>
      <Feedback state={state} />
    </form>
  );
}
