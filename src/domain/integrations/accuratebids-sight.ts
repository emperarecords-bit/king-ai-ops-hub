import 'server-only';

/**
 * AccurateBids sight (owner, 2026-08-17: "so empera air conditioning still cant access
 * accuratebids info" — now they can, read-only): workspaces named in
 * ACCURATEBIDS_SIGHT_PROJECT_KEYS get a live snapshot of the owner's real AccurateBids book
 * (quote pipeline, recent quotes, invoices with paid amounts and balances) injected into every
 * run as HUB_STATE. The endpoint (hub-snapshot) writes nothing and is pinned server-side to the
 * owner's contractor account; failures degrade to "no snapshot", never a failed run.
 */

export interface AccurateBidsSightDeps {
  readonly snapshotUrl: string | undefined;
  readonly serviceToken: string | undefined;
  readonly fetcher?: typeof fetch;
}

export function sightDepsFromEnv(env: Record<string, string | undefined> = process.env): AccurateBidsSightDeps {
  return { snapshotUrl: env.ACCURATEBIDS_SNAPSHOT_URL, serviceToken: env.ACCURATEBIDS_SERVICE_TOKEN };
}

/** Project keys whose runs carry the snapshot. Unset means the feature is off everywhere. */
export function sightEnabledKeys(env: Record<string, string | undefined> = process.env): string[] {
  return (env.ACCURATEBIDS_SIGHT_PROJECT_KEYS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

interface SnapshotQuote {
  job_name?: unknown;
  customer_name?: unknown;
  status?: unknown;
  grand_total?: unknown;
  deposit_paid?: unknown;
  bid_date?: unknown;
}

interface SnapshotInvoice {
  invoice_number?: unknown;
  job_name?: unknown;
  customer_name?: unknown;
  status?: unknown;
  amount?: unknown;
  paid_amount?: unknown;
  balance_due?: unknown;
  payment_method?: unknown;
  due_date?: unknown;
}

const CAP = 6000;
const s = (v: unknown, max = 80): string => (typeof v === 'string' ? v.slice(0, max) : '');
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const money = (v: unknown): string => `$${n(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

/** Pure formatter so the briefing shape is unit-testable without a network. */
export function formatSightBriefing(data: Record<string, unknown>): string {
  const quotes = (data.quotes ?? {}) as Record<string, unknown>;
  const invoices = (data.invoices ?? {}) as Record<string, unknown>;
  const byStatus = (quotes.by_status ?? {}) as Record<string, unknown>;
  const lines: string[] = [
    `ACCURATEBIDS LIVE SNAPSHOT (read-only; the owner's real book of business as of ${s(data.as_of, 30) || 'now'}).`,
    'This is the current truth for jobs, quotes, and money in AccurateBids. Verify against THIS before asking the owner whether something "made it in".',
    '',
    `Quotes: ${n(quotes.total)} total (${Object.entries(byStatus)
      .map(([k, v]) => `${k} ${n(v)}`)
      .join(', ')}) | won revenue ${money(quotes.won_total)}`,
    `Invoices: ${n(invoices.total)} total | ${n(invoices.open_count)} with open balance | outstanding ${money(invoices.open_balance)}`,
  ];
  const recentQuotes = Array.isArray(quotes.recent) ? (quotes.recent as SnapshotQuote[]) : [];
  if (recentQuotes.length > 0) {
    lines.push('', 'Recent quotes (newest first; the [id] is what an accuratebids_invoice payload needs to invoice a quote):');
    for (const q of recentQuotes) {
      const qid = (q as Record<string, unknown>).id;
      lines.push(
        `  ${qid ? `[id ${s(qid, 40)}] ` : ''}${s(q.bid_date, 10)} | ${s(q.job_name, 90)} | ${s(q.customer_name, 40)} | ${s(q.status, 20)} | ${money(q.grand_total)}${q.deposit_paid === true ? ' | deposit PAID' : ''}`,
      );
    }
  }
  const recentInvoices = Array.isArray(invoices.recent) ? (invoices.recent as SnapshotInvoice[]) : [];
  if (recentInvoices.length > 0) {
    lines.push('', 'Recent invoices (newest first):');
    for (const inv of recentInvoices) {
      const paid = n(inv.paid_amount);
      const due = n(inv.balance_due);
      lines.push(
        `  #${s(inv.invoice_number, 20)} | ${s(inv.job_name, 70)} | ${s(inv.customer_name, 40)} | ${s(inv.status, 20)} | ${money(inv.amount)}${paid > 0 ? ` | paid ${money(paid)}${inv.payment_method ? ` (${s(inv.payment_method, 20)})` : ''}` : ''}${due > 0 ? ` | DUE ${money(due)}` : ''}`,
      );
    }
  }
  // Email Desk: unanswered support inquiries. The id is what an accuratebids_reply payload needs.
  const support = (data.support ?? {}) as Record<string, unknown>;
  const openInquiries = Array.isArray(support.open) ? (support.open as Record<string, unknown>[]) : [];
  if (openInquiries.length > 0) {
    lines.push('', `EMAIL DESK - ${openInquiries.length} unanswered support inquiries (draft a reply and propose it as an accuratebids_reply action; the owner's approval sends it):`);
    for (const q of openInquiries) {
      lines.push(`  [id ${s(q.id, 40)}] ${s(q.created_at, 10)} | ${s(q.name, 40)} <${s(q.email, 60)}> | ${s(q.topic, 40)}`);
      lines.push(`    "${s(q.message, 300)}"`);
    }
  }
  const text = lines.join('\n');
  return text.length > CAP ? `${text.slice(0, CAP)}\n[truncated]` : text;
}

/** Fetch + format, or null (missing config, timeout, non-200, bad JSON — the run continues). */
export async function assembleAccurateBidsSight(deps: AccurateBidsSightDeps = sightDepsFromEnv()): Promise<string | null> {
  if (!deps.snapshotUrl || !deps.serviceToken) return null;
  try {
    const fetcher = deps.fetcher ?? fetch;
    const res = await fetcher(deps.snapshotUrl, {
      method: 'GET',
      headers: { Authorization: `Bearer ${deps.serviceToken}` },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return null;
    return formatSightBriefing(data);
  } catch {
    return null;
  }
}
