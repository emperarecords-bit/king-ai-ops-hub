/**
 * Verify the REQUIRED checks (VER-002).
 *
 * The contract's `requiredChecks` are declared before results arrive. A required
 * check counts only when its status is `passed` AND its exit code is 0 AND it
 * carries real execution metadata (command + exit code + start/finish). Missing,
 * skipped, cancelled, errored, or failed required checks block verification.
 *
 * Structural defects make the whole submission invalid (rejected upstream):
 *   - duplicate check names,
 *   - contradictory results (status `passed` with a non-zero exit, or a run
 *     status with a zero exit / no exit),
 *   - a run status (`passed`/`failed`/`errored`) missing execution metadata.
 *
 * The scope statement reflects the ACTUAL outcome — a failed check is never
 * described as passed — and never overclaims security or launch-readiness.
 */
import type { CheckEvaluation, CheckResult } from './ingest-types';

const RAN_STATUSES = new Set(['passed', 'failed', 'errored']);

function hasExecutionMetadata(c: CheckResult): boolean {
  return c.command != null && c.exitCode != null && c.startedAt != null && c.finishedAt != null;
}

/** A required check is satisfied only with consistent passed status AND exit 0 AND metadata. */
function isSatisfied(c: CheckResult | undefined): boolean {
  return !!c && c.status === 'passed' && c.exitCode === 0 && hasExecutionMetadata(c);
}

export function evaluateChecks(
  requiredChecks: readonly string[],
  submitted: readonly CheckResult[],
  commitSha: string,
): CheckEvaluation {
  const problems: string[] = [];

  // Duplicate check names.
  const seen = new Set<string>();
  for (const c of submitted) {
    if (seen.has(c.name)) problems.push(`Duplicate check name '${c.name}'.`);
    seen.add(c.name);
  }

  // Contradictions + required execution metadata for any check that claims to have run.
  for (const c of submitted) {
    if (!RAN_STATUSES.has(c.status)) continue;
    if (!hasExecutionMetadata(c)) {
      problems.push(`Check '${c.name}' claims status '${c.status}' but is missing execution metadata (command/exitCode/timestamps).`);
    }
    if (c.status === 'passed' && c.exitCode !== 0) {
      problems.push(`Check '${c.name}' is contradictory: status 'passed' with exit code ${c.exitCode ?? 'null'}.`);
    }
    if ((c.status === 'failed' || c.status === 'errored') && c.exitCode === 0) {
      problems.push(`Check '${c.name}' is contradictory: status '${c.status}' with exit code 0.`);
    }
  }

  const byName = new Map(submitted.map((c) => [c.name, c]));
  const byCheck = requiredChecks.map((name) => {
    const c = byName.get(name);
    return { name, status: c ? c.status : ('missing' as const) };
  });
  const failing = requiredChecks
    .filter((name) => !isSatisfied(byName.get(name)))
    .map((name) => ({ name, status: byName.get(name)?.status ?? ('missing' as const) }));

  const allRequiredPassed = problems.length === 0 && requiredChecks.length > 0 && failing.length === 0;

  let scope: string;
  if (requiredChecks.length === 0) {
    scope = 'No required checks were declared for this contract; nothing is verified.';
  } else if (allRequiredPassed) {
    scope = `Scope: the ${requiredChecks.length} required check(s) passed (status=passed AND exit 0) for commit ${commitSha}. This is not a claim that the product is secure or launch-ready.`;
  } else {
    const detail = problems.length ? `structural problems (${problems.length})` : failing.map((f) => `${f.name}=${f.status}`).join(', ');
    scope = `Scope: verification did NOT pass for commit ${commitSha}. Unsatisfied: ${detail}.`;
  }

  return { allRequiredPassed, byCheck, failing, problems, scope };
}
