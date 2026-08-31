/**
 * Read-only market-data client for Public.com (https://api.public.com).
 *
 * RESEARCH-ONLY by construction: it mints a short-lived access token from the
 * PUBLIC_API_KEY secret and reads real-time quotes. It NEVER references any
 * order-placement / trade endpoint — the Stocks desk observes markets, it does
 * not trade.
 *
 * Auth flow (per Public docs):
 *   1. POST /userapiauthservice/personal/access-tokens { validityInMinutes, secret }
 *      -> short-lived bearer JWT.
 *   2. POST /userapigateway/marketdata/{accountId}/quotes { instruments: [...] }
 *      with Authorization: Bearer <jwt>.
 *
 * Response field names are parsed defensively (Public may name the token/quote
 * fields slightly differently than assumed); the account id is resolved from
 * PUBLIC_ACCOUNT_ID if set, otherwise from the accounts endpoint.
 */

const BASE = 'https://api.public.com';
const TOKEN_URL = `${BASE}/userapiauthservice/personal/access-tokens`;
// NOTE: verify against the docs "List Accounts -> Get accounts" path if the
// auto-resolve fails; setting PUBLIC_ACCOUNT_ID bypasses this call entirely.
const ACCOUNTS_URL = `${BASE}/userapigateway/trading/account`;
const quotesUrl = (accountId: string) => `${BASE}/userapigateway/marketdata/${accountId}/quotes`;

async function readBodySnippet(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

async function mintAccessToken(secret: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Short validity: a token is minted per tool call and discarded.
    body: JSON.stringify({ validityInMinutes: 10, secret }),
  });
  if (!res.ok) throw new Error(`Public token mint failed (${res.status}): ${await readBodySnippet(res)}`);
  const data = (await res.json()) as Record<string, unknown>;
  const token = (data.accessToken ?? data.token ?? data.access_token) as string | undefined;
  if (!token) throw new Error('Public token mint returned no access token');
  return token;
}

async function resolveAccountId(token: string): Promise<string> {
  const configured = process.env.PUBLIC_ACCOUNT_ID?.trim();
  if (configured) return configured;
  const res = await fetch(ACCOUNTS_URL, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(
      `Public accounts fetch failed (${res.status}). Set PUBLIC_ACCOUNT_ID on the hub to skip account lookup.`,
    );
  }
  const data = (await res.json()) as Record<string, unknown>;
  const list = (data.accounts ?? data.data ?? data) as unknown;
  const first = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
  const id = (first?.accountId ?? first?.id) as string | undefined;
  if (!id) throw new Error('Could not resolve a Public account id. Set PUBLIC_ACCOUNT_ID on the hub.');
  return id;
}

export interface MarketQuotesResult {
  readonly asOf: string;
  readonly symbols: readonly string[];
  readonly quotes: readonly unknown[];
}

/**
 * Fetch read-only real-time quotes for up to a handful of equity symbols.
 * Throws with a clear message if PUBLIC_API_KEY is unset or the API rejects.
 */
export async function getMarketQuotes(
  symbols: readonly string[],
  now: () => Date = () => new Date(),
): Promise<MarketQuotesResult> {
  const secret = process.env.PUBLIC_API_KEY?.trim();
  if (!secret) throw new Error('PUBLIC_API_KEY is not configured on the hub.');

  const cleaned = [...new Set(symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  if (cleaned.length === 0) throw new Error('No symbols provided.');

  const token = await mintAccessToken(secret);
  const accountId = await resolveAccountId(token);

  const res = await fetch(quotesUrl(accountId), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ instruments: cleaned.map((symbol) => ({ symbol, type: 'EQUITY' })) }),
  });
  if (!res.ok) throw new Error(`Public quotes failed (${res.status}): ${await readBodySnippet(res)}`);

  const data = (await res.json()) as Record<string, unknown>;
  const quotesRaw = (data.quotes ?? data.data ?? data) as unknown;
  const quotes = Array.isArray(quotesRaw) ? quotesRaw : [data];
  return { asOf: now().toISOString(), symbols: cleaned, quotes };
}
