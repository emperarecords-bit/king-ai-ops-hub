import { describe, expect, it } from 'vitest';
import { classificationLabel, exclusionNote, exclusionSummary, visibilityFromParam, visibilityToggleHref } from '@/domain/classification/classification';
import { selectableTaskCandidates } from '@/domain/tasks/tasks';

/** HUB-009 Gate 3B — the page-scoped visibility parsing + exclusion-note copy (pure). */

describe('HUB-009 visibility parsing (?includeNonLive=1)', () => {
  it('defaults to live-only and treats absent/invalid values as off', () => {
    expect(visibilityFromParam(undefined)).toEqual({ includeNonLive: false });
    expect(visibilityFromParam('')).toEqual({ includeNonLive: false });
    expect(visibilityFromParam('0')).toEqual({ includeNonLive: false });
    expect(visibilityFromParam('true')).toEqual({ includeNonLive: false });
    expect(visibilityFromParam('yes')).toEqual({ includeNonLive: false });
  });
  it('turns on ONLY for a single scalar value exactly "1"', () => {
    expect(visibilityFromParam('1')).toEqual({ includeNonLive: true });
    expect(visibilityFromParam('1 ')).toEqual({ includeNonLive: false });
  });
  it('a REPEATED/array parameter is always off — inclusion is never enabled by picking one array element', () => {
    expect(visibilityFromParam(['1'])).toEqual({ includeNonLive: false });
    expect(visibilityFromParam(['0', '1'])).toEqual({ includeNonLive: false });
    expect(visibilityFromParam(['1', '0'])).toEqual({ includeNonLive: false }); // repeated ?includeNonLive=1&includeNonLive=0
    expect(visibilityFromParam(['1', '1'])).toEqual({ includeNonLive: false });
  });
});

describe('HUB-009 exclusion note', () => {
  it('renders nothing when total is zero (no misleading "0 excluded")', () => {
    expect(exclusionNote(exclusionSummary({ excludedDemo: 0, excludedSeed: 0 }))).toBeNull();
  });
  it('reports demo and seed separately, never merged', () => {
    expect(exclusionNote(exclusionSummary({ excludedDemo: 4, excludedSeed: 0 }))).toBe('4 demo records excluded');
    expect(exclusionNote(exclusionSummary({ excludedDemo: 1, excludedSeed: 0 }))).toBe('1 demo record excluded');
    expect(exclusionNote(exclusionSummary({ excludedDemo: 2, excludedSeed: 3 }))).toBe('2 demo + 3 seed records excluded');
  });
});

describe('HUB-009 toggle href — propagation semantics', () => {
  it('turning ON sets includeNonLive=1 and PRESERVES unrelated params', () => {
    const href = visibilityToggleHref('/p/x/work', { tab: 'active', q: 'foo' }, true);
    expect(href.startsWith('/p/x/work?')).toBe(true);
    const qs = new URLSearchParams(href.split('?')[1]);
    expect(qs.get('includeNonLive')).toBe('1');
    expect(qs.get('tab')).toBe('active');
    expect(qs.get('q')).toBe('foo');
  });
  it('turning OFF removes ONLY includeNonLive and keeps the rest', () => {
    const href = visibilityToggleHref('/p/x/work', { includeNonLive: '1', tab: 'active' }, false);
    const qs = new URLSearchParams(href.split('?')[1] ?? '');
    expect(qs.get('includeNonLive')).toBeNull();
    expect(qs.get('tab')).toBe('active');
  });
  it('with no other params, off yields a bare pathname (no ?)', () => {
    expect(visibilityToggleHref('/p/x/work', { includeNonLive: '1' }, false)).toBe('/p/x/work');
  });
});

describe('HUB-009 classification label', () => {
  it('labels only non-live rows', () => {
    expect(classificationLabel('live')).toBeNull();
    expect(classificationLabel('demo')).toBe('Demo');
    expect(classificationLabel('seed')).toBe('Seed');
  });
});

describe('HUB-009 selectable dependency/supersede candidates (pure)', () => {
  const rows = [
    { id: 'self', classification: 'live' as const },
    { id: 'live1', classification: 'live' as const },
    { id: 'demo1', classification: 'demo' as const },
    { id: 'seed1', classification: 'seed' as const },
    { id: 'prereq', classification: 'live' as const },
  ];
  it('offers only LIVE candidates, excludes self + already-linked, drops demo AND seed', () => {
    const out = selectableTaskCandidates(rows, { excludeId: 'self', excludeIds: new Set(['prereq']) });
    expect(out.map((r) => r.id)).toEqual(['live1']);
    expect(out.every((r) => r.classification === 'live')).toBe(true);
  });
});
