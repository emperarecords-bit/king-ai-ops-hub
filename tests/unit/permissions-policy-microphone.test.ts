import { describe, expect, it } from 'vitest';
import nextConfig from '../../next.config';

/**
 * Hub prod 2026-10-23: voice (Ops Chat 🎤 / Talk, employee Chat / Talk) failed with "Microphone access is blocked" even
 * with the browser set to Allow — the site-wide Permissions-Policy said `microphone=()`. The Hub's own pages may now
 * use the mic; every other powerful feature stays off, and other origins stay denied.
 */
describe('Permissions-Policy', () => {
  it('allows the microphone for the Hub itself only; camera, geolocation and payment stay off', async () => {
    const rules = await nextConfig.headers!();
    const value = rules
      .flatMap((r) => r.headers)
      .find((h) => h.key.toLowerCase() === 'permissions-policy')?.value;
    expect(value).toBe('camera=(), microphone=(self), geolocation=(), payment=()');
    expect(value).not.toMatch(/microphone=\*|microphone=\(\s*\)/);
  });
});
