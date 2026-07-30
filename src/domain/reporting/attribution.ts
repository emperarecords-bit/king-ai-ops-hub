import { type StepKind } from '@/types/domain';

/**
 * M0a usage ATTRIBUTION — pure precedence resolver (read-only reporting only). Given one recorded usage row
 * and lookups for its step/run/roster, decide which reporting bucket it belongs to. It NEVER infers an
 * employee from provider, model, title, or role — only from stored step/run evidence (M0a §2).
 *
 * Every in-window project usage row maps to EXACTLY ONE bucket, so summing cost by bucket reconciles to the
 * recorded total exactly:
 *   employee-attributed + unattributed-run + run-less = Σ recorded cost_micros.
 */

export type UsageAttributionKind = 'employee' | 'unattributed_run' | 'run_less';

export interface UsageForAttribution {
  readonly runId: string | null;
  readonly runStepId: string | null;
}

export interface StepInfo {
  readonly kind: StepKind;
  readonly agentId: string | null;
}

export interface RunInfo {
  readonly primaryAgentId: string | null;
  readonly reviewerAgentId: string | null;
}

export interface AttributionLookups {
  /** Resolve a run-step id to its stored kind + performer, or undefined if it does not resolve. */
  readonly stepById: (id: string) => StepInfo | undefined;
  /** Resolve a run id to its primary/reviewer, or undefined if it does not resolve. */
  readonly runById: (id: string) => RunInfo | undefined;
  /** True iff the agent id is an employee in THIS project (roster membership, incl. disabled). */
  readonly employeeExists: (agentId: string) => boolean;
}

export interface AttributionResult {
  readonly kind: UsageAttributionKind;
  /** The credited employee id when kind === 'employee'; otherwise null. */
  readonly agentId: string | null;
}

/**
 * Attribution precedence (M0a §2), in order:
 *   1. Usage without a run                       → run-less.
 *   2. Usage with a run but no resolvable step   → unattributed run usage.
 *   3. Stored `run_steps.agent_id` present       → that employee (if it resolves in-project).
 *   4. Step agent null, fall back by step kind:
 *        primary/revision → run.primaryAgentId;  review → run.reviewerAgentId;  consolidate → none.
 *   5. Identified employee no longer resolves    → unattributed run usage.
 * Never infers identity from provider/model/title/role.
 */
export function attributeUsage(u: UsageForAttribution, lookups: AttributionLookups): AttributionResult {
  // (1) Run-less usage — embeddings/ingestion/extraction with no run linkage.
  if (u.runId == null) return { kind: 'run_less', agentId: null };

  // (2) Run-linked usage whose step reference is missing or does not resolve → unattributed run usage.
  if (u.runStepId == null) return { kind: 'unattributed_run', agentId: null };
  const step = lookups.stepById(u.runStepId);
  if (!step) return { kind: 'unattributed_run', agentId: null };

  const run = lookups.runById(u.runId);

  // (3) Stored step performer wins over run-level fallback.
  let candidate: string | null = step.agentId;

  // (4) Step performer absent → fall back by kind using run-level fields.
  if (candidate == null && run) {
    if (step.kind === 'primary' || step.kind === 'revision') candidate = run.primaryAgentId;
    else if (step.kind === 'review') candidate = run.reviewerAgentId;
    else candidate = null; // consolidate (or unknown) → unattributed unless a step performer was stored
  }

  // (5) Credit only a candidate that resolves to a current in-project employee; else unattributed run usage.
  if (candidate != null && lookups.employeeExists(candidate)) {
    return { kind: 'employee', agentId: candidate };
  }
  return { kind: 'unattributed_run', agentId: null };
}
