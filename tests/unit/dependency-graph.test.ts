import { describe, expect, it } from 'vitest';
import { hasCycle } from '@/domain/dependencies/dependencies';

/**
 * Cycle detection (O-18) — the pure Kahn's-algorithm core that guarantees the
 * bounded traversal never recurses a cycle.
 */
describe('hasCycle', () => {
  it('a simple chain A→B→C has no cycle', () => {
    expect(
      hasCycle(['A', 'B', 'C'], [
        ['A', 'B'],
        ['B', 'C'],
      ]),
    ).toBe(false);
  });

  it('a fan-out A→B, A→C has no cycle (parallel work, not a loop)', () => {
    expect(
      hasCycle(['A', 'B', 'C'], [
        ['A', 'B'],
        ['A', 'C'],
      ]),
    ).toBe(false);
  });

  it('A→B→C→A is a cycle', () => {
    expect(
      hasCycle(['A', 'B', 'C'], [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'A'],
      ]),
    ).toBe(true);
  });

  it('a 2-node cycle A→B→A is detected', () => {
    expect(
      hasCycle(['A', 'B'], [
        ['A', 'B'],
        ['B', 'A'],
      ]),
    ).toBe(true);
  });

  it('edges to nodes outside the set are ignored', () => {
    expect(hasCycle(['A', 'B'], [['A', 'B'], ['B', 'Z']])).toBe(false);
  });

  it('a self-edge counts as a cycle', () => {
    expect(hasCycle(['A'], [['A', 'A']])).toBe(true);
  });
});
