import { describe, expect, it } from 'vitest';
import { type AttributionLookups, attributeUsage } from '@/domain/reporting/attribution';

const PRIMARY = 'a-primary';
const REVIEWER = 'a-reviewer';
const OTHER = 'a-other';
const GONE = 'a-removed';

function lookups(over: Partial<AttributionLookups> = {}): AttributionLookups {
  const steps = new Map([
    ['s-primary', { kind: 'primary' as const, agentId: null }],
    ['s-review', { kind: 'review' as const, agentId: null }],
    ['s-revision', { kind: 'revision' as const, agentId: null }],
    ['s-consolidate', { kind: 'consolidate' as const, agentId: null }],
    ['s-stepagent', { kind: 'primary' as const, agentId: OTHER }],
    ['s-gone', { kind: 'primary' as const, agentId: GONE }],
  ]);
  const runs = new Map([['r1', { primaryAgentId: PRIMARY, reviewerAgentId: REVIEWER }]]);
  const employees = new Set([PRIMARY, REVIEWER, OTHER]); // GONE intentionally absent
  return {
    stepById: (id) => steps.get(id),
    runById: (id) => runs.get(id),
    employeeExists: (id) => employees.has(id),
    ...over,
  };
}

describe('M0a attribution precedence', () => {
  it('run-less usage (no run) → run_less', () => {
    expect(attributeUsage({ runId: null, runStepId: null }, lookups())).toEqual({ kind: 'run_less', agentId: null });
    // even if a stray step id is present, no run means run-less
    expect(attributeUsage({ runId: null, runStepId: 's-primary' }, lookups()).kind).toBe('run_less');
  });

  it('run present but no step reference → unattributed run usage', () => {
    expect(attributeUsage({ runId: 'r1', runStepId: null }, lookups())).toEqual({ kind: 'unattributed_run', agentId: null });
  });

  it('run present but step does not resolve → unattributed run usage', () => {
    expect(attributeUsage({ runId: 'r1', runStepId: 's-missing' }, lookups()).kind).toBe('unattributed_run');
  });

  it('primary step falls back to run.primaryAgentId', () => {
    expect(attributeUsage({ runId: 'r1', runStepId: 's-primary' }, lookups())).toEqual({ kind: 'employee', agentId: PRIMARY });
  });

  it('review step falls back to run.reviewerAgentId', () => {
    expect(attributeUsage({ runId: 'r1', runStepId: 's-review' }, lookups())).toEqual({ kind: 'employee', agentId: REVIEWER });
  });

  it('revision step falls back to run.primaryAgentId', () => {
    expect(attributeUsage({ runId: 'r1', runStepId: 's-revision' }, lookups())).toEqual({ kind: 'employee', agentId: PRIMARY });
  });

  it('consolidate step with no stored performer → unattributed run usage', () => {
    expect(attributeUsage({ runId: 'r1', runStepId: 's-consolidate' }, lookups()).kind).toBe('unattributed_run');
  });

  it('stored step agent wins over run-level fallback', () => {
    expect(attributeUsage({ runId: 'r1', runStepId: 's-stepagent' }, lookups())).toEqual({ kind: 'employee', agentId: OTHER });
  });

  it('identified employee that no longer resolves → unattributed run usage (never inferred elsewhere)', () => {
    expect(attributeUsage({ runId: 'r1', runStepId: 's-gone' }, lookups()).kind).toBe('unattributed_run');
  });

  it('never infers identity when run itself is unresolved (primary fallback needs the run)', () => {
    const res = attributeUsage({ runId: 'r-missing', runStepId: 's-primary' }, lookups());
    expect(res.kind).toBe('unattributed_run');
  });
});
