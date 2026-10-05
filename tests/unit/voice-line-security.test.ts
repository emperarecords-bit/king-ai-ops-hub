import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

/**
 * Offline security tests for the standalone voice-line service (services/voice-line).
 * The service is a separate CommonJS Fly deployable; these cover its fail-closed security
 * gates WITHOUT Twilio, network, secrets, or a running server — they load the pure
 * security module `server.js` actually uses, so an unconfigured/dormant deployment is
 * provably closed and a configured one behaves exactly as intended.
 */

const require = createRequire(import.meta.url);
const sec = require('../../services/voice-line/security.js') as {
  parseOwnerNumbers(env: string | undefined): string[];
  isAllowedCaller(ownerNumbers: string[], from: string): boolean;
  pinMatches(expectedPin: string, digits: string): boolean;
  isValidTwilioSignature(
    authToken: string,
    signature: string,
    url: string,
    params: Record<string, string>,
    validate?: (t: string, s: string, u: string, p: Record<string, string>) => boolean,
  ): boolean;
  short(s: string, n: number): string;
  nextWatermark(rows: Array<{ created_at: string | number | Date }>, watermark: Date): Date;
  dedupeKey(r: { kind: string; key: string; item: string }): string;
};

const OWNER = '+15551230001';

describe('voice-line — caller allowlist (fail-closed)', () => {
  it('refuses everyone when the allowlist is empty (unconfigured = closed)', () => {
    expect(sec.parseOwnerNumbers(undefined)).toEqual([]);
    expect(sec.isAllowedCaller([], OWNER)).toBe(false);
  });

  it('refuses a number not on the allowlist', () => {
    expect(sec.isAllowedCaller([OWNER], '+15559999999')).toBe(false);
  });

  it('allows only an exact allowlisted number', () => {
    expect(sec.isAllowedCaller(sec.parseOwnerNumbers(` ${OWNER} , +15551230002 `), OWNER)).toBe(true);
    expect(sec.isAllowedCaller(sec.parseOwnerNumbers(`${OWNER},+15551230002`), '+15551230002')).toBe(true);
  });
});

describe('voice-line — PIN gate (fail-closed, constant-time)', () => {
  it('never matches when no PIN is configured', () => {
    expect(sec.pinMatches('', '1234')).toBe(false);
    expect(sec.pinMatches('', '')).toBe(false);
  });

  it('rejects a wrong PIN and accepts the correct one', () => {
    expect(sec.pinMatches('2468', '1357')).toBe(false);
    expect(sec.pinMatches('2468', '2468')).toBe(true);
  });

  it('does not accept a prefix or an over-long input as a match', () => {
    expect(sec.pinMatches('2468', '246')).toBe(false); // short → padded, mismatches
    expect(sec.pinMatches('2468', '24680')).toBe(false); // long → truncated to '2468'? still must fully equal
  });
});

describe('voice-line — Twilio signature gate (fail-closed)', () => {
  it('rejects every webhook when no auth token is configured, without calling the validator', () => {
    const validate = vi.fn().mockReturnValue(true);
    expect(sec.isValidTwilioSignature('', 'sig', 'https://x/voice', {}, validate)).toBe(false);
    expect(validate).not.toHaveBeenCalled();
  });

  it('delegates to the Twilio validator when a token is present and returns its verdict', () => {
    const ok = vi.fn().mockReturnValue(true);
    const bad = vi.fn().mockReturnValue(false);
    const params = { From: OWNER };
    expect(sec.isValidTwilioSignature('tok', 'sig', 'https://x/voice', params, ok)).toBe(true);
    expect(ok).toHaveBeenCalledWith('tok', 'sig', 'https://x/voice', params);
    expect(sec.isValidTwilioSignature('tok', 'badsig', 'https://x/voice', params, bad)).toBe(false);
  });
});

describe('voice-line — notifier anti-storm helpers', () => {
  it('nextWatermark advances 1ms past the newest row and never moves backward', () => {
    const base = new Date('2026-10-04T00:00:00.000Z');
    const rows = [{ created_at: '2026-10-04T00:00:05.000Z' }, { created_at: '2026-10-04T00:00:03.000Z' }];
    const wm = sec.nextWatermark(rows, base);
    expect(wm.getTime()).toBe(new Date('2026-10-04T00:00:05.000Z').getTime() + 1);
    // An empty batch, or older rows, never rewinds the watermark.
    expect(sec.nextWatermark([], wm).getTime()).toBe(wm.getTime());
    expect(sec.nextWatermark([{ created_at: '2026-10-03T00:00:00.000Z' }], wm).getTime()).toBe(wm.getTime());
  });

  it('dedupeKey is a stable composite of kind/key/item', () => {
    expect(sec.dedupeKey({ kind: 'question', key: 'ab', item: 'ship it?' })).toBe('question|ab|ship it?');
  });

  it('short collapses whitespace, trims, and caps length', () => {
    expect(sec.short('  a\n\n b   c  ', 5)).toBe('a b c');
    expect(sec.short('abcdefgh', 3)).toBe('abc');
    expect(sec.short(undefined as unknown as string, 5)).toBe('');
  });
});
