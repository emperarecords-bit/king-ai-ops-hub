import { randomUUID } from 'node:crypto';

/**
 * Builds a workspace key for a test fixture, using the reserved prefix that
 * operational reads exclude (src/lib/fixtures.ts, O-3).
 *
 * Always use this instead of hand-rolling a key. A fixture workspace that
 * misses the convention silently pollutes the usage harvest, and the whole
 * point of the harvest is that it can be trusted without interpretation.
 */
export function fixtureKey(purpose: string): string {
  return `zz-fixture-${purpose}-${randomUUID().slice(0, 8)}`;
}
