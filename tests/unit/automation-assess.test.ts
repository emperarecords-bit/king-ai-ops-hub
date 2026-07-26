import { describe, expect, it } from 'vitest';
import { assessAutomation, type AutomationState } from '@/domain/execution/automation';

const EXEC_CONDITIONS = ['planned', 'moving', 'waiting', 'finished', 'stopped', 'unknown'];

describe('assessAutomation — authority is not an execution instance', () => {
  it('an enabled schedule with no failing runs is Enabled — never a Moving task', () => {
    const a = assessAutomation({ enabled: true, recentRuns: 3, recentFailures: 0 });
    expect(a.state).toBe('enabled');
    expect(a.intervention).toBe('none');
    // Its state is an automation state, not one of the execution conditions.
    expect(EXEC_CONDITIONS).not.toContain(a.state as string);
  });

  it('a failed generated run does NOT stop or pause the schedule — it stays enabled/degraded', () => {
    const twoFailed = assessAutomation({ enabled: true, recentRuns: 3, recentFailures: 2 });
    expect(twoFailed.state).toBe('degraded');
    expect(twoFailed.state).not.toBe('paused');
    expect(twoFailed.state).not.toBe('stopped' as AutomationState);
    expect(twoFailed.intervention).toBe('required');
    expect(twoFailed.requiredAction).toMatch(/pause or inspect/i);
    expect(twoFailed.reason).toMatch(/still enabled/i);
  });

  it('one recent failure is a watch, not yet a required intervention', () => {
    const a = assessAutomation({ enabled: true, recentRuns: 3, recentFailures: 1 });
    expect(a.state).toBe('enabled');
    expect(a.intervention).toBe('watch');
  });

  it('a disabled schedule is Paused, and says prior runs are unaffected', () => {
    const a = assessAutomation({ enabled: false, recentRuns: 3, recentFailures: 3 });
    expect(a.state).toBe('paused');
    expect(a.reason).toMatch(/prior generated tasks are unaffected/i);
  });

  it('available actions respect the state', () => {
    expect(assessAutomation({ enabled: false, recentRuns: 0, recentFailures: 0 }).actions).toEqual(['Resume']);
    expect(assessAutomation({ enabled: true, recentRuns: 3, recentFailures: 0 }).actions).toEqual(['Pause']);
    expect(assessAutomation({ enabled: true, recentRuns: 3, recentFailures: 2 }).actions).toContain('Inspect recent runs');
  });
});
