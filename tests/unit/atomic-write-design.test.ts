import { describe, expect, it } from 'vitest';
import { advanceAtomicWriteDesign, ATOMIC_WRITE_STAGES, crashAtomicWriteDesign, identityRecheckMatches, type AtomicWriteDesignState } from '@/domain/execution/atomic-write-design';

describe('side-effect-free atomic write design state machine', () => {
  it('requires every design stage in order', () => {
    let state: AtomicWriteDesignState = { completed: [], ambiguous: false };
    for (const stage of ATOMIC_WRITE_STAGES) state = advanceAtomicWriteDesign(state, stage);
    expect(state.completed).toEqual(ATOMIC_WRITE_STAGES);
    expect(() => advanceAtomicWriteDesign(state, 'intent_recorded')).toThrow();
  });
  it('blocks target or parent identity substitution immediately before commit', () => {
    expect(identityRecheckMatches(['parent', 'target'], ['parent', 'target'])).toBe(true);
    expect(identityRecheckMatches(['parent', 'target'], ['swapped', 'target'])).toBe(false);
  });
  it('classifies pre-commit crashes as not executed and post-commit/result-loss crashes as ambiguous', () => {
    let state: AtomicWriteDesignState = { completed: [], ambiguous: false };
    for (const stage of ATOMIC_WRITE_STAGES.slice(0, ATOMIC_WRITE_STAGES.indexOf('atomic_commit'))) state = advanceAtomicWriteDesign(state, stage);
    expect(crashAtomicWriteDesign(state)).toBe('definitely_not_executed');
    state = advanceAtomicWriteDesign(state, 'atomic_commit');
    expect(crashAtomicWriteDesign(state)).toBe('ambiguous');
  });
});
