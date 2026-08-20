import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@/orchestration/actions';
import { sha256Hex } from '@/lib/crypto';
import {
  AccurateBidsQuoteExecutor,
  type AccurateBidsQuoteExecutorDeps,
} from '@/domain/execution/accuratebids-quote-executor';
import { type ExecutorAction } from '@/domain/execution/executor-contract';
import { formatSightBriefing } from '@/domain/integrations/accuratebids-sight';

/** Email Desk — the accuratebids_reply lane: strict payload, double-email refusal, sight rendering. */

const REPLY = {
  kind: 'accuratebids_reply',
  request_id: '4c5e2a92-fa7c-49db-b9fd-8eb31cb8b901',
  reply_text: 'Thanks for reaching out - your quote link works again; we fixed the expired token on our side.',
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
): { ex: AccurateBidsQuoteExecutor; calls: string[] } {
  const calls: string[] = [];
  const ex = new AccurateBidsQuoteExecutor({
    endpointUrl: 'https://example.supabase.co/functions/v1/hub-quote',
    replyUrl: 'https://example.supabase.co/functions/v1/hub-reply',
    serviceToken: 'test-token',
    fetcher: (async (url: string | URL | Request) => {
      calls.push(String(url));
      return responder(String(url));
    }) as typeof fetch,
    ...overrides,
  });
  return { ex, calls };
}

describe('email desk — accuratebids_reply', () => {
  it('sends an approved reply through the reply endpoint', async () => {
    const { ex, calls } = executor(() =>
      new Response(JSON.stringify({ success: true, sent_to: 'customer@example.com' }), { status: 200 }),
    );
    const result = await ex.execute(action(REPLY));
    expect(result.outcome).toBe('succeeded');
    expect(result.message).toContain('customer@example.com');
    expect(calls[0]).toContain('hub-reply');
  });

  it('dry run touches nothing; unconfigured reply URL blocks', async () => {
    const { ex, calls } = executor(() => new Response('{}', { status: 200 }));
    expect((await ex.execute(action(REPLY, 'dry_run'))).outcome).toBe('not_executed');
    expect(calls).toHaveLength(0);
    const { ex: bare } = executor(() => new Response('{}', { status: 200 }), { replyUrl: undefined });
    const blocked = await bare.execute(action(REPLY));
    expect(blocked.outcome).toBe('blocked');
    expect(blocked.message).toMatch(/not configured/i);
  });

  it('409 (already answered) blocks without retry — no double-emailing ever', async () => {
    const { ex } = executor(() => new Response(JSON.stringify({ error: 'already replied' }), { status: 409 }));
    const result = await ex.execute(action(REPLY));
    expect(result.outcome).toBe('blocked');
    expect(result.retryAllowed).toBe(false);
    expect(result.message).toMatch(/already answered/i);
  });

  it('strict shape: extra keys and short replies are refused', async () => {
    const { ex, calls } = executor(() => new Response('{}', { status: 200 }));
    expect((await ex.execute(action({ ...REPLY, cc: 'me@evil.com' }))).outcome).toBe('blocked');
    expect((await ex.execute(action({ ...REPLY, reply_text: 'short' }))).outcome).toBe('blocked');
    expect(calls).toHaveLength(0);
  });

  it('the sight briefing renders the inquiry queue with ids', () => {
    const text = formatSightBriefing({
      as_of: '2026-08-20T12:00:00.000Z',
      quotes: { total: 1, by_status: { draft: 1 }, won_total: 0, recent: [] },
      invoices: { total: 0, open_count: 0, open_balance: 0, recent: [] },
      support: {
        open_count: 1,
        open: [{ id: 'abc-123', name: 'Pat', email: 'pat@x.com', topic: 'billing', message: 'My quote link expired', created_at: '2026-08-20' }],
      },
    });
    expect(text).toContain('EMAIL DESK - 1 unanswered');
    expect(text).toContain('[id abc-123]');
    expect(text).toContain('quote link expired');
  });
});
