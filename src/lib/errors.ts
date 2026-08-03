/**
 * Application error taxonomy. Every error the app throws on purpose extends
 * AppError so boundaries can distinguish "expected, render nicely" from
 * "unexpected, log and 500".
 */

export type AppErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'validation'
  | 'tenant_violation'
  | 'budget_exceeded'
  | 'rate_limited'
  | 'run_invalid_state'
  | 'provider_failure'
  | 'conflict'
  | 'assignment_required';

export class AppError extends Error {
  readonly code: AppErrorCode;
  /** Safe to show to the end user verbatim. */
  readonly publicMessage: string;

  constructor(code: AppErrorCode, publicMessage: string, internalMessage?: string) {
    super(internalMessage ?? publicMessage);
    this.name = 'AppError';
    this.code = code;
    this.publicMessage = publicMessage;
  }
}

export class UnauthenticatedError extends AppError {
  constructor() {
    super('unauthenticated', 'You must be signed in.');
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends AppError {
  constructor(detail?: string) {
    super('forbidden', 'You do not have access to this resource.', detail);
    this.name = 'ForbiddenError';
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super('not_found', `${what} not found.`);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends AppError {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super('validation', 'Invalid input.', `Validation failed: ${issues.join('; ')}`);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/**
 * Raised when data crossing a tenant boundary is detected after the fact.
 * This is a fire-alarm error: it means a lower-level control failed. It is
 * always audited and never swallowed.
 */
export class TenantViolationError extends AppError {
  constructor(detail: string) {
    super('tenant_violation', 'A data isolation error occurred.', detail);
    this.name = 'TenantViolationError';
  }
}

export class BudgetExceededError extends AppError {
  constructor(limitMicros: bigint, spentMicros: bigint) {
    super(
      'budget_exceeded',
      'This project has reached its spending limit for the current period.',
      `Budget exceeded: limit=${limitMicros} spent=${spentMicros}`,
    );
    this.name = 'BudgetExceededError';
  }
}

export class RateLimitedError extends AppError {
  constructor() {
    super('rate_limited', 'Too many runs started recently. Try again shortly.');
    this.name = 'RateLimitedError';
  }
}

/** The request is well-formed but the entity's current state forbids it. */
export class ConflictError extends AppError {
  constructor(publicMessage: string) {
    super('conflict', publicMessage);
    this.name = 'ConflictError';
  }
}

/**
 * P1a agent pinning — a run cannot start because the task/schedule has no valid pinned employee: either
 * no employee was ever assigned (legacy row), or the pinned employee is no longer an enabled agent of the
 * required role in this workspace. The runner FAILS CLOSED here (it never substitutes a provider-derived
 * agent), so this always means "assign an enabled employee before running", never "we picked one for you".
 */
export class AssignmentRequiredError extends AppError {
  /** Machine-readable cause, for audit detail — never the private prompt/config. */
  readonly reason?: string;
  constructor(reason?: string) {
    super(
      'assignment_required',
      'This task has no assigned employee. Assign an enabled employee before running it.',
      reason ? `Assignment required: ${reason}` : undefined,
    );
    this.name = 'AssignmentRequiredError';
    this.reason = reason;
  }
}

/** A user-facing rendering of any thrown value, with no internals leaked. */
export function toPublicMessage(err: unknown): string {
  if (err instanceof AppError) return err.publicMessage;
  return 'Something went wrong. The error has been logged.';
}
