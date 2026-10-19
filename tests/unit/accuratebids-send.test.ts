import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import {
  AccurateBidsQuoteExecutor,
  accurateBidsSendKey,
  type AccurateBidsQuoteExecutorDeps,
} from '@/domain/execution/accuratebids-quote-executor';
import { type ExecutorAction } from '@/domain/execution/executor-contract';

/**
 * Send side — the accuratebids_send lane (owner directive 2026-10-19: send the invoice to get paid).
 * Strict payload; the idempotency key is the APPROVAL (one approval = at most one email); outcomes
 * are honest: refusals before sending are blocked, provider refusals are failed (retryable), and
 * anything that may have reached the customer unconfirmed is ambiguous.
 */

const INV = '4c5e2a92-fa7c-49db-b9fd-8eb31cb8b901';
const QUOTE = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const SEND_INVOICE = { kind: 'accuratebids_send', send: 'invoice', invoice_id: INV, label: 'INV-123456 (Pat, balance $1200)' };

function action(payload: Record<string, unknown>, mode: 'dry_run' | 'live' = 'live', approvalId = 'b1f6c1d2-0000-4000-8000-000000000001'): ExecutorAction {
  return {
    contractVersion: '1', actionType: 'external_http', payload, payloadSha256: sha256Hex(canonicalJson(payload)),
    riskClass: 'external_reversible', orgId: 'org', projectId: 'project', approvalId, taskId: 'task',
    runId: null, correlationId: 'corr', idempotencyKey: '1234567890123456', mode,
    authorization: { actorId: 'actor', orgId: 'org', projectId: 'project', projectRole: 'admin', resolvedAt: '2026-10-19T12:00:00.000Z', source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: 'actor', confirmedAt: '2026-10-19T11:59:00.000Z', expiresAt: '2026-10-19T12:05:00.000Z', payloadSha256: sha256Hex(canonicalJson(payload)) },
  };
}

function executor(
  responder: () => Response | Promise<Response>,
  overrides: Partial<AccurateBidsQuoteExecutorDeps> = {},
): { ex: AccurateBidsQuoteExecutor; calls: { url: string; body: Record<string, unknown>; auth: string | null }[] } {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  const ex = new AccurateBidsQuoteExecutor({
    endpointUrl: 'https://example.supabase.co/functions/v1/hub-quote',
    invoiceUrl: 'https://example.supabase.co/functions/v1/hub-invoice',
    sendUrl: 'https://example.supabase.co/functions/v1/hub-send',
    serviceToken: 'test-token',
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')), auth: new Headers(init?.headers).get('Authorization') });
      return responder();
    }) as typeof fetch,
    ...overrides,
  });
  return { ex, calls };
}

const ok = (body: Record<string, unknown>, status = 200) => new Response(JSON.stringify(body), { status });

