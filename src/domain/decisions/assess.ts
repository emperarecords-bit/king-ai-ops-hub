import { type DecisionApplicability, type DecisionScope, type DecisionStatus } from '@/types/domain';

/**
 * The ONE shared decision-state assessment. The Portfolio, the Decision Detail, and the Decision
 * Memory selector must all agree on whether a decision is active guidance — they consume this same
 * pure function. The selector may add run-specific relevance on top, but the base activity decision
 * lives here, so a decision can never be "active in the Portfolio, inactive in Detail, and eligible
 * for memory" at once.
 */

export type MemoryRole = 'record' | 'guidance';
export type GuidanceState = 'active' | 'inactive' | 'not_guidance';
export type InactiveReason =
  | 'not_accepted'
  | 'record_only'
  | 'expired'
  | 'task_closed'
  | 'objective_closed'
  | 'invalid_scope'
  | 'retired'
  | 'superseded'
  | 'rejected';

/** Actions the operator may take now — the page maps these to controls. */
export type DecisionAction = 'accept_record' | 'accept_guidance' | 'refuse' | 'retire' | 'supersede';

export interface DecisionAssessment {
  recordStatus: DecisionStatus;
  memoryRole: MemoryRole;
  guidanceState: GuidanceState;
  /** Set whenever guidanceState !== 'active'. */
  inactiveReason: InactiveReason | null;
  isActiveGuidance: boolean;
  /** Belongs in the Historical group: a terminal status, or accepted guidance made inactive by
   *  expiry / scope closure (still a valid accepted record, just no longer active). */
  historical: boolean;
  actions: DecisionAction[];
}

const TERMINAL_TASK = new Set(['completed', 'cancelled']);
const CLOSED_OBJECTIVE = new Set(['completed', 'cancelled']);

export function assessDecision(i: {
  status: DecisionStatus;
  applicability: DecisionApplicability;
  scope: DecisionScope;
  scopeTaskId: string | null;
  scopeObjectiveId: string | null;
  scopeTaskStatus: string | null;
  scopeObjectiveStatus: string | null;
  effectiveUntil: Date | null;
  now: Date;
}): DecisionAssessment {
  const memoryRole: MemoryRole = i.applicability === 'guidance' ? 'guidance' : 'record';

  // Terminal record statuses — historical, no guidance.
  if (i.status === 'rejected' || i.status === 'superseded' || i.status === 'retired') {
    return {
      recordStatus: i.status,
      memoryRole,
      guidanceState: 'not_guidance',
      inactiveReason: i.status,
      isActiveGuidance: false,
      historical: true,
      actions: [],
    };
  }

  // Proposed — awaiting judgment; not yet guidance.
  if (i.status === 'proposed') {
    return {
      recordStatus: 'proposed',
      memoryRole,
      guidanceState: 'inactive',
      inactiveReason: 'not_accepted',
      isActiveGuidance: false,
      historical: false,
      actions: ['accept_record', 'accept_guidance', 'refuse'],
    };
  }

  // Accepted record-only — a legitimate current record, never active guidance.
  if (i.applicability !== 'guidance') {
    return {
      recordStatus: 'accepted',
      memoryRole: 'record',
      guidanceState: 'not_guidance',
      inactiveReason: 'record_only',
      isActiveGuidance: false,
      historical: false,
      actions: ['supersede'],
    };
  }

  // Accepted guidance — determine active vs inactive from scope target + validity.
  let inactiveReason: InactiveReason | null = null;
  if (i.scope === 'task' && !i.scopeTaskId) inactiveReason = 'invalid_scope';
  else if (i.scope === 'objective' && !i.scopeObjectiveId) inactiveReason = 'invalid_scope';
  else if (i.effectiveUntil && i.effectiveUntil.getTime() <= i.now.getTime()) inactiveReason = 'expired';
  else if (i.scope === 'task' && i.scopeTaskStatus && TERMINAL_TASK.has(i.scopeTaskStatus)) inactiveReason = 'task_closed';
  else if (i.scope === 'objective' && i.scopeObjectiveStatus && CLOSED_OBJECTIVE.has(i.scopeObjectiveStatus)) inactiveReason = 'objective_closed';

  const active = inactiveReason === null;
  return {
    recordStatus: 'accepted',
    memoryRole: 'guidance',
    guidanceState: active ? 'active' : 'inactive',
    inactiveReason,
    isActiveGuidance: active,
    // Inactive-by-expiry/scope-closure is a historical (but still accepted) fact; invalid_scope is a
    // defect surfaced in the Needs-review lens, not archived as history.
    historical: !active && inactiveReason !== 'invalid_scope',
    actions: active ? ['retire', 'supersede'] : ['retire', 'supersede'],
  };
}

export const INACTIVE_LABEL: Record<InactiveReason, string> = {
  not_accepted: 'awaiting review',
  record_only: 'record only — not active guidance',
  expired: 'expired',
  task_closed: 'inactive — its task has closed',
  objective_closed: 'inactive — its objective has closed',
  invalid_scope: 'invalid scope — missing target',
  retired: 'retired',
  superseded: 'superseded',
  rejected: 'refused',
};
