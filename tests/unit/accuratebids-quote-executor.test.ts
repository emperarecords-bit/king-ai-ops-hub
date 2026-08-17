import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import { validateExecutorResult, type ExecutorAction } from '@/domain/execution/executor-contract';
import {
  AccurateBidsQuoteExecutor,
  accurateBidsDepsFromEnv,
  type AccurateBidsQuoteExecutorDeps,
} from '@/domain/execution/accuratebids-quote-executor';

/** The AccurateBids tap-in: strict payload contract, draft-only creation, honest failure states. */

const PAYLOAD = {
  kind: 'accuratebids_quote',
  job_name: 'Boiler replacement - 45 Oak St',
  customer_name: 'Jane Homeowner',
  job_address: '45 Oak St',
  job_type: 'hvac',
  notes: 'Replace 80k BTU boiler, new venting.',
  materials: [{ description: 'Boiler 80k BTU', quantity: 1, unit: 'ea', unit_cost: 3200 }],
  labor: [{ description: 'Install + venting', hours: 10, hourly_rate: 150 }],
  additional_charges: [{ description: 'Permit', amount: 250 }],
  markup_percent: 20,
  tax_percent: 0,
};

function action(payload: Record<string, unknown>, mode: 'dry_run' | 'live' = 'live'): ExecutorAction {
  return {
    contractVersion: '1', actionType: 'external_http', payload, payloadSha256: sha256Hex(canonicalJson(payload)),
    riskClass: 'external_reversible', orgId: 'org', projectId: 'project', approvalId: 'approval', taskId: 'task',
    runId: null, correlationId: 'corr', idempotencyKey: '1234567890123456', mode,
    authorization: { actorId: 'actor', orgId: 'org', projectId: 'project', projectRole: 'admin', resolvedAt: '2026-08-17T12:00:00.000Z', source: 'trusted_server' },
    confirmation: { required: true, confirmedBy: 'actor', confirmedAt: '2026-08-17T11:59:00.000Z', expiresAt: '2026-08-17T12:05:00.000Z', payloadSha256: sha256Hex(canonicalJson(payload)) },
  };
}

function executor(
  responder: (url: string, init: RequestInit) => Promise<Response> | Response,
  overrides: Partial<AccurateBidsQuoteExecutorDeps> = {},
): { ex: AccurateBidsQuoteExecutor; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const ex = new AccurateBidsQuoteExecutor({
    endpointUrl: 'https://example.supabase.co/functions/v1/hub-quote',
    serviceToken: 'test-token',
    fetcher: (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return responder(String(url), init ?? {});
    }) as typeof fetch,
    ...overrides,
  });
  return { ex, calls };
}

const ok = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('AccurateBidsQuoteExecutor', () => {
  it('creates a draft quote live and reports the quote link', async () => {
    const { ex, calls } = executor(() =>
      ok({ success: true, quote_id: 'q-1', grand_total: 5290, url: 'https://accuratebids.com/quotes/q-1' }),
    );
    const act = action(PAYLOAD);
    const result = validateExecutorResult(act, ex.capability, await ex.execute(act));
    expect(result.outcome).toBe('succeeded');
    expect(result.preview).toMatchObject({ quoteId: 'q-1', quoteUrl: 'https://accuratebids.com/quotes/q-1' });
    expect(calls).toHaveLength(1);
    const sent = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    expect(sent.kind).toBeUndefined(); // discriminator is hub-internal, not part of the API body
    expect(sent.job_name).toBe(PAYLOAD.job_name);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
  });

  it('dry run touches nothing', async () => {
    const { ex, calls } = executor(() => ok({ success: true }));
    const result = await ex.execute(action(PAYLOAD, 'dry_run'));
    expect(result.outcome).toBe('not_executed');
    expect(calls).toHaveLength(0);
  });

  it('refuses external_http payloads that are not accuratebids_quote (generic HTTP stays unexecutable)', async () => {
    const { ex, calls } = executor(() => ok({ success: true }));
    const result = await ex.execute(action({ url: 'https://hooks.partner.io/ingest', method: 'POST' }));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/not an executable AccurateBids quote/i);
    expect(calls).toHaveLength(0);
  });

  it('refuses extra keys, string numbers, and tampered hashes', async () => {
    const { ex, calls } = executor(() => ok({ success: true }));
    const extra = await ex.execute(action({ ...PAYLOAD, surprise: true }));
    expect(extra.outcome).toBe('blocked');
    const stringNumber = await ex.execute(
      action({ ...PAYLOAD, materials: [{ description: 'x', quantity: '1', unit_cost: 5 }] }),
    );
    expect(stringNumber.outcome).toBe('blocked');
    const tampered = await ex.execute({ ...action(PAYLOAD), payloadSha256: 'c'.repeat(64) });
    expect(tampered.outcome).toBe('blocked');
    expect(tampered.message).toMatch(/integrity/i);
    expect(calls).toHaveLength(0);
  });

  it('blocks when the server is not configured (absence never executes)', async () => {
    const { ex, calls } = executor(() => ok({ success: true }), { serviceToken: undefined });
    const result = await ex.execute(action(PAYLOAD));
    expect(result.outcome).toBe('blocked');
    expect(result.message).toMatch(/not configured/i);
    expect(calls).toHaveLength(0);
    expect(accurateBidsDepsFromEnv({}).endpointUrl).toBeUndefined();
  });

  it('4xx refusal is failed+retryable; 5xx and network faults are ambiguous with reconciliation', async () => {
    const refused = executor(() => new Response(JSON.stringify({ error: 'rate limited' }), { status: 429 }));
    const r1 = await refused.ex.execute(action(PAYLOAD));
    expect(r1.outcome).toBe('failed');
    expect(r1.retryAllowed).toBe(true);

    const serverErr = executor(() => new Response('oops', { status: 500 }));
    const r2 = await serverErr.ex.execute(action(PAYLOAD));
    expect(r2.outcome).toBe('ambiguous');
    expect(r2.reconciliation).toBe('required');

    const network = executor(() => {
      throw new Error('socket hang up');
    });
    const r3 = await network.ex.execute(action(PAYLOAD));
    expect(r3.outcome).toBe('ambiguous');
    expect(r3.reconciliation).toBe('required');
  });
});