describe('accuratebids_send', () => {
  it('emails the invoice through hub-send with the approval-scoped idempotency key', async () => {
    const { ex, calls } = executor(() => ok({ success: true, kind: 'invoice', label: 'INV-123456', sent_to: 'p***@example.com', invoice_number: 'INV-123456' }));
    const a = action(SEND_INVOICE);
    const r = await ex.execute(a);
    expect(r.outcome).toBe('succeeded');
    expect(r.message).toMatch(/Invoice INV-123456 emailed to the customer \(p\*\*\*@example\.com\)/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://example.supabase.co/functions/v1/hub-send');
    expect(calls[0]!.auth).toBe('Bearer test-token');
    expect(calls[0]!.body).toEqual({ kind: 'invoice', invoice_id: INV, idempotency_key: accurateBidsSendKey(a.approvalId) });
    expect(r.preview).toMatchObject({ sentTo: 'p***@example.com', replayed: false });
  });

  it('a quote send targets quote_id; a reminder uses the reminder kind', async () => {
    const q = executor(() => ok({ success: true, label: 'Condenser swap', sent_to: 'p***@x.com' }));
    await q.ex.execute(action({ kind: 'accuratebids_send', send: 'quote', quote_id: QUOTE }));
    expect(q.calls[0]!.body).toMatchObject({ kind: 'quote', quote_id: QUOTE });
    expect(q.calls[0]!.body.invoice_id).toBeUndefined();

    const rem = executor(() => ok({ success: true }));
    const r = await rem.ex.execute(action({ kind: 'accuratebids_send', send: 'invoice_reminder', invoice_id: INV }));
    expect(rem.calls[0]!.body.kind).toBe('invoice_reminder');
    expect(r.message).toMatch(/^Payment reminder/);
  });

  it('a replayed key is reported as already sent (no second email)', async () => {
    const { ex } = executor(() => ok({ success: true, replayed: true, label: 'INV-123456', sent_to: 'p***@example.com' }));
    const r = await ex.execute(action(SEND_INVOICE));
    expect(r.outcome).toBe('succeeded');
    expect(r.message).toMatch(/already sent earlier; not emailed again/);
  });

  it.each([
    [404, { error: 'invoice not found for this contractor' }],
    [400, { error: 'This customer has no email on file.' }],
    [409, { error: 'Invoice INV-1 is paid; nothing to send.' }],
  ])('refusals before sending (%i) are BLOCKED, never retried as if transient', async (status, body) => {
    const { ex } = executor(() => ok(body, status));
    const r = await ex.execute(action(SEND_INVOICE));
    expect(r.outcome).toBe('blocked');
    expect(r.retryAllowed).toBe(false);
    expect(r.message).toContain(body.error);
  });

  it('a provider refusal (502) is reported honestly and a 409-ambiguous is AMBIGUOUS', async () => {
    const failed = await executor(() => ok({ error: 'The email was not sent: bad address' }, 502)).ex.execute(action(SEND_INVOICE));
    expect(failed.outcome).toBe('ambiguous'); // 5xx is never assumed clean
    const amb = await executor(() => ok({ error: 'in progress', ambiguous: true }, 409)).ex.execute(action(SEND_INVOICE));
    expect(amb.outcome).toBe('ambiguous');
    expect(amb.reconciliation).toBe('required');
  });

  it('a 4xx other than refusals (e.g. 429) is a retryable failure', async () => {
    const r = await executor(() => ok({ error: 'Too many requests' }, 429)).ex.execute(action(SEND_INVOICE));
    expect(r.outcome).toBe('failed');
    expect(r.retryAllowed).toBe(true);
  });

  it('a network error is AMBIGUOUS (the email may have gone out)', async () => {
    const r = await executor(() => {
      throw new Error('socket hang up');
    }).ex.execute(action(SEND_INVOICE));
    expect(r.outcome).toBe('ambiguous');
    expect(r.message).toMatch(/Check the customer's email log/);
  });

  it('dry run never calls the endpoint', async () => {
    const { ex, calls } = executor(() => ok({ success: true }));
    const r = await ex.execute(action(SEND_INVOICE, 'dry_run'));
    expect(r.outcome).toBe('not_executed');
    expect(calls).toHaveLength(0);
  });

  it('blocks when sending is not configured', async () => {
    const { ex, calls } = executor(() => ok({ success: true }), { sendUrl: undefined });
    expect((await ex.execute(action(SEND_INVOICE))).outcome).toBe('blocked');
    expect(calls).toHaveLength(0);
  });

  it.each([
    [{ kind: 'accuratebids_send', send: 'invoice' }],
    [{ kind: 'accuratebids_send', send: 'invoice', quote_id: QUOTE }],
    [{ kind: 'accuratebids_send', send: 'quote', invoice_id: INV }],
    [{ kind: 'accuratebids_send', send: 'invoice', invoice_id: INV, quote_id: QUOTE }],
    [{ kind: 'accuratebids_send', send: 'payment', invoice_id: INV }],
    [{ kind: 'accuratebids_send', send: 'invoice', invoice_id: INV, url: 'https://evil.example' }],
  ])('rejects a malformed send payload %j without calling out', async (payload) => {
    const { ex, calls } = executor(() => ok({ success: true }));
    expect((await ex.execute(action(payload))).outcome).toBe('blocked');
    expect(calls).toHaveLength(0);
  });

  it('a tampered payload (hash mismatch) is blocked', async () => {
    const { ex, calls } = executor(() => ok({ success: true }));
    const a = action(SEND_INVOICE);
    const tampered = { ...a, payload: { ...SEND_INVOICE, invoice_id: QUOTE } };
    expect((await ex.execute(tampered)).outcome).toBe('blocked');
    expect(calls).toHaveLength(0);
  });

  it('one approval = one key (different approvals get different keys)', () => {
    expect(accurateBidsSendKey('a1')).toBe('hub:a1');
    expect(accurateBidsSendKey('a1')).not.toBe(accurateBidsSendKey('a2'));
  });
});
