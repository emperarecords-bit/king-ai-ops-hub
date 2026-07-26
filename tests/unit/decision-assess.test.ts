import { describe, expect, it } from 'vitest';
import { assessDecision } from '@/domain/decisions/assess';

/**
 * The ONE shared decision-state assessment. Locks the states the Portfolio, Detail, and Decision
 * Memory selector all agree on — a decision cannot be active on one surface and inactive on another.
 */
const NOW = new Date('2026-07-26T00:00:00.000Z');
const base = {
  status: 'accepted' as const,
  applicability: 'guidance' as const,
  scope: 'workspace' as const,
  scopeTaskId: null,
  scopeObjectiveId: null,
  scopeTaskStatus: null,
  scopeObjectiveStatus: null,
  effectiveUntil: null,
  now: NOW,
};

describe('assessDecision — one shared state', () => {
  it('valid active guidance is active', () => {
    const a = assessDecision(base);
    expect(a.isActiveGuidance).toBe(true);
    expect(a.guidanceState).toBe('active');
    expect(a.historical).toBe(false);
  });

  it('accepted record-only is not guidance and never active', () => {
    const a = assessDecision({ ...base, applicability: 'record' });
    expect(a.isActiveGuidance).toBe(false);
    expect(a.memoryRole).toBe('record');
    expect(a.inactiveReason).toBe('record_only');
    expect(a.historical).toBe(false); // a legitimate current record, not history
  });

  it('expired guidance is inactive and historical', () => {
    const a = assessDecision({ ...base, effectiveUntil: new Date('2020-01-01') });
    expect(a.isActiveGuidance).toBe(false);
    expect(a.inactiveReason).toBe('expired');
    expect(a.historical).toBe(true);
  });

  it('task guidance whose task completed is inactive (task_closed)', () => {
    const a = assessDecision({ ...base, scope: 'task', scopeTaskId: 't1', scopeTaskStatus: 'completed' });
    expect(a.isActiveGuidance).toBe(false);
    expect(a.inactiveReason).toBe('task_closed');
  });

  it('objective guidance whose objective was cancelled is inactive (objective_closed)', () => {
    const a = assessDecision({ ...base, scope: 'objective', scopeObjectiveId: 'o1', scopeObjectiveStatus: 'cancelled' });
    expect(a.isActiveGuidance).toBe(false);
    expect(a.inactiveReason).toBe('objective_closed');
  });

  it('guidance with a missing target is invalid scope (a defect, not history)', () => {
    const a = assessDecision({ ...base, scope: 'task', scopeTaskId: null });
    expect(a.isActiveGuidance).toBe(false);
    expect(a.inactiveReason).toBe('invalid_scope');
    expect(a.historical).toBe(false);
  });

  it('retired and superseded are terminal and historical', () => {
    expect(assessDecision({ ...base, status: 'retired' }).historical).toBe(true);
    expect(assessDecision({ ...base, status: 'superseded' }).historical).toBe(true);
    expect(assessDecision({ ...base, status: 'rejected' }).historical).toBe(true);
    expect(assessDecision({ ...base, status: 'retired' }).isActiveGuidance).toBe(false);
  });

  it('proposed offers review actions and is not active', () => {
    const a = assessDecision({ ...base, status: 'proposed' });
    expect(a.isActiveGuidance).toBe(false);
    expect(a.actions).toContain('accept_record');
    expect(a.actions).toContain('accept_guidance');
    expect(a.actions).toContain('refuse');
  });
});
