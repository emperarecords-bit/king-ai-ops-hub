import { GitHubApiError } from './live-client';

/**
 * Classify a thrown GitHub error at a MUTATION boundary into the two outcomes the executor contract cares about:
 *
 *  - `definite`  — the mutation provably did NOT happen. A 4xx response means GitHub rejected the request before
 *                  applying it (not mergeable, head moved, not found, protected, validation). Safe to report as a
 *                  `failed` outcome with no side effect.
 *  - `ambiguous` — the mutation MAY have happened. A 5xx, a network error, or a timeout (AbortSignal) can post-date
 *                  the write, so the result is unknown. The executor must report `ambiguous` + `reconciliation:
 *                  'required'` and never auto-retry (a blind retry could double-apply).
 *
 * Mirrors the repo's established provider/notification convention (`provider_4xx` don't-retry vs `provider_5xx`/
 * `timeout` ambiguous). A thrown value with no recognizable HTTP status (raw fetch TypeError, TimeoutError) is
 * treated as ambiguous — fail safe, never assume non-execution.
 */
export type GitHubMutationFailureKind = 'definite' | 'ambiguous';

export function classifyGitHubMutationError(err: unknown): GitHubMutationFailureKind {
  const status =
    err instanceof GitHubApiError
      ? err.status
      : err && typeof err === 'object' && typeof (err as { status?: unknown }).status === 'number'
        ? (err as { status: number }).status
        : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500) return 'definite';
  return 'ambiguous';
}
