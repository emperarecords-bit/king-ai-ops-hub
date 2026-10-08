import { describe, expect, it } from 'vitest';
import { resolveNotificationPolicyFromEnv, gateChannel } from '@/domain/notifications/registry';

/**
 * The fail-closed-by-default contract (owner requirement). Email sends ONLY when ALL hold: the channel is
 * explicitly enabled, not kill-switched, an adapter exists, and it is configured (key + sender). Every miss
 * returns a null channel with the reason — the router then suppresses and sends nothing.
 */
describe('resolveNotificationPolicyFromEnv', () => {
  it('is empty when NOTIFICATIONS_ENABLED is unset (disabled by default)', () => {
    const p = resolveNotificationPolicyFromEnv({});
    expect(p.enabledChannelIds.size).toBe(0);
    expect(p.killSwitch).toBe(false);
  });
  it('parses the enabled list', () => {
    const p = resolveNotificationPolicyFromEnv({ NOTIFICATIONS_ENABLED: 'email' });
    expect(p.enabledChannelIds.has('email')).toBe(true);
  });
  it('the kill switch empties the list instantly', () => {
    const p = resolveNotificationPolicyFromEnv({ NOTIFICATIONS_ENABLED: 'email', NOTIFICATIONS_KILL_SWITCH: '1' });
    expect(p.killSwitch).toBe(true);
    expect(p.enabledChannelIds.size).toBe(0);
  });
});

describe('gateChannel — fail closed', () => {
  const key = { EMAIL_API_KEY: 'k', EMAIL_FROM: 'bot@x.com' };

  it('unset NOTIFICATIONS_ENABLED → not_enabled (no channel), even with a key', () => {
    expect(gateChannel('email', { ...key }).reason).toBe('not_enabled');
  });
  it('kill switch → kill_switch, even when enabled + configured', () => {
    expect(gateChannel('email', { ...key, NOTIFICATIONS_ENABLED: 'email', NOTIFICATIONS_KILL_SWITCH: '1' }).reason).toBe('kill_switch');
  });
  it('enabled but no API key → not_configured', () => {
    expect(gateChannel('email', { NOTIFICATIONS_ENABLED: 'email', EMAIL_FROM: 'bot@x.com' }).reason).toBe('not_configured');
  });
  it('enabled but no sender → not_configured', () => {
    expect(gateChannel('email', { NOTIFICATIONS_ENABLED: 'email', EMAIL_API_KEY: 'k' }).reason).toBe('not_configured');
  });
  it('enabled + key + sender → live (a channel is returned)', () => {
    const gate = gateChannel('email', { ...key, NOTIFICATIONS_ENABLED: 'email' });
    expect(gate.reason).toBe('live');
    expect(gate.channel).not.toBeNull();
  });
  it('an unknown channel id → no_adapter', () => {
    expect(gateChannel('sms', { ...key, NOTIFICATIONS_ENABLED: 'sms' }).reason).toBe('no_adapter');
  });
});
