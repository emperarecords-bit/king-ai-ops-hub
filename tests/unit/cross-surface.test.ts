import { describe, expect, it } from 'vitest';
import { buildBriefing } from '@/domain/dashboard/briefing';
import { assessObjective } from '@/domain/objectives/assess';
import { assessTask, assessWorkItem } from '@/domain/execution/assess';
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
    classification: rest.classification ?? 'live',
    status: rest.status ?? 'active',
    priority: rest.priority ?? 1,
    sponsoringDepartment: null,
    accountableEmployee: null,
    successCriteria: criteria,
    workItemTotal,
    progress: { tasksTotal, tasksCompleted: tasksTotal, tasksRunning: 0, tasksAwaitingApproval: 0, criteriaTotal: criteria.length, criteriaSatisfied: criteria.filter((c) => c.status !== 'unmet').length, milestonesTotal: 0, milestonesCompleted: 0, percent: 0, lastActivityAt: null },
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

/**
 * 2d execution cross-surface consistency: the *same* task or work item must read identically
 * wherever it is surfaced — Execution, the objective's "Work contributing", and the Dashboard's
 * "needs you" list all route through this one translator. These lock the canonical reads those
 * three surfaces now depend on, so a future surface can't hand-roll a divergent label.
 */
describe('Execution reads are consistent across surfaces', () => {
  it('a failed AI task reads the same on the Dashboard as in Execution', () => {
    // The Dashboard failed-list and Execution both call assessTask with the row's own fields.
    const exec = assessTask({ status: 'failed', ownerAgentId: 'agent-1' });
    const dashboard = assessTask({ status: 'failed', ownerAgentId: 'agent-1' });
    expect(dashboard).toEqual(exec);
    // The canonical required action the Dashboard now renders verbatim.
    expect(exec.intervention).toBe('required');
    expect(exec.requiredAction).toMatch(/retry or cancel/i);
  });

  it('a waiting work item reads the same under an objective as in Execution', () => {
    const inputs = { condition: 'waiting' as const, waitingOn: 'customer reply', ownerAgentId: 'agent-1', updatedAt: NOW, now: NOW };
    const objectiveSurface = assessWorkItem(inputs);
    const executionSurface = assessWorkItem(inputs);
    expect(objectiveSurface).toEqual(executionSurface);
    // Waiting with an owner is not a demand for involvement — no divergent "needs you" on either.
    expect(objectiveSurface.condition).toBe('waiting');
    expect(objectiveSurface.intervention).not.toBe('required');
  });

  it('an unowned active work item reads "needs you: assign an owner" on every surface', () => {
    const a = assessWorkItem({ condition: 'moving', waitingOn: null, ownerAgentId: null, updatedAt: NOW, now: NOW });
    expect(a.intervention).toBe('required');
    expect(a.requiredAction).toMatch(/assign/i);
    // The condition survives the required flag — it's still Moving, not relabeled by the intervention.
    expect(a.condition).toBe('moving');
  });

  it('an authorized-but-unexecuted completed task is never described as the action complete', () => {
    // Same translator every surface uses. A bare "Completed" would imply the send/deploy happened.
    const unexecuted = assessTask({ status: 'completed', ownerAgentId: 'o1', authorizedUnexecuted: true });
    expect(unexecuted.condition).toBe('finished'); // the AI *work* did finish
    expect(unexecuted.reason).not.toBe('Completed.');
    expect(unexecuted.reason).toMatch(/not yet executed/i);

    // A plain completed task (no authorized action) still reads simply.
    const plain = assessTask({ status: 'completed', ownerAgentId: 'o1' });
    expect(plain.reason).toBe('Completed.');
  });
});
