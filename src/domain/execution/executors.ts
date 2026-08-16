import { type ActionType } from '@/types/domain';

/**
 * Action-executor registry (HUB-002, item 7). Action Executors v1: a REAL executor now exists for
 * `git_pr` (./git-pr-executor.ts) — an approved git_pr action can execute through the dispatch
 * choke point when the server explicitly enables it (EXECUTORS_ENABLED). This set is authoritative:
 * an action type absent here can never execute, and the honest "execution unavailable" wording
 * remains for it. Keep this in lockstep with resolveExecutor() in ./dispatch.ts.
 */
const ELIGIBLE_EXECUTOR_ACTION_TYPES: ReadonlySet<ActionType> = new Set<ActionType>(['git_pr', 'org_delegation']);

/** True when a real executor exists for this action type. */
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
