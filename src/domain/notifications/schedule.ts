/**
 * Pure time helpers for quiet hours + digest scheduling. All wall-clock inputs are LOCAL ("HH:MM") interpreted in
 * an IANA `timezone`, and every conversion to an absolute instant is DST-correct (computed from the zone's actual
 * offset at that instant, never a fixed UTC hour). No DB, no side effects — unit-testable in isolation.
 */

/** Parse "HH:MM" (00:00–23:59) to minutes-from-midnight, or null when malformed. */
export function parseLocalTime(hhmm: string): number | null {
  const m = /^([0-2][0-9]):([0-5][0-9])$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23) return null;
  return h * 60 + min;
}

/** The zone's UTC offset (ms) at a given instant: (the instant's wall-clock in `tz`, read as if UTC) − the instant. */
export function tzOffsetMs(at: Date, timezone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(at)) p[part.type] = part.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - at.getTime();
}

/** Minutes-from-local-midnight that `nowUtc` currently shows in `timezone`. */
export function localMinutes(nowUtc: Date, timezone: string): number {
  const offset = tzOffsetMs(nowUtc, timezone);
  const local = new Date(nowUtc.getTime() + offset);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** The local calendar date (Y/M/D) that `nowUtc` shows in `timezone`. */
function localYmd(nowUtc: Date, timezone: string): { y: number; m: number; d: number } {
  const offset = tzOffsetMs(nowUtc, timezone);
  const local = new Date(nowUtc.getTime() + offset);
  return { y: local.getUTCFullYear(), m: local.getUTCMonth() + 1, d: local.getUTCDate() };
}

/** The absolute UTC instant for a given LOCAL wall-clock (y/m/d + minutes) in `timezone`, DST-correct. */
export function wallClockToUtc(y: number, m: number, d: number, minutes: number, timezone: string): Date {
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  // One correction pass resolves the offset at the target instant (handles DST transitions at the boundary).
  let utc = naive - tzOffsetMs(new Date(naive), timezone);
  utc = naive - tzOffsetMs(new Date(utc), timezone);
  return new Date(utc);
}

/**
 * Is `nowUtc` within the quiet window? Both bounds are local "HH:MM"; an end earlier than the start means the
 * window crosses midnight (e.g. 22:00–07:00). Returns false when quiet hours are not configured (either bound null).
 */
export function inQuietHours(nowUtc: Date, timezone: string, startLocal: string | null, endLocal: string | null): boolean {
  if (!startLocal || !endLocal) return false;
  const start = parseLocalTime(startLocal);
  const end = parseLocalTime(endLocal);
  if (start === null || end === null || start === end) return false;
  const cur = localMinutes(nowUtc, timezone);
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/**
 * The end of the quiet window as an absolute instant strictly after `nowUtc` (where a deferred non-critical send
 * should fire). Null when not in quiet hours. Crossing-midnight windows resolve to tomorrow's local end time.
 */
export function quietHoursEndAt(nowUtc: Date, timezone: string, startLocal: string | null, endLocal: string | null): Date | null {
  if (!inQuietHours(nowUtc, timezone, startLocal, endLocal)) return null;
  const end = parseLocalTime(endLocal!)!;
  const { y, m, d } = localYmd(nowUtc, timezone);
  let at = wallClockToUtc(y, m, d, end, timezone);
  if (at.getTime() <= nowUtc.getTime()) {
    // End already passed today in local terms (overnight window) → tomorrow's end.
    at = new Date(wallClockToUtc(y, m, d + 1, end, timezone).getTime());
  }
  return at;
}

/**
 * The next absolute instant matching any of `digestTimesLocal` (local "HH:MM") STRICTLY after `nowUtc`, or null
 * when no digest times are configured. DST-correct: each candidate is converted from local wall-clock to UTC.
 */
export function nextDigestAt(nowUtc: Date, timezone: string, digestTimesLocal: readonly string[]): Date | null {
  const mins = digestTimesLocal.map(parseLocalTime).filter((x): x is number => x !== null);
  if (mins.length === 0) return null;
  const { y, m, d } = localYmd(nowUtc, timezone);
  let best: number | null = null;
  // Consider today and the next two local days (covers DST + wrap), keep the earliest strictly-future instant.
  for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
    for (const min of mins) {
      const at = wallClockToUtc(y, m, d + dayOffset, min, timezone).getTime();
      if (at > nowUtc.getTime() && (best === null || at < best)) best = at;
    }
  }
  return best === null ? null : new Date(best);
}
