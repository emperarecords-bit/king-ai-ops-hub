import { AppError } from '@/lib/errors';
import { type ReportWindow } from './m0a';

/**
 * M0a report-input validation — pure. Turns raw query params into a bounded, validated window + top-N, or
 * throws `AppError('validation', …)`. Bounded by construction: a default window is applied when params are
 * absent, an explicit maximum span is enforced, invalid ranges are rejected, and top-N is clamped to a
 * bounded ceiling. No unbounded query can be issued from the route.
 */

export const DEFAULT_WINDOW_DAYS = 90;
export const MAX_WINDOW_DAYS = 366;
export const DEFAULT_TOP_N = 20;
export const MAX_TOP_N = 200;

const DAY_MS = 24 * 60 * 60 * 1000;

export class ReportInputError extends AppError {
  constructor(message: string) {
    super('validation', message);
    this.name = 'ReportInputError';
  }
}

function parseParam(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v ?? undefined;
}

/** Parse an ISO date param, or throw if present-but-unparseable. Absent → undefined. */
function parseIsoOrThrow(raw: string | undefined, label: string): Date | undefined {
  if (raw == null) return undefined;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new ReportInputError(`Invalid ${label} date.`);
  return new Date(t);
}

/**
 * Resolve a bounded, validated window from raw `from`/`to`. `now` is injected for determinism/testing.
 * Rules: missing `to` → now; missing `from` → to − DEFAULT_WINDOW_DAYS; `to` is clamped to now (no future
 * upper bound); `from ≥ to` rejected; span > MAX_WINDOW_DAYS rejected; a `from` in the future (after clamping)
 * yields `from ≥ to` and is therefore rejected.
 */
export function resolveReportWindow(
  now: Date,
  fromRaw: string | string[] | undefined,
  toRaw: string | string[] | undefined,
): ReportWindow {
  const parsedTo = parseIsoOrThrow(parseParam(toRaw), 'to');
  const parsedFrom = parseIsoOrThrow(parseParam(fromRaw), 'from');

  // Upper bound never exceeds now (future-only windows collapse and are rejected below).
  const to = new Date(Math.min((parsedTo ?? now).getTime(), now.getTime()));
  const from = parsedFrom ?? new Date(to.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS);

  if (from.getTime() >= to.getTime()) {
    throw new ReportInputError('Report window must have from < to (and cannot be entirely in the future).');
  }
  if (to.getTime() - from.getTime() > MAX_WINDOW_DAYS * DAY_MS) {
    throw new ReportInputError(`Report window may not exceed ${MAX_WINDOW_DAYS} days.`);
  }
  return { from, to };
}

/** Resolve a bounded top-N. Absent → DEFAULT_TOP_N. Non-integer / < 1 / > MAX_TOP_N → rejected. */
export function resolveTopN(raw: string | string[] | undefined): number {
  const s = parseParam(raw);
  if (s == null) return DEFAULT_TOP_N;
  if (!/^\d+$/.test(s)) throw new ReportInputError('Invalid top-N limit.');
  const n = Number(s);
  if (n < 1) throw new ReportInputError('Top-N limit must be at least 1.');
  if (n > MAX_TOP_N) throw new ReportInputError(`Top-N limit may not exceed ${MAX_TOP_N}.`);
  return n;
}
