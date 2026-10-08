import { describe, expect, it } from 'vitest';
import { ResendEmailChannel } from '@/domain/notifications/channels/email-resend';

const input = { recipientAddress: 'owner@example.com', subject: 'Hi', textBody: 'Body', idempotencyKey: 'email:evt-1' };

function fetcherReturning(status: number, body = '{}'): { fetcher: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

describe('ResendEmailChannel — fail-closed config', () => {
  it('blocks (never calls fetch) when the API key is missing', async () => {
    const { fetcher, calls } = fetcherReturning(200);
    const ch = new ResendEmailChannel({ apiKey: undefined, from: 'bot@x.com', fetcher });
    expect(ch.configured).toBe(false);
    const res = await ch.send(input);
    expect(res.outcome).toBe('blocked');
    expect(res.resultCode).toBe('not_configured');
    expect(calls).toHaveLength(0); // nothing left the system
  });

  it('blocks when the sender is missing', async () => {
    const { fetcher, calls } = fetcherReturning(200);
    const ch = new ResendEmailChannel({ apiKey: 'k', from: undefined, fetcher });
    const res = await ch.send(input);
    expect(res.outcome).toBe('blocked');
    expect(calls).toHaveLength(0);
  });
});

describe('ResendEmailChannel — outcome taxonomy', () => {
  const configured = (fetcher: typeof fetch) => new ResendEmailChannel({ apiKey: 'k', from: 'bot@x.com', fetcher });

  it('2xx → sent, with the stable idempotency key on the request', async () => {
    const { fetcher, calls } = fetcherReturning(200, JSON.stringify({ id: 'msg_123' }));
    const res = await configured(fetcher).send(input);
    expect(res.outcome).toBe('sent');
    expect(res.providerMessageId).toBe('msg_123');
    expect(String(calls[0]!.url)).toContain('api.resend.com');
    expect((calls[0]!.init.headers as Record<string, string>)['Idempotency-Key']).toBe('email:evt-1');
  });

  it('4xx → failed (terminal, no retry)', async () => {
    const { fetcher } = fetcherReturning(422, 'bad address');
    const res = await configured(fetcher).send(input);
    expect(res.outcome).toBe('failed');
    expect(res.resultCode).toBe('provider_422');
  });

  it('5xx → ambiguous (unconfirmed, never blindly retried)', async () => {
    const { fetcher } = fetcherReturning(503, 'upstream down');
    const res = await configured(fetcher).send(input);
    expect(res.outcome).toBe('ambiguous');
    expect(res.resultCode).toBe('provider_503');
  });

  it('network timeout / throw → ambiguous', async () => {
    const fetcher = (async () => {
      throw new DOMException('timed out', 'TimeoutError');
    }) as unknown as typeof fetch;
    const res = await configured(fetcher).send(input);
    expect(res.outcome).toBe('ambiguous');
    expect(res.resultCode).toBe('timeout');
  });
});
