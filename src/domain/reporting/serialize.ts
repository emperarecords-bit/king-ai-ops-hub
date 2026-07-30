/**
 * M0a serialization boundary — pure. Monetary values are `bigint` micros throughout the domain. Native
 * `JSON.stringify` THROWS on a bigint, and converting to `Number` risks precision loss above 2^53−1. This
 * helper deep-converts a report result into a JSON-safe view model where every bigint becomes an exact
 * DECIMAL STRING, so a full report can cross to any presentation layer without precision loss, unsafe-number
 * conversion, or serialization failure. Non-bigint values pass through unchanged.
 *
 * Formatting to dollars stays in the presentation layer (`src/components/reporting.tsx`), which renders
 * server-side; nothing here converts micros to a JS number.
 */

export type JsonSafe<T> = T extends bigint
  ? string
  : T extends (infer U)[]
    ? JsonSafe<U>[]
    : T extends object
      ? { [K in keyof T]: JsonSafe<T[K]> }
      : T;

/** Recursively convert every bigint to an exact decimal string. Preserves structure; no Number coercion. */
export function toJsonSafe<T>(value: T): JsonSafe<T> {
  if (typeof value === 'bigint') return value.toString() as JsonSafe<T>;
  if (Array.isArray(value)) return value.map((v) => toJsonSafe(v)) as JsonSafe<T>;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = toJsonSafe(v);
    return out as JsonSafe<T>;
  }
  return value as JsonSafe<T>;
}
