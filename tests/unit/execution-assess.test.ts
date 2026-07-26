import { describe, expect, it } from 'vitest';
import { assessTask, assessWorkItem } from '@/domain/execution/assess';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const FRESH = new Date('2026-07-25T00:00:00.000Z');
const STALE = new Date('2026-07-10T00:00:00.000Z');

describe('execution translator — condition, intervention, and reason stay separate', () => {
  it('a Waiting human item with an owner needs no intervention (stays out of Requires You)', () => {
    const a = assessWorkItem({ condition: 'waiting', waitingOn: 'customer reply', ownerAgentId: 'o1', updatedAt: FRESH, now: NOW });
    expect(a.condition).toBe('waiting');
    expect(a.intervention).toBe('none');
    expect(a.reason).toMatch(/waiting on customer reply/i);
  });

  it('an approval-gated task is Waiting AND Required — the condition is not replaced', () => {
    const a = assessTask({ status: 'awaiting_approval', ownerAgentId: 'o1' });
    expect(a.condition).toBe('waiting');
    expect(a.intervention).toBe('required');
    expect(a.requiredAction).toBe('Approve or return');
  });

  it('a legacy Work Item with no condition reads Unknown, never Planned', () => {
    const a = assessWorkItem({ condition: null, waitingOn: null, ownerAgentId: 'o1', updatedAt: FRESH, now: NOW });
    expect(a.condition).toBe('unknown');
    expect(a.condition).not.toBe('planned');
    expect(a.intervention).toBe('required');
    expect(a.requiredAction).toMatch(/confirm the current condition/i);
    expect(a.source).toBe('unknown');
  });

  it('a Moving unowned task is Required without losing its Moving condition', () => {
    const a = assessTask({ status: 'running', ownerAgentId: null });
    expect(a.condition).toBe('moving');
    expect(a.intervention).toBe('required');
    expect(a.requiredAction).toBe('Assign an accountable owner');
  });

  it('human-reported condition carries different source/confidence than system-observed', () => {
    const human = assessWorkItem({ condition: 'moving', waitingOn: null, ownerAgentId: 'o1', updatedAt: STALE, now: NOW });
    const system = assessTask({ status: 'running', ownerAgentId: 'o1' });
    expect(human.source).toBe('human-reported');
    expect(human.confidence).toMatch(/limited/i); // stale report
    expect(system.source).toBe('system-observed');
    expect(system.confidence).toBeNull();
  });

  it('required action changes with state', () => {
    expect(assessTask({ status: 'awaiting_approval', ownerAgentId: 'o1' }).requiredAction).toBe('Approve or return');
    expect(assessTask({ status: 'failed', ownerAgentId: 'o1' }).requiredAction).toBe('Retry or cancel');
    expect(assessTask({ status: 'completed', ownerAgentId: 'o1' }).intervention).toBe('none');
  });

  it('a fresh Moving human item is just Moving — no false watch', () => {
    const a = assessWorkItem({ condition: 'moving', waitingOn: null, ownerAgentId: 'o1', updatedAt: FRESH, now: NOW });
    expect(a.condition).toBe('moving');
    expect(a.intervention).toBe('none');
    expect(a.confidence).toBeNull();
  });
});
