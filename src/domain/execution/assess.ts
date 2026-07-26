import { type TaskStatus, type WorkItemCondition } from '@/types/domain';

/**
 * The execution translator (HUB-PRODUCT.md → Execution) — one operational language over two
 * engines. It maps each engine's native state into three *separate* dimensions the operator
 * shares: the execution **condition** (what the work is doing), the **intervention** level (whether
 * the operator must act) plus the specific required action, and the native **reason** (why). It
 * also carries the **source** (system-observed vs human-reported) and a per-claim confidence.
 *
 * Pure and testable. It never recombines the dimensions: an approval-gated task stays *Waiting*
 * with *Required* intervention; a legitimately-waiting human item stays *Waiting* with *no*
 * intervention. The layout must preserve this separation.
 */

export type ExecCondition = 'planned' | 'moving' | 'waiting' | 'finished' | 'stopped' | 'unknown';
export type InterventionLevel = 'none' | 'watch' | 'required';
export type ExecSource = 'system-observed' | 'human-reported' | 'unknown';

export interface ExecutionAssessment {
  condition: ExecCondition;
  intervention: InterventionLevel;
  /** Present only when intervention is 'required'. What involvement means. */
  requiredAction: string | null;
  reason: string;
  source: ExecSource;
  /** Only when it materially qualifies the read (e.g. a stale human report). */
  confidence: string | null;
}

/** Placeholder staleness window for a human "moving" report (see HUB-PRODUCT: no universal age). */
const MOVING_STALE_MS = 9 * 24 * 60 * 60 * 1000;

function isTerminal(c: ExecCondition): boolean {
  return c === 'finished' || c === 'stopped';
}

export function assessWorkItem(i: {
  condition: WorkItemCondition | null;
  waitingOn: string | null;
  ownerAgentId: string | null;
  updatedAt: Date;
  now: Date;
}): ExecutionAssessment {
  // Unknown: the record doesn't establish the condition. A DB default is not a real state.
  if (i.condition === null) {
    return {
      condition: 'unknown',
      intervention: 'required',
      requiredAction: 'Confirm the current condition',
      reason: 'Its condition was never established — imported before conditions existed.',
      source: 'unknown',
      confidence: 'None recorded — needs review.',
    };
  }

  const condition: ExecCondition = i.condition;
  let intervention: InterventionLevel = 'none';
  let requiredAction: string | null = null;
  let confidence: string | null = null;
  let reason: string;

  if (condition === 'waiting') {
    reason = i.waitingOn ? `Waiting on ${i.waitingOn}.` : 'Waiting.';
  } else if (condition === 'moving') {
    const stale = i.now.getTime() - i.updatedAt.getTime() > MOVING_STALE_MS;
    if (stale) {
      const days = Math.floor((i.now.getTime() - i.updatedAt.getTime()) / (24 * 60 * 60 * 1000));
      intervention = 'watch';
      reason = `Reported Moving, but no update has been recorded in ${days} days.`;
      confidence = 'Limited — human execution isn’t directly observable, so this may be out of date.';
    } else {
      reason = 'Moving.';
    }
  } else if (condition === 'planned') {
    reason = 'Accepted, not yet underway.';
  } else if (condition === 'finished') {
    reason = 'Finished.';
  } else {
    reason = 'Stopped.';
  }

  // Unowned consequential work always requires an owner — without losing its condition.
  if (!i.ownerAgentId && !isTerminal(condition)) {
    intervention = 'required';
    requiredAction = 'Assign an accountable owner';
    reason = `${reason} No accountable owner is recorded.`;
  }

  return { condition, intervention, requiredAction, reason, source: 'human-reported', confidence };
}

export function assessTask(i: {
  status: TaskStatus;
  ownerAgentId: string | null;
  /**
   * The task's own work finished, but it holds an authorized action the Hub has NOT executed (no
   * executor yet). The read must say so — never imply the external action happened. See
   * `tasksWithAuthorizedUnexecutedActions`.
   */
  authorizedUnexecuted?: boolean;
}): ExecutionAssessment {
  let condition: ExecCondition;
  let intervention: InterventionLevel = 'none';
  let requiredAction: string | null = null;
  let reason: string;

  switch (i.status) {
    case 'pending':
      condition = 'planned';
      reason = 'Accepted, not yet run.';
      break;
    case 'running':
      condition = 'moving';
      reason = 'Running.';
      break;
    case 'awaiting_approval':
      condition = 'waiting';
      intervention = 'required';
      requiredAction = 'Authorize or refuse';
      reason = 'Holding for authorization of a proposed action.';
      break;
    case 'completed':
      condition = 'finished';
      // Truthful split: the AI work finished, but an authorized action may still be unexecuted.
      reason = i.authorizedUnexecuted
        ? 'AI work finished; a proposed action is authorized but not yet executed.'
        : 'Completed.';
      break;
    case 'failed':
      condition = 'waiting';
      intervention = 'required';
      requiredAction = 'Retry or cancel';
      reason = 'Failed; holding for a retry decision.';
      break;
    default:
      condition = 'stopped';
      reason = 'Cancelled.';
      break;
  }

  // Unowned non-terminal task needs an owner, unless a more specific required action already stands.
  if (!i.ownerAgentId && !isTerminal(condition) && intervention !== 'required') {
    intervention = 'required';
    requiredAction = 'Assign an accountable owner';
    reason = `${reason} No accountable owner is recorded.`;
  }

  return { condition, intervention, requiredAction, reason, source: 'system-observed', confidence: null };
}

/** Ordering for the condition-led Active Execution view. Terminal states go to Recent. */
export const ACTIVE_CONDITION_ORDER: ExecCondition[] = ['moving', 'waiting', 'planned', 'unknown'];
export const CONDITION_LABEL: Record<ExecCondition, string> = {
  planned: 'Planned',
  moving: 'Moving',
  waiting: 'Waiting',
  finished: 'Finished',
  stopped: 'Stopped',
  unknown: 'Unknown',
};
