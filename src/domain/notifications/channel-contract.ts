import { type NotificationChannelId } from '@/types/domain';

/**
 * The pluggable delivery-channel contract. Mirrors the executor contract: a channel declares a capability
 * (never enabled by default), reports whether it is fully configured, and sends ONE message. Adding SMS later is
 * a new adapter implementing this interface — the event model and router never change.
 *
 * Outcome taxonomy (owner-directed): `sent` = the provider accepted it; `failed` = a definite terminal failure
 * (e.g. a 4xx bad address) — retrying won't help; `ambiguous` = timeout / 5xx / unknown — the message MAY have
 * been delivered, so it is NEVER blindly retried, only surfaced; `blocked` = withheld before any send (channel
 * disabled or not configured) — nothing left the system.
 */
export const NOTIFICATION_DELIVERY_OUTCOMES = ['sent', 'failed', 'ambiguous', 'blocked'] as const;
export type NotificationDeliveryOutcome = (typeof NOTIFICATION_DELIVERY_OUTCOMES)[number];

export interface NotificationChannelCapability {
  readonly channelId: NotificationChannelId;
  /** Safety invariant: a channel is NEVER live unless the server explicitly enables it AND it is configured. */
  readonly enabledByDefault: false;
  /** True when a live send leaves the system (email does). */
  readonly externalSideEffect: boolean;
}

export interface NotificationSendInput {
  readonly recipientAddress: string;
  readonly subject: string;
  readonly textBody: string;
  /** Stable, mandatory. Passed to the provider so a (manual) retry can never double-send. */
  readonly idempotencyKey: string;
}

export interface NotificationSendResult {
  readonly outcome: NotificationDeliveryOutcome;
  /** Machine code for the ledger: 'ok' | 'provider_4xx' | 'provider_5xx' | 'timeout' | 'not_configured' | … */
  readonly resultCode: string;
  readonly detail: string;
  readonly providerMessageId?: string | null;
}

export interface NotificationChannel {
  readonly capability: NotificationChannelCapability;
  /** Fully configured (credentials + sender present). A channel that is not configured must block, never send. */
  readonly configured: boolean;
  send(input: NotificationSendInput): Promise<NotificationSendResult>;
}
