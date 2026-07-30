import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import {
  DEFAULT_TOP_N,
  DEFAULT_WINDOW_DAYS,
  MAX_TOP_N,
  MAX_WINDOW_DAYS,
  resolveReportWindow,
  resolveTopN,
} from '@/domain/reporting/window';

const NOW = new Date('2026-07-30T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

describe('M0a report window validation', () => {
  it('missing from & to → bounded default window ending now', () => {
    const w = resolveReportWindow(NOW, undefined, undefined);
    expect(w.to.getTime()).toBe(NOW.getTime());
    expect(w.from.getTime()).toBe(NOW.getTime() - DEFAULT_WINDOW_DAYS * DAY);
  });

  it('missing from → derived as to − default; missing to → now', () => {
    const w = resolveReportWindow(NOW, undefined, '2026-07-20T00:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-07-20T00:00:00.000Z');
    expect(w.from.getTime()).toBe(w.to.getTime() - DEFAULT_WINDOW_DAYS * DAY);
  });

  it('invalid date strings are rejected', () => {
    expect(() => resolveReportWindow(NOW, 'not-a-date', undefined)).toThrow(AppError);
    expect(() => resolveReportWindow(NOW, undefined, 'garbage')).toThrow(AppError);
  });

  it('from >= to is rejected', () => {
    expect(() => resolveReportWindow(NOW, '2026-07-20T00:00:00Z', '2026-07-20T00:00:00Z')).toThrow(AppError);
    expect(() => resolveReportWindow(NOW, '2026-07-21T00:00:00Z', '2026-07-20T00:00:00Z')).toThrow(AppError);
  });

  it('window exceeding the maximum span is rejected', () => {
    const from = new Date(NOW.getTime() - (MAX_WINDOW_DAYS + 1) * DAY).toISOString();
    expect(() => resolveReportWindow(NOW, from, NOW.toISOString())).toThrow(AppError);
    // exactly max is allowed
    const okFrom = new Date(NOW.getTime() - MAX_WINDOW_DAYS * DAY).toISOString();
    expect(() => resolveReportWindow(NOW, okFrom, NOW.toISOString())).not.toThrow();
  });

  it('future to is clamped to now; a fully-future window collapses and is rejected', () => {
    const w = resolveReportWindow(NOW, '2026-07-01T00:00:00Z', '2999-01-01T00:00:00Z');
    expect(w.to.getTime()).toBe(NOW.getTime()); // clamped
    expect(() => resolveReportWindow(NOW, '2999-01-01T00:00:00Z', '2999-02-01T00:00:00Z')).toThrow(AppError);
  });

  it('top-N: default when absent, bounded, rejects invalid/negative/excessive', () => {
    expect(resolveTopN(undefined)).toBe(DEFAULT_TOP_N);
    expect(resolveTopN('50')).toBe(50);
    expect(resolveTopN(String(MAX_TOP_N))).toBe(MAX_TOP_N);
    expect(() => resolveTopN('0')).toThrow(AppError);
    expect(() => resolveTopN('-5')).toThrow(AppError);
    expect(() => resolveTopN('9999')).toThrow(AppError);
    expect(() => resolveTopN('abc')).toThrow(AppError);
    expect(() => resolveTopN('1.5')).toThrow(AppError);
  });
});
