import { describe, expect, it } from 'vitest';
import { buildBriefing } from '@/domain/dashboard/briefing';
import { assessObjective } from '@/domain/objectives/assess';
import { type ObjectiveListRow } from '@/domain/objectives/objectives';
import { type SuccessCriterion } from '@/types/domain';

/**
 * The operating partner must not reach incompatible conclusions from the same evidence. The
 * Dashboard (buildBriefing) and the Objectives area (assessObjective) share one assessment model;
 * these tests lock that they agree on a given objective fixture.
 */

function crit(status: SuccessCriterion['status'], verifiedAt = '2026-07-25T00:00:00.000Z'): SuccessCriterion {
  return { label: 'c', metric: 'c', target: 1, unit: '', source: 'manual', status, verifiedBy: status === 'unmet' ? null : 'u', verifiedAt: status === 'unmet' ? null : verifiedAt };
}
function olr(over: Partial<ObjectiveListRow> & { criteria: SuccessCriterion[]; tasksTotal: number; workItemTotal: number }): ObjectiveListRow {
  const { criteria, tasksTotal, workItemTotal, ...rest } = over;
  return {
    id: rest.id ?? 'o1',
    title: rest.title ?? 'Objective',
    status: rest.status ?? 'active',
    priority: rest.priority ?? 1,
    sponsoringDepartment: null,
    accountableEmployee: null,
    successCriteria: criteria,
    workItemTotal,
    progress: { tasksTotal, tasksCompleted: tasksTotal, criteriaTotal: criteria.length, criteriaSatisfied: criteria.filter((c) => c.status !== 'unmet').length, milestonesTotal: 0, milestonesCompleted: 0, percent: 0 },
    createdAt: new Date('2026-07-01'),
  };
}
const NOW = new Date('2026-07-26T00:00:00.000Z');
const base = { business: 'AccurateBids', pendingApprovals: 0, failed: 0, now: NOW };

describe('Dashboard and Objectives agree on the same objective', () => {
  it('an effort-only objective is flagged on the Dashboard with the same read Objectives gives', () => {
    const criteria = [crit('unmet')];
    const a = assessObjective({ status: 'active', criteria, taskTotal: 12, workItemTotal: 0, now: NOW });
    expect(a.state).toBe('effort-only');

    const b = buildBriefing({ ...base, objectives: [olr({ criteria, tasksTotal: 12, workItemTotal: 0 })] });
    expect(b.mood).toBe('attention');
    expect(b.standout).not.toBeNull();
    // Same read, not a contradictory "stalled" label.
    expect(b.standout!.surface).toBe(a.headline);
  });

  it('an advancing objective is NEVER flagged as a Dashboard standout', () => {
    const criteria = [crit('met'), crit('unmet')];
    const a = assessObjective({ status: 'active', criteria, taskTotal: 4, workItemTotal: 0, now: NOW });
    expect(a.state).toBe('advancing');

    const b = buildBriefing({ ...base, objectives: [olr({ criteria, tasksTotal: 4, workItemTotal: 0 })] });
    expect(b.standout).toBeNull();
    expect(b.mood).toBe('normal');
  });

  it('a progressed-but-stale objective is flagged, not called "advancing"', () => {
    const criteria = [crit('met', '2026-06-01T00:00:00.000Z'), crit('unmet')];
    const a = assessObjective({ status: 'active', criteria, taskTotal: 2, workItemTotal: 0, now: NOW });
    expect(a.state).toBe('progressed');

    const b = buildBriefing({ ...base, objectives: [olr({ criteria, tasksTotal: 2, workItemTotal: 0 })] });
    expect(b.standout).not.toBeNull();
    expect(b.standout!.surface).not.toMatch(/advancing on evidence/i);
  });
});
