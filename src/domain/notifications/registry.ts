import { type NotificationChannelId } from '@/types/domain';
import { type NotificationChannel } from './channel-contract';
import { EMAIL_CHANNEL_ID, ResendEmailChannel, resendChannelDepsFromEnv } from './channels/email-resend';

/**
 * Server enablement + kill switch — the exact shape as the executor dispatch policy. `NOTIFICATIONS_ENABLED` is a
 * comma-separated channel-id list ("email"); `NOTIFICATIONS_KILL_SWITCH=1` empties it instantly without a deploy.
 * UNSET means disabled — absence of configuration can NEVER enable sending.
 */
export interface NotificationPolicy {
  readonly killSwitch: boolean;
  readonly enabledChannelIds: ReadonlySet<NotificationChannelId>;
}

export function resolveNotificationPolicyFromEnv(env: Record<string, string | undefined> = process.env): NotificationPolicy {
  const killSwitch = env.NOTIFICATIONS_KILL_SWITCH === '1' || env.NOTIFICATIONS_KILL_SWITCH === 'true';
  const ids = (env.NOTIFICATIONS_ENABLED ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean) as NotificationChannelId[];
  return { killSwitch, enabledChannelIds: new Set(killSwitch ? [] : ids) };
}

/** The explicit channel registry. A channel id with no entry here can never send, whatever is configured. The
 *  optional `fetcher` is injected only in tests; production always uses the global fetch. */
export function resolveNotificationChannel(
  channelId: NotificationChannelId,
  env: Record<string, string | undefined> = process.env,
  fetcher?: typeof fetch,
): NotificationChannel | null {
  if (channelId === EMAIL_CHANNEL_ID) return new ResendEmailChannel({ ...resendChannelDepsFromEnv(env), fetcher });
  return null; // 'sms' is reserved — no adapter in v1.
}

export type ChannelGateReason = 'live' | 'kill_switch' | 'not_enabled' | 'no_adapter' | 'not_configured';

export interface ChannelGate {
  readonly channel: NotificationChannel | null;
  readonly reason: ChannelGateReason;
}

/**
 * The SINGLE fail-closed gate every send passes through. A channel is LIVE only when ALL hold: not kill-switched,
 * explicitly enabled, an adapter exists, AND the adapter is configured (key + sender). Any miss returns a null
 * channel with the reason — the router records that reason and sends nothing.
 */
export function gateChannel(
  channelId: NotificationChannelId,
  env: Record<string, string | undefined> = process.env,
  fetcher?: typeof fetch,
): ChannelGate {
  const policy = resolveNotificationPolicyFromEnv(env);
  if (policy.killSwitch) return { channel: null, reason: 'kill_switch' };
  if (!policy.enabledChannelIds.has(channelId)) return { channel: null, reason: 'not_enabled' };
  const channel = resolveNotificationChannel(channelId, env, fetcher);
  if (!channel) return { channel: null, reason: 'no_adapter' };
  if (!channel.configured) return { channel: null, reason: 'not_configured' };
  return { channel, reason: 'live' };
}
