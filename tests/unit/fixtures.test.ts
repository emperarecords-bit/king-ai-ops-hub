import { describe, expect, it } from 'vitest';
import { FIXTURE_KEY_PREFIXES, isFixtureKey } from '@/lib/fixtures';

/**
 * The fixture convention exists so operational reads can be trusted without
 * interpretation (O-3). Two ways it can fail: a fixture that looks real
 * (pollution returns), or a real workspace that looks like a fixture (silently
 * dropped from the harvest — worse, because it hides real usage).
 */
describe('fixture key convention', () => {
  it('recognizes every reserved prefix', () => {
    for (const prefix of FIXTURE_KEY_PREFIXES) {
      expect(isFixtureKey(`${prefix}something-a1b2c3d4`), prefix).toBe(true);
    }
  });

  it('does not claim the real workspaces', () => {
    // Every workspace the owner actually uses. If one of these ever matches,
    // real usage disappears from the harvest and the sprint measures nothing.
    const real = [
      'accuratebids',
      'kodiscan',
      'bushandbelly',
      'stresspro',
      'partshunt-pro',
      'king-ai-ops-hub',
      'kingdom-core',
    ];
    for (const key of real) {
      expect(isFixtureKey(key), key).toBe(false);
    }
  });

  it('matches on prefix, not substring — a real key containing the word is safe', () => {
    expect(isFixtureKey('my-e2e-notes')).toBe(false);
    expect(isFixtureKey('project-zz-fixture-review')).toBe(false);
  });
});
