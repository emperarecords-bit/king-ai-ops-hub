/**
 * Fixture workspace convention (Sprint 11, O-3).
 *
 * Test fixtures create real rows in the real database. Left unmarked they
 * accumulate into operational reads — by week 0 of Sprint 11 the usage harvest
 * was reporting 6 pending approvals and 10 objectives that no human had ever
 * touched. A diagnostic you have to mentally filter is one you stop reading,
 * so the observation system must exclude them structurally.
 *
 * The convention: every workspace created by a test or an automated scenario
 * carries one of the reserved key prefixes below. Operational reads —
 * the harvest, and anything else that answers "what is really happening" —
 * filter them out. Tenant isolation is unaffected; this is about honesty of
 * measurement, not access.
 *
 * `zz-` sorts last and reads as deliberate; no real workspace would be named
 * that way by accident, which is the property a reserved prefix needs.
 */

export const FIXTURE_KEY_PREFIXES = ['zz-fixture-', 'e2e-'] as const;

/** True when a workspace key belongs to a test fixture or E2E sandbox. */
export function isFixtureKey(key: string): boolean {
  return FIXTURE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

/**
 * SQL LIKE patterns for the reserved prefixes, for queries that must exclude
 * fixtures in the database rather than in JavaScript.
 */
export const FIXTURE_KEY_SQL_PATTERNS: readonly string[] = FIXTURE_KEY_PREFIXES.map(
  (prefix) => `${prefix}%`,
);
