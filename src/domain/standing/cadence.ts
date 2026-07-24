import { type Cadence } from '@/types/domain';

/**
 * Pure cadence math for standing work (Sprint 8). Deliberately dependency-free
 * — no database, no server-only imports — so it is unit-testable in isolation
 * and safe to import from anywhere.
 *
 * The invariant every caller relies on: the result is ALWAYS strictly after
 * `from`. A schedule can never compute a due time in the past, so a missed or
 * delayed tick runs once, never N times.
 */
export function computeNextRunAt(
  rule: { cadence: Cadence; atHour: number; weekday: number | null; monthday: number | null },
  from: Date,
): Date {
  const candidate = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate(), rule.atHour),
  );
  const bump = (days: number) => candidate.setUTCDate(candidate.getUTCDate() + days);

  if (rule.cadence === 'daily') {
    if (candidate <= from) bump(1);
    return candidate;
  }
  if (rule.cadence === 'weekly') {
    const target = rule.weekday ?? 1;
    while (candidate.getUTCDay() !== target || candidate <= from) bump(1);
    return candidate;
  }
  // monthly — monthday is capped at 28 so every month has the day.
  const target = rule.monthday ?? 1;
  candidate.setUTCDate(target);
  while (candidate <= from) {
    candidate.setUTCDate(1);
    candidate.setUTCMonth(candidate.getUTCMonth() + 1);
    candidate.setUTCDate(target);
  }
  return candidate;
}
