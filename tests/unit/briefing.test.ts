import { describe, expect, it } from 'vitest';
import { buildBriefing } from '@/domain/dashboard/briefing';
import { type ObjectiveListRow } from '@/domain/objectives/objectives';

function obj(over: Partial<ObjectiveListRow> & { tasksTotal: number; tasksCompleted: number; percent: number }): ObjectiveListRow {
  const { tasksTotal, tasksCompleted, percent, ...rest } = over;
  return {
    id: rest.id ?? 'o1',
    title: rest.title ?? 'Objective',
    status: rest.status ?? 'active',
    priority: rest.priority ?? 1,
    sponsoringDepartment: rest.sponsoringDepartment ?? null,
    accountableEmployee: rest.accountableEmployee ?? null,
    createdAt: rest.createdAt ?? new Date('2026-07-01'),
    progress: {
      tasksTotal,
      tasksCompleted,
      criteriaTotal: 0,
      criteriaSatisfied: 0,
      milestonesTotal: 0,
      milestonesCompleted: 0,
      percent,
    },
  };
}

const base = { business: 'AccurateBids', pendingApprovals: 0, failed: 0 };

describe('buildBriefing — the honest health verdict', () => {
  it('does not cry wolf: a brand-new active objective with no tasks is not a standout', () => {
    const b = buildBriefing({ ...base, objectives: [obj({ tasksTotal: 0, tasksCompleted: 0, percent: 0 })] });
    expect(b.standout).toBeNull();
    expect(b.mood).toBe('normal');
    expect(b.verdict).toBe('AccurateBids is operating normally.');
  });

  it('flags a stalled objective — all tasks done but not closed — as the standout', () => {
    const b = buildBriefing({ ...base, objectives: [obj({ tasksTotal: 3, tasksCompleted: 3, percent: 80, title: 'Onboarding revamp' })] });
    expect(b.mood).toBe('attention');
    expect(b.standout?.title).toBe('Onboarding revamp');
    expect(b.verdict).toContain('one thing stands out');
  });

  it('labels the business consequence as an inference, never a fact', () => {
    const b = buildBriefing({ ...base, objectives: [obj({ tasksTotal: 2, tasksCompleted: 2, percent: 50 })] });
    expect(b.standout?.reasoning.businessImpact).toMatch(/likely, not confirmed/i);
    // Evidence is what it can prove — no causal claim.
    expect(b.standout?.reasoning.evidence).toContain('2 of 2 tasks complete');
  });

  it('is uncertain — not falsely green — when there are no active objectives to judge', () => {
    const b = buildBriefing({ ...base, objectives: [obj({ status: 'draft', tasksTotal: 0, tasksCompleted: 0, percent: 0 })] });
    expect(b.mood).toBe('uncertain');
    expect(b.verdict).toContain("can't confidently assess");
    expect(b.standout).toBeNull();
  });

  it('treats waiting approvals as attention without a standout', () => {
    const b = buildBriefing({ ...base, pendingApprovals: 3, objectives: [obj({ tasksTotal: 1, tasksCompleted: 0, percent: 0 })] });
    expect(b.mood).toBe('attention');
    expect(b.standout).toBeNull();
    expect(b.verdict).toContain('approvals are waiting');
  });

  it('picks the highest-priority stalled objective (list is priority-ordered)', () => {
    const b = buildBriefing({
      ...base,
      objectives: [
        obj({ id: 'top', title: 'First', priority: 1, tasksTotal: 2, tasksCompleted: 2, percent: 40 }),
        obj({ id: 'low', title: 'Second', priority: 5, tasksTotal: 1, tasksCompleted: 1, percent: 90 }),
      ],
    });
    expect(b.standout?.objectiveId).toBe('top');
    // The other advancing/standing objectives are acknowledged in reassurance.
    expect(b.reassurance).toBeNull(); // both stalled → nothing left advancing
  });

  it('reassures about the rest of the business when something else stands out', () => {
    const b = buildBriefing({
      ...base,
      objectives: [
        obj({ id: 'stalled', priority: 1, tasksTotal: 2, tasksCompleted: 2, percent: 50 }),
        obj({ id: 'moving', priority: 2, tasksTotal: 4, tasksCompleted: 1, percent: 25 }),
      ],
    });
    expect(b.reassurance).toContain('1 other objective advancing');
  });
});
