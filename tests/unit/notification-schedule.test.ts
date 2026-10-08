import { describe, expect, it } from 'vitest';
import { parseLocalTime, inQuietHours, quietHoursEndAt, nextDigestAt, localMinutes } from '@/domain/notifications/schedule';

describe('parseLocalTime', () => {
  it('parses HH:MM and rejects garbage', () => {
    expect(parseLocalTime('00:00')).toBe(0);
    expect(parseLocalTime('08:30')).toBe(510);
    expect(parseLocalTime('23:59')).toBe(1439);
    expect(parseLocalTime('24:00')).toBeNull();
    expect(parseLocalTime('7:00')).toBeNull();
    expect(parseLocalTime('bad')).toBeNull();
  });
});

describe('inQuietHours', () => {
  const tz = 'UTC';
  it('is false when not configured', () => {
    expect(inQuietHours(new Date('2026-01-01T03:00:00Z'), tz, null, null)).toBe(false);
    expect(inQuietHours(new Date('2026-01-01T03:00:00Z'), tz, '22:00', null)).toBe(false);
  });
  it('handles a same-day window', () => {
    // 09:00–17:00 UTC
    expect(inQuietHours(new Date('2026-01-01T10:00:00Z'), tz, '09:00', '17:00')).toBe(true);
    expect(inQuietHours(new Date('2026-01-01T08:00:00Z'), tz, '09:00', '17:00')).toBe(false);
    expect(inQuietHours(new Date('2026-01-01T17:00:00Z'), tz, '09:00', '17:00')).toBe(false); // end exclusive
  });
  it('handles an overnight window (22:00–07:00)', () => {
    expect(inQuietHours(new Date('2026-01-01T23:30:00Z'), tz, '22:00', '07:00')).toBe(true);
    expect(inQuietHours(new Date('2026-01-01T03:00:00Z'), tz, '22:00', '07:00')).toBe(true);
    expect(inQuietHours(new Date('2026-01-01T12:00:00Z'), tz, '22:00', '07:00')).toBe(false);
  });
  it('respects the timezone (not UTC hours)', () => {
    // 22:00–07:00 America/New_York. 2026-01-01T03:00Z = 22:00 EST → inside quiet hours.
    expect(inQuietHours(new Date('2026-01-01T03:00:00Z'), 'America/New_York', '22:00', '07:00')).toBe(true);
    // 2026-01-01T18:00Z = 13:00 EST → outside.
    expect(inQuietHours(new Date('2026-01-01T18:00:00Z'), 'America/New_York', '22:00', '07:00')).toBe(false);
  });
});

describe('quietHoursEndAt', () => {
  it('returns the next end instant while inside the window, else null', () => {
    const now = new Date('2026-01-01T23:30:00Z');
    const end = quietHoursEndAt(now, 'UTC', '22:00', '07:00');
    expect(end).not.toBeNull();
    // 07:00 UTC the next morning.
    expect(end!.toISOString()).toBe('2026-01-02T07:00:00.000Z');
    expect(quietHoursEndAt(new Date('2026-01-01T12:00:00Z'), 'UTC', '22:00', '07:00')).toBeNull();
  });
});

describe('nextDigestAt', () => {
  it('returns null with no configured times', () => {
    expect(nextDigestAt(new Date('2026-01-01T00:00:00Z'), 'UTC', [])).toBeNull();
  });
  it('picks the next future local time (UTC)', () => {
    const now = new Date('2026-01-01T10:00:00Z');
    // Times 08:00 and 18:00 UTC → next is 18:00 today.
    expect(nextDigestAt(now, 'UTC', ['08:00', '18:00'])!.toISOString()).toBe('2026-01-01T18:00:00.000Z');
    // After 18:00 → next is 08:00 tomorrow.
    expect(nextDigestAt(new Date('2026-01-01T19:00:00Z'), 'UTC', ['08:00', '18:00'])!.toISOString()).toBe('2026-01-02T08:00:00.000Z');
  });
  it('is DST-safe: 08:00 local converts to the correct UTC instant across a zone offset', () => {
    // America/New_York in January = EST (UTC-5). 08:00 EST = 13:00 UTC.
    const now = new Date('2026-01-01T06:00:00Z'); // 01:00 EST
    expect(nextDigestAt(now, 'America/New_York', ['08:00'])!.toISOString()).toBe('2026-01-01T13:00:00.000Z');
    // In July = EDT (UTC-4). 08:00 EDT = 12:00 UTC.
    const summer = new Date('2026-07-01T06:00:00Z');
    expect(nextDigestAt(summer, 'America/New_York', ['08:00'])!.toISOString()).toBe('2026-07-01T12:00:00.000Z');
  });
});

describe('localMinutes', () => {
  it('converts a UTC instant to local minutes-from-midnight', () => {
    expect(localMinutes(new Date('2026-01-01T10:30:00Z'), 'UTC')).toBe(630);
    expect(localMinutes(new Date('2026-01-01T18:00:00Z'), 'America/New_York')).toBe(13 * 60); // 13:00 EST
  });
});
