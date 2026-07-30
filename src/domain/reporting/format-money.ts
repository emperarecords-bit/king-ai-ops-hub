/**
 * M0a exact monetary formatter — pure, bigint-only. Formats USD micros to a dollar string using ONLY integer
 * division and remainder. It never coerces the bigint to a JS floating value, so it cannot lose precision for
 * amounts above the JS safe-integer limit. Sign is handled independently; zero and negative values (e.g.
 * estimated-minus-recorded differences) are supported.
 */

const MICROS_PER_USD = 1_000_000n;
const MICROS_PER_CENT = 10_000n; // 1e6 micros / 100 cents

/** Exact 6-decimal dollar string, e.g. `$0.750001`, `-$1.000001`, `$0.000000`. No rounding, no Number. */
export function formatMicrosExact(micros: bigint): string {
  if (typeof micros !== 'bigint') throw new TypeError('formatMicrosExact requires a bigint (micros)');
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const dollars = abs / MICROS_PER_USD; // bigint whole dollars
  const frac = abs % MICROS_PER_USD; // bigint 0..999_999
  const fracStr = frac.toString().padStart(6, '0');
  return `${negative ? '-' : ''}$${dollars.toString()}.${fracStr}`;
}

/**
 * Shorter 2-decimal display by EXACT integer rounding (round-half-up on the micro fraction). All-bigint; no
 * Number, no float. E.g. 1_004_999 → `$1.00`, 1_005_000 → `$1.01`, -1_000_001 → `-$1.00`.
 */
export function formatMicros2dp(micros: bigint): string {
  if (typeof micros !== 'bigint') throw new TypeError('formatMicros2dp requires a bigint (micros)');
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  // cents = round_half_up(abs / MICROS_PER_CENT), computed with integer arithmetic only.
  const cents = (abs + MICROS_PER_CENT / 2n) / MICROS_PER_CENT;
  const wholeDollars = cents / 100n;
  const remCents = cents % 100n;
  return `${negative ? '-' : ''}$${wholeDollars.toString()}.${remCents.toString().padStart(2, '0')}`;
}
