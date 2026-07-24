import { describe, expect, it } from 'vitest';
import { usableSuggestions } from '@/domain/objectives/suggest';

/**
 * Regression pins for O-11, using the ACTUAL suggestions the model produced
 * for the first real objective ("connect all ai to this hub"). Three of the
 * four could not function as criteria.
 *
 * The rule these protect: D-017 requires a measurable definition of success
 * before an objective activates. A criterion of "count >= 0" is satisfied
 * before any work happens, so admitting one turns the completion gate into
 * ceremony.
 */
const REAL_SUGGESTIONS = [
  { label: 'Number of AI chat sources connected to the hub', target: 0, unit: 'count' },
  { label: 'Number of project/workspace integrations connected', target: 0, unit: 'count' },
  { label: 'Percentage of chats searchable in one place', target: 100, unit: '%' },
  { label: 'Date by which the first end-to-end connection works', target: 0, unit: 'date' },
];

describe('usableSuggestions', () => {
  it('keeps only the one usable criterion from the real O-11 case', () => {
    const kept = usableSuggestions(REAL_SUGGESTIONS, 'test-project');
    expect(kept).toHaveLength(1);
    expect(kept[0]!.label).toContain('Percentage');
  });

  it('drops zero targets for growth units', () => {
    for (const unit of ['count', '%', 'percent', 'USD', 'users', 'customers']) {
      expect(usableSuggestions([{ label: 'x', target: 0, unit }], 'p'), unit).toHaveLength(0);
    }
  });

  it('keeps zero targets for units that are not about growth', () => {
    // "zero critical defects" is a real goal; the strictness is about
    // suggestions that say "at least none of something".
    const kept = usableSuggestions([{ label: 'Critical defects', target: 0, unit: 'defects' }], 'p');
    expect(kept).toHaveLength(1);
  });

  it('drops deadlines — schedule is not success, and target cannot hold a date', () => {
    expect(usableSuggestions([{ label: 'Ship by', target: 20261201, unit: 'date' }], 'p')).toHaveLength(0);
  });

  it('drops negative targets regardless of unit', () => {
    expect(usableSuggestions([{ label: 'x', target: -5, unit: 'anything' }], 'p')).toHaveLength(0);
  });

  it('passes through suggestions that are already usable', () => {
    const good = [
      { label: '100 beta users signed up', target: 100, unit: 'users' },
      { label: 'Uptime', target: 99.5, unit: '%' },
    ];
    expect(usableSuggestions(good, 'p')).toEqual(good);
  });
});
