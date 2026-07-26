import { describe, expect, it } from 'vitest';
import { assessObjective, describeEvidence, type AssessInput } from '@/domain/objectives/assess';
import { type SuccessCriterion } from '@/types/domain';

function crit(status: SuccessCriterion['status'], label = 'c', verifiedAt = '2026-07-24T00:00:00.000Z', source: SuccessCriterion['source'] = 'manual'): SuccessCriterion {
  return { label, metric: label, target: 1, unit: '', source, status, verifiedBy: status === 'unmet' ? null : 'u', verifiedAt: status === 'unmet' ? null : verifiedAt };
}
function input(over: Partial<AssessInput>): AssessInput {
  return { status: 'active', criteria: [], taskTotal: 0, workItemTotal: 0, ...over };
}

/** Locks the acceptance cases from the Objectives structure review. */
describe('assessObjective — outcomes, not activity', () => {
  it('activity without outcome: confirms effort, not progress, and never shows a percentage', () => {
    const a = assessObjective(input({ criteria: [crit('unmet')], taskTotal: 12, workItemTotal: 3 }));
    expect(a.state).toBe('effort-only');
    expect(a.headline).toMatch(/effort/i);
    expect(a.headline).toMatch(/not outcome progress/i);
    expect(a.headline).not.toMatch(/%|\d+\s*percent/i);
  });

  it('advancing on evidence: "2 of 3 conditions met", not "67%"', () => {
    const a = assessObjective(input({ criteria: [crit('met'), crit('met'), crit('unmet')], taskTotal: 5 }));
    expect(a.state).toBe('advancing');
    expect(a.headline).toMatch(/advancing on evidence/i);
    expect(a.outcomeSummary).toBe('2 of 3 conditions met');
    expect(a.headline + a.outcomeSummary).not.toMatch(/%|67/);
  });

  it('insufficient evidence: cannot assess momentum, and does not claim healthy/stalled/low risk', () => {
    const a = assessObjective(input({ criteria: [crit('unmet')], taskTotal: 0, workItemTotal: 0 }));
    expect(a.state).toBe('insufficient');
    expect(a.headline).toMatch(/not enough current evidence|assess momentum/i);
    const all = a.headline + (a.confidence ?? '');
    expect(all).not.toMatch(/\bhealthy\b|\bstalled\b|low risk/i);
  });

  it('waived condition is never represented as achieved', () => {
    const a = assessObjective(input({ status: 'completed', criteria: [crit('met'), crit('met'), crit('waived')] }));
    expect(a.headline).toMatch(/waived/i);
    expect(a.headline).not.toMatch(/3 of 3|3 conditions met|achieved/i);
    expect(a.outcomeSummary).toBe('2 of 3 conditions met · 1 waived');
  });

  it('nested execution: human Work Items and AI tasks both appear as effort, not progress', () => {
    const a = assessObjective(input({ criteria: [crit('unmet')], taskTotal: 3, workItemTotal: 2 }));
    expect(a.work).toMatch(/3 AI tasks/);
    expect(a.work).toMatch(/2 Work Items/);
    expect(a.work).toMatch(/effort/i);
  });

  it('bounded claims: never says "on track" or "nothing is blocked"; uses "advancing on evidence"', () => {
    const cases: AssessInput[] = [
      input({ criteria: [crit('met'), crit('unmet')], taskTotal: 4 }),
      input({ criteria: [crit('unmet')], taskTotal: 9 }),
      input({ status: 'completed', criteria: [crit('met')] }),
    ];
    for (const c of cases) {
      const a = assessObjective(c);
      const text = `${a.headline} ${a.outcomeSummary} ${a.confidence ?? ''} ${a.work}`;
      expect(text).not.toMatch(/on track|nothing is blocked|nothing needs/i);
      expect(text).not.toMatch(/\b\d+%/);
    }
  });

  it('ready to close when every condition is met or waived', () => {
    const a = assessObjective(input({ criteria: [crit('met'), crit('waived')] }));
    expect(a.state).toBe('ready-to-close');
    expect(a.headline).toMatch(/ready for you to close/i);
  });

  it('a recently edited but still-unmet criterion does not create momentum', () => {
    // Editing resets a criterion to unmet; with no met conditions it stays effort/insufficient.
    const a = assessObjective(input({ criteria: [crit('unmet')], taskTotal: 4 }));
    expect(a.state).toBe('effort-only');
    expect(a.headline).not.toMatch(/advancing/i);
  });

  it('substantial outcome progress but STALE evidence reads as unconfirmed momentum, not advancing', () => {
    const a = assessObjective(input({
      criteria: [crit('met', 'a', '2026-06-01T00:00:00.000Z'), crit('met', 'b', '2026-06-01T00:00:00.000Z'), crit('unmet')],
      taskTotal: 3,
      now: new Date('2026-07-26T00:00:00.000Z'),
    }));
    expect(a.state).toBe('progressed');
    expect(a.outcomeSummary).toBe('2 of 3 conditions met'); // progress acknowledged
    expect(a.headline).toMatch(/not enough recent change|current momentum/i);
    expect(a.headline).not.toMatch(/advancing on evidence/i);
  });

  it('the same met conditions with FRESH evidence read as advancing', () => {
    const a = assessObjective(input({
      criteria: [crit('met', 'a', '2026-07-25T00:00:00.000Z'), crit('unmet')],
      now: new Date('2026-07-26T00:00:00.000Z'),
    }));
    expect(a.state).toBe('advancing');
  });

  it('an objective with no criteria is unassessable, never "0% progress"', () => {
    const a = assessObjective(input({ status: 'draft', criteria: [] }));
    expect(a.outcomeSummary).not.toMatch(/0|%/);
    expect(a.outcomeSummary).toMatch(/no success conditions/i);
  });

  it('a draft is judged as a draft, not by active expectations', () => {
    const a = assessObjective(input({ status: 'draft', criteria: [crit('unmet')], taskTotal: 5 }));
    expect(a.state).toBe('draft');
    expect(a.headline).not.toMatch(/effort|advancing|momentum/i);
  });
});

describe('describeEvidence — provenance wording matches what is stored', () => {
  it('human attestation is "Confirmed by …", never "Verified"', () => {
    const s = describeEvidence(crit('met', 'x', '2026-07-24T00:00:00.000Z', 'manual'), 'Jordan');
    expect(s).toBe('Confirmed by Jordan on 2026-07-24');
    expect(s).not.toMatch(/verified/i);
  });

  it('a linked/usage source earns "Verified from …"', () => {
    expect(describeEvidence(crit('met', 'x', '2026-07-24T00:00:00.000Z', 'usage'))).toMatch(/verified from usage data/i);
  });

  it('waived is described as waived, not confirmed or verified', () => {
    const s = describeEvidence(crit('waived', 'x', '2026-07-24T00:00:00.000Z'), 'Sam');
    expect(s).toMatch(/waived by sam/i);
    expect(s).not.toMatch(/confirmed|verified/i);
  });

  it('an unmet criterion has no evidence description', () => {
    expect(describeEvidence(crit('unmet'))).toBeNull();
  });
});
