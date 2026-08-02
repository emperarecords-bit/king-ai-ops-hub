import { describe, expect, it } from 'vitest';
import { createTaskSchema } from '@/domain/tasks/tasks';
import { createScheduleSchema } from '@/domain/standing/standing';

/**
 * P1a agent pinning — pure schema contract for the assignment fields. No DB: this pins the refinements
 * (primary required; reviewer required IFF reviewEnabled and never equal to the primary) so a form/API
 * shape can never bypass them. Workspace validation of the ids is exercised by the integration suite.
 */

const PID = '11111111-1111-4111-8111-111111111111';
const RID = '22222222-2222-4222-8222-222222222222';

const baseTask = {
  title: 'T',
  input: 'do a thing',
  providerSelection: 'openai' as const,
  reviewEnabled: false,
  primaryAgentId: PID,
};

describe('createTaskSchema — agent pinning refinements', () => {
  it('requires a primary agent id', () => {
    const r = createTaskSchema.safeParse({ ...baseTask, primaryAgentId: undefined });
    expect(r.success).toBe(false);
  });

  it('accepts a primary with review disabled and no reviewer', () => {
    const r = createTaskSchema.safeParse({ ...baseTask, reviewEnabled: false, reviewerAgentId: null });
    expect(r.success).toBe(true);
  });

  it('rejects review enabled without a reviewer', () => {
    const r = createTaskSchema.safeParse({ ...baseTask, reviewEnabled: true, reviewerAgentId: null });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message).join(' ')).toMatch(/reviewer/i);
  });

  it('rejects a reviewer when review is disabled', () => {
    const r = createTaskSchema.safeParse({ ...baseTask, reviewEnabled: false, reviewerAgentId: RID });
    expect(r.success).toBe(false);
  });

  it('rejects a reviewer equal to the primary', () => {
    const r = createTaskSchema.safeParse({ ...baseTask, reviewEnabled: true, reviewerAgentId: PID });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message).join(' ')).toMatch(/different employee/i);
  });

  it('accepts review enabled with a distinct reviewer', () => {
    const r = createTaskSchema.safeParse({ ...baseTask, reviewEnabled: true, reviewerAgentId: RID });
    expect(r.success).toBe(true);
  });
});

const baseSchedule = {
  title: 'S',
  input: 'recurring brief',
  providerSelection: 'openai' as const,
  cadence: 'daily' as const,
  assignedPrimaryAgentId: PID,
};

describe('createScheduleSchema — agent pinning refinements', () => {
  it('requires an assigned primary', () => {
    const r = createScheduleSchema.safeParse({ ...baseSchedule, assignedPrimaryAgentId: undefined });
    expect(r.success).toBe(false);
  });

  it('review defaults on, so a reviewer is required by default', () => {
    const r = createScheduleSchema.safeParse({ ...baseSchedule });
    expect(r.success).toBe(false);
  });

  it('accepts review off with no reviewer', () => {
    const r = createScheduleSchema.safeParse({ ...baseSchedule, reviewEnabled: false });
    expect(r.success).toBe(true);
  });

  it('accepts review on with a distinct reviewer', () => {
    const r = createScheduleSchema.safeParse({ ...baseSchedule, reviewEnabled: true, assignedReviewerAgentId: RID });
    expect(r.success).toBe(true);
  });

  it('rejects a reviewer equal to the primary', () => {
    const r = createScheduleSchema.safeParse({ ...baseSchedule, reviewEnabled: true, assignedReviewerAgentId: PID });
    expect(r.success).toBe(false);
  });
});
