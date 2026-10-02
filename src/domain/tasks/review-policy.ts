import type { ReviewMode } from '@/types/domain';

/**
 * Answer-routing Phase 1 — the review-required policy and mode derivation.
 *
 * This is the enforcement spine: whether a run must be reviewed is decided HERE, server-side, from persisted
 * task state only — never from a browser- or model-supplied value. A Quick request can be HONORED only when
 * review is not required; otherwise it is FORCED to Reviewed. The default is conservative (review required),
 * and any failure to evaluate the policy fails safe to "required".
 *
 * Phase 1 keeps the policy deliberately small: review is required unless a task is EXPLICITLY exempt via a
 * server-set flag (`tasks.quick_exempt`). Future phases can widen the inputs (per-workspace / per-task-type
 * settings) without changing callers.
 */

/** The persisted task facts the policy reads. Intentionally minimal and all server-owned. */
export interface ReviewRequirementInput {
  /** `tasks.quick_exempt` — a SERVER-SET exemption. Null/undefined ⇒ not exempt ⇒ review required. */
  readonly quickExempt?: boolean | null;
}

export interface ReviewRequirement {
  readonly required: boolean;
  /** Machine-readable reason, persisted on the run for the decision trail. */
  readonly reason: string;
}

/**
 * The raw policy. Conservative by construction: required unless the task is explicitly exempt.
 * Pure and total — it does not throw on the documented inputs; `evaluateReviewRequirementSafe` wraps it so
 * that even an unexpected throw (e.g. a getter that faults) fails safe to "required".
 */
export function resolveReviewRequirement(input: ReviewRequirementInput): ReviewRequirement {
  if (input.quickExempt === true) {
    return { required: false, reason: 'task_explicitly_exempt' };
  }
  return { required: true, reason: 'default_required' };
}

/**
 * Fail-safe wrapper used at execution. If reading/evaluating the policy throws for ANY reason, review is
 * REQUIRED (`policy_eval_error`) — a policy that cannot be read can never waive a required review.
 */
export function evaluateReviewRequirementSafe(input: ReviewRequirementInput): ReviewRequirement {
  try {
    return resolveReviewRequirement(input);
  } catch {
    return { required: true, reason: 'policy_eval_error' };
  }
}

export interface ReviewPlanInput {
  /** The task's requested intent: `tasks.review_enabled` (true ⇒ Reviewed requested, false ⇒ Quick). */
  readonly reviewRequested: boolean;
  /** `tasks.quick_exempt`, forwarded to the policy. */
  readonly quickExempt?: boolean | null;
}

export interface ReviewPlan {
  readonly requestedMode: ReviewMode;
  readonly effectiveMode: ReviewMode;
  readonly required: boolean;
  readonly reason: string;
  /** True iff a Quick request was overridden to Reviewed because review was required. */
  readonly forced: boolean;
}

/**
 * Derive the full mode plan for a run, server-side. The EFFECTIVE mode is `reviewed` whenever review is
 * requested OR required; `quick` only when a Quick request meets a not-required policy. A forced override is
 * recorded explicitly so it is representable on the run alongside the actual outcome.
 */
export function deriveReviewPlan(input: ReviewPlanInput): ReviewPlan {
  const requestedMode: ReviewMode = input.reviewRequested ? 'reviewed' : 'quick';
  const { required, reason } = evaluateReviewRequirementSafe({ quickExempt: input.quickExempt });
  const effectiveReviewEnabled = input.reviewRequested || required;
  const effectiveMode: ReviewMode = effectiveReviewEnabled ? 'reviewed' : 'quick';
  const forced = !input.reviewRequested && required;
  return { requestedMode, effectiveMode, required, reason, forced };
}
