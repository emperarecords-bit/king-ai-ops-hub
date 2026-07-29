import { type ActionType } from '@/types/domain';

/**
 * Action-executor registry (HUB-002, item 7). Phase 3 — `executeApprovedAction()` — is NOT built: no
 * executor exists for ANY action type yet, so an authorized action can never auto-execute. This is a
 * POSITIVE determination, not an absence of information: the set below is authoritative and empty. Only
 * when a real executor lands do we register its action type here — and only then does the honest
 * "execution unavailable" wording drop for that type.
 */
const ELIGIBLE_EXECUTOR_ACTION_TYPES: ReadonlySet<ActionType> = new Set<ActionType>(); // intentionally empty

/** True when a real executor exists for this action type (none do today). */
export function hasEligibleExecutor(actionType: ActionType): boolean {
  return ELIGIBLE_EXECUTOR_ACTION_TYPES.has(actionType);
}

/**
 * Positive determination that NONE of the given authorized actions can execute — every one lacks an
 * eligible executor. Drives the "execution unavailable" qualifier: we say it only because the backend
 * has confirmed there is no executor, never merely because execution hasn't happened yet.
 */
export function noEligibleExecutor(actionTypes: readonly ActionType[]): boolean {
  return actionTypes.length > 0 && actionTypes.every((t) => !hasEligibleExecutor(t));
}
