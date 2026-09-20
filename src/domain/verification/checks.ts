/**
 * Verify the REQUIRED checks (VER-002).
 *
 * The contract's `requiredChecks` are declared before results arrive. Every one
 * must be present AND `passed`. A missing, skipped, cancelled, errored, or failed
 * required check blocks verification — exit 0 from one command is not enough.
 *
 * The scope statement is deliberately narrow: "these checks passed for this code
 * version," never "the product is secure or launch-ready."
 */
import type { CheckEvaluation, CheckResult } from './ingest-types';

export function evaluateChecks(
  requiredChecks: readonly string[],
  submitted: readonly CheckResult[],
  commitSha: string,
): CheckEvaluation {
  const byName = new Map(submitted.map((c) => [c.name, c]));
  const byCheck = requiredChecks.map((name) => {
    const c = byName.get(name);
    return { name, status: c ? c.status : ('missing' as const) };
  });
  const failing = byCheck.filter((c) => c.status !== 'passed');
  return {
    allRequiredPassed: requiredChecks.length > 0 && failing.length === 0,
    byCheck,
    failing,
    scope:
      requiredChecks.length === 0
        ? 'No required checks were declared for this contract; nothing is verified.'
        : `Scope: the ${requiredChecks.length} required check(s) passed for commit ${commitSha}. This is not a claim that the product is secure or launch-ready.`,
  };
}
