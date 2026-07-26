/**
 * Automation assessment (Execution 2b) — a recurring schedule is *authority to create work*, not
 * one piece of executing work. It gets its own operator-facing state, distinct from the shared
 * execution conditions used by the tasks it generates. An enabled schedule with no current run is
 * NOT "Moving"; a failed generated task does NOT stop or fail the schedule.
 *
 * Pure and testable. State/health are derived from the schedule flag and its *identifiable* recent
 * generated runs — never a generic status. (v1 has no per-schedule budget field, so this never
 * claims one; it reports real spend only.)
 */

export type AutomationState = 'enabled' | 'degraded' | 'paused';

export interface AutomationAssessment {
  /** The automation's own state — never a task condition. */
  state: AutomationState;
  intervention: 'none' | 'watch' | 'required';
  requiredAction: string | null;
  reason: string;
  /** Available actions, valid for the current state (permission-gated at the call site). */
  actions: string[];
}

export function assessAutomation(i: {
  enabled: boolean;
  /** How many of the most recent identifiable generated runs are being considered. */
  recentRuns: number;
  /** How many of those recent generated runs failed. */
  recentFailures: number;
}): AutomationAssessment {
  if (!i.enabled) {
    return {
      state: 'paused',
      intervention: 'none',
      requiredAction: null,
      reason: 'Paused — not producing runs. Prior generated tasks are unaffected.',
      actions: ['Resume'],
    };
  }

  // Enabled. Elevate the *schedule itself* only when its own run history supports it.
  if (i.recentFailures >= 2) {
    return {
      state: 'degraded',
      intervention: 'required',
      requiredAction: 'Pause or inspect recent runs',
      reason: `Enabled — but its ${i.recentFailures} most recent generated runs failed. The schedule is still enabled.`,
      actions: ['Pause', 'Inspect recent runs'],
    };
  }
  if (i.recentFailures === 1) {
    return {
      state: 'enabled',
      intervention: 'watch',
      requiredAction: null,
      reason: 'Enabled — one recent generated run failed. Not yet a pattern.',
      actions: ['Pause', 'Inspect recent runs'],
    };
  }
  return {
    state: 'enabled',
    intervention: 'none',
    requiredAction: null,
    reason: 'Enabled.',
    actions: ['Pause'],
  };
}

export const AUTOMATION_STATE_LABEL: Record<AutomationState, string> = {
  enabled: 'Enabled',
  degraded: 'Degraded',
  paused: 'Paused',
};
