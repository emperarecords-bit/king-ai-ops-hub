import { describe, expect, it } from 'vitest';
import { computeNextRunAt } from '@/domain/standing/cadence';

/**
 * Cadence math decides when the company works unattended, so it gets pinned
 * hard. The invariant behind every case: the result is ALWAYS strictly after
 * `from` — a schedule can never compute a due time in the past and stampede.
 */

const at = (iso: string) => new Date(iso);

describe('computeNextRunAt', () => {
  it('daily: later today when the hour is still ahead', () => {
    const next = computeNextRunAt(
      { cadence: 'daily', atHour: 18, weekday: null, monthday: null },
      at('2026-07-24T09:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-07-24T18:00:00.000Z');
  });

  it('daily: tomorrow when the hour has passed', () => {
    const next = computeNextRunAt(
      { cadence: 'daily', atHour: 6, weekday: null, monthday: null },
      at('2026-07-24T09:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-07-25T06:00:00.000Z');
  });

  it('daily: exactly at the hour rolls forward (never returns "now")', () => {
    const next = computeNextRunAt(
      { cadence: 'daily', atHour: 6, weekday: null, monthday: null },
      at('2026-07-24T06:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-07-25T06:00:00.000Z');
  });

  it('weekly: finds the next matching weekday', () => {
    // 2026-07-24 is a Friday; next Monday (1) is the 27th.
    const next = computeNextRunAt(
      { cadence: 'weekly', atHour: 6, weekday: 1, monthday: null },
      at('2026-07-24T09:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-07-27T06:00:00.000Z');
    expect(next.getUTCDay()).toBe(1);
  });

  it('weekly: same weekday but hour passed → a full week later', () => {
    const next = computeNextRunAt(
      { cadence: 'weekly', atHour: 6, weekday: 5, monthday: null },
      at('2026-07-24T09:00:00Z'), // Friday, past 06:00
    );
    expect(next.toISOString()).toBe('2026-07-31T06:00:00.000Z');
  });

  it('monthly: this month when the day is ahead', () => {
    const next = computeNextRunAt(
      { cadence: 'monthly', atHour: 6, weekday: null, monthday: 28 },
      at('2026-07-24T09:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-07-28T06:00:00.000Z');
  });

  it('monthly: next month when the day has passed', () => {
    const next = computeNextRunAt(
      { cadence: 'monthly', atHour: 6, weekday: null, monthday: 1 },
      at('2026-07-24T09:00:00Z'),
    );
    expect(next.toISOString()).toBe('2026-08-01T06:00:00.000Z');
  });

  it('monthly: rolls across a year boundary correctly', () => {
    const next = computeNextRunAt(
      { cadence: 'monthly', atHour: 12, weekday: null, monthday: 5 },
      at('2026-12-20T00:00:00Z'),
    );
    expect(next.toISOString()).toBe('2027-01-05T12:00:00.000Z');
  });

  it('monthly: day 28 exists in February (why the cap is 28)', () => {
    const next = computeNextRunAt(
      { cadence: 'monthly', atHour: 6, weekday: null, monthday: 28 },
      at('2027-02-01T00:00:00Z'),
    );
    expect(next.toISOString()).toBe('2027-02-28T06:00:00.000Z');
  });

  it('the universal invariant: always strictly in the future', () => {
    const now = at('2026-07-24T09:13:47Z');
    const rules = [
      { cadence: 'daily' as const, atHour: 9, weekday: null, monthday: null },
      { cadence: 'weekly' as const, atHour: 9, weekday: 5, monthday: null },
      { cadence: 'monthly' as const, atHour: 9, weekday: null, monthday: 24 },
    ];
    for (const rule of rules) {
      expect(computeNextRunAt(rule, now).getTime()).toBeGreaterThan(now.getTime());
    }
  });
});
