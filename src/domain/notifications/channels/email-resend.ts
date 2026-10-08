import {
  type NotificationChannel,
  type NotificationChannelCapability,
  type NotificationSendInput,
  type NotificationSendResult,
} from '../channel-contract';

export const EMAIL_CHANNEL_ID = 'email' as const;
export const EMAIL_CHANNEL_VERSION = '1';
const RESEND_ENDPOINT = 'https://api.resend.com/emails';
const SEND_TIMEOUT_MS = 15_000;

/**
 * Resend email adapter. Config comes ONLY from the environment (`EMAIL_API_KEY`, `EMAIL_FROM`); an unset key or
 * sender leaves the channel UNCONFIGURED and every send BLOCKS — it never silently sends. The Resend
 * `Idempotency-Key` header carries our stable delivery key so a retry is deduped at the provider (we still never
 * auto-retry an ambiguous outcome). The `fetcher` is injectable for tests; nothing here reads the DB.
 */
export interface ResendChannelDeps {
  readonly apiKey?: string | undefined;
  readonly from?: string | undefined;
  readonly fetcher?: typeof fetch;
}

const nonEmpty = (v: string | undefined): string | undefined => (v && v.trim() !== '' ? v.trim() : undefined);

export function resendChannelDepsFromEnv(env: Record<string, string | undefined> = process.env): ResendChannelDeps {
  return { apiKey: nonEmpty(env.EMAIL_API_KEY), from: nonEmpty(env.EMAIL_FROM) };
}

const CAPABILITY: NotificationChannelCapability = Object.freeze({
  channelId: EMAIL_CHANNEL_ID,
  enabledByDefault: false,
  externalSideEffect: true,
});

export class ResendEmailChannel implements NotificationChannel {
  readonly capability = CAPABILITY;

  constructor(private readonly deps: ResendChannelDeps) {}

  get configured(): boolean {
    return Boolean(this.deps.apiKey && this.deps.from);
  }

  async send(input: NotificationSendInput): Promise<NotificationSendResult> {
    // Fail closed: no key or no sender ⇒ nothing leaves the system.
    if (!this.deps.apiKey || !this.deps.from) {
      return { outcome: 'blocked', resultCode: 'not_configured', detail: 'email channel is not configured (EMAIL_API_KEY / EMAIL_FROM unset)' };
    }
    const fetcher = this.deps.fetcher ?? fetch;
    let res: Response;
    try {
      res = await fetcher(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.deps.apiKey}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': input.idempotencyKey,
        },
        body: JSON.stringify({ from: this.deps.from, to: input.recipientAddress, subject: input.subject, text: input.textBody }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
    } catch (err) {
      // Timeout / transport failure — the send MAY have landed. Ambiguous, never blindly retried.
      const detail = err instanceof Error ? err.name : 'network_error';
      return { outcome: 'ambiguous', resultCode: 'timeout', detail: `email send could not be confirmed (${detail}); not retried automatically` };
    }
    if (res.ok) {
      let providerMessageId: string | null = null;
      try {
        const body = (await res.json()) as { id?: string };
        providerMessageId = body?.id ?? null;
      } catch {
        /* a 2xx with an unreadable body is still accepted */
      }
      return { outcome: 'sent', resultCode: 'ok', detail: 'accepted by provider', providerMessageId };
    }
    const bodyText = await res.text().catch(() => '');
    const snippet = bodyText.slice(0, 300);
    if (res.status >= 400 && res.status < 500) {
      // Definite rejection (bad address, invalid request). Terminal — retrying won't help.
      return { outcome: 'failed', resultCode: `provider_${res.status}`, detail: `provider rejected the email: ${snippet}` };
    }
    // 5xx — unknown whether it was accepted. Ambiguous, never blindly retried.
    return { outcome: 'ambiguous', resultCode: `provider_${res.status}`, detail: `provider error, delivery unconfirmed: ${snippet}` };
  }
}
