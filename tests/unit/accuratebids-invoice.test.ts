import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import {
  AccurateBidsQuoteExecutor,
  type AccurateBidsQuoteExecutorDeps,
} from '@/domain/execution/accuratebids-quote-executor';
import { type ExecutorAction } from '@/domain/execution/executor-contract';

/** Invoice side — the accuratebids_invoice lane: strict payload, double-billing refusal. */

const FROM_QUOTE = {
  kind: 'accuratebids_invoice',
  quote_id: '4c5e2a92-fa7c-49db-b9fd-8eb31cb8b901',
};

const DIRECT = {
  kind: 'accuratebids_invoice',
  customer_name: 'Pat Example',
  job_name: 'Boiler service call',
  line_items: [{ description: 'Diagnostic + repair', qty: 2, unit_price: 150 }],
  tax_percent: 8.625,
};

function action(payload: Record<string, unknown>, mode: 'dry_run' | 'live' = 'live'): ExecutorAction {
  return {
    contractVersion: '1', actionType: 'external_http', payload, payloadSha256: sha256Hex(canonicalJson(payload)),
    riskClass: 'external_reversible', orgId: 'org', projectId: 'project', approvalId: 'approval', taskId: 'task',
    runId: null, correlationId: 'corr', idempotencyKey: '1234567890123456', mode,
    authorization: { actorId: 'actor', orgId: 'org', projectId: 'project', projectRole: 'admin', resolvedAt: '2026-08-20T12:00:00.000Z', source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: 'actor', confirmedAt: '2026-08-20T11:59:00.000Z', expiresAt: '2026-08-20T12:05:00.000Z', payloadSha256: sha256Hex(canonicalJson(payload)) },
  };
}

function executor(
  responder: (url: string) => Response,
  overrides: Partial<AccurateBidsQuoteExecutorDeps> = {},
): { ex: AccurateBidsQuoteExecutor; calls: { url: string; body: string }[] } {
  const calls: { url: string; body: string }[] = [];
  const ex = new AccurateBidsQuoteExecutor({
    endpointUrl: 'https://example.supabase.co/functions/v1/hub-quote',
    replyUrl: 'https://example.supabase.co/functions/v1/hub-reply',
    invoiceUrl: 'https://example.supabase.co/functions/v1/hub-invoice',
    serviceToken: 'test-token',
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? '') });
      return responder(String(url));
    }) as typeof fetch,
    ...overrides,
  });
  return { ex, calls };
}

describe('invoice side — accuratebids_invoice', () => {
  it('creates an invoice from a quote through the invoice endpoint', async () => {
    const { ex, calls } = executor(() =>
      new Response(JSON.stringify({ success: true, invoice_id: 'inv-1', invoice_number: 'INV-123456', amount: 1200, status: 'unpaid' }), { status: 200 }),
    );
    const result = await ex.execute(action(FROM_QUOTE));
    expect(result.outcome).toBe('succeeded');
    expect(result.message).toContain('INV-123456');
    expect(calls[0]!.url).toContain('hub-invoice');
    expect(JSON.parse(calls[0]!.body).quote_id).toBe(FROM_QUOTE.quote_id);
  });

  it('creates a direct invoice when no quote exists', async () => {
    const { ex, calls } = executor(() =>
      new Response(JSON.stringify({ success: true, invoice_number: 'INV-654321', amount: 325.88, status: 'unpaid' }), { status: 200 }),
    );
    const result = await ex.execute(action(DIRECT));
    expect(result.outcome).toBe('succeeded');
    expect(JSON.parse(calls[0]!.body).line_items).toHaveLength(1);
  });

  it('409 (quote already invoiced) blocks without retry — no double-billing ever', async () => {
    const { ex } = executor(() => new Response(JSON.stringify({ error: 'quote already has invoice INV-000111 (unpaid)' }), { status: 409 }));
    const result = await ex.execute(action(FROM_QUOTE));
    expect(result.outcome).toBe('blocked');
    expect(result.retryAllowed).toBe(false);
    expect(result.message).toMatch(/already invoiced/i);
  });

  it('strict shape: extra keys, and neither quote_id nor direct fields, are refused', async () => {
    const { ex, calls } = executor(() => new Response('{}', { status: 200 }));
    expect((await ex.execute(action({ ...FROM_QUOTE, paid: true }))).outcome).toBe('blocked');
    expect((await ex.execute(action({ kind: 'accuratebids_invoice' }))).outcome).toBe('blocked');
    expect((await ex.execute(action({ kind: 'accuratebids_invoice', customer_name: 'Pat', job_name: 'Job' }))).outcome).toBe('blocked');
    expect(calls).toHaveLength(0);
  });

  it('dry run touches nothing; unconfigured invoice URL blocks; 5xx is ambiguous', async () => {
    const { ex, calls } = executor(() => new Response('{}', { status: 200 }));
    expect((await ex.execute(action(FROM_QUOTE, 'dry_run'))).outcome).toBe('not_executed');
    expect(calls).toHaveLength(0);
    const { ex: bare } = executor(() => new Response('{}', { status: 200 }), { invoiceUrl: undefined });
    expect((await bare.execute(action(FROM_QUOTE))).outcome).toBe('blocked');
    const { ex: flaky } = executor(() => new Response('oops', { status: 502 }));
    const ambiguous = await flaky.execute(action(FROM_QUOTE));
    expect(ambiguous.outcome).toBe('ambiguous');
    expect(ambiguous.reconciliation).toBe('required');
  });
});
