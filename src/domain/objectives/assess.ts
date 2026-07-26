import { type ObjectiveStatus, type SuccessCriterion } from '@/types/domain';
import { type Reasoning } from '@/domain/dashboard/briefing';

/**
 * The honest objective assessment (HUB-PRODUCT.md → Objectives) — the single source of truth
 * for objective judgment across every surface (Dashboard, Objectives list, objective detail).
 *
 * A *semantic model*, not a scoring algorithm. Never a percentage: progress is criteria-and-
 * evidence; momentum is read only from *outcome* evidence (never task volume) and separately from
 * outcome progress — an objective can have real progress yet stale evidence, so momentum reads
 * "unconfirmed"; activity is reported as effort; where evidence is missing it says what's missing.
 * Risk is asserted only from a real signal (none available yet → never "low risk"); confidence
 * appears only when it materially qualifies a claim. Pure and testable.
 */

export type ObjectiveState =
  | 'draft'
  | 'advancing'
  | 'progressed' // outcome progress exists, but evidence too stale to confirm current momentum
  | 'ready-to-close'
  | 'effort-only'
  | 'insufficient'
  | 'completed'
  | 'cancelled';

export interface Assessment {
  state: ObjectiveState;
  headline: string;
  outcomeSummary: string;
  confidence: string | null;
  work: string;
  reasoning: Reasoning | null;
}

export interface AssessInput {
  status: ObjectiveStatus;
  criteria: SuccessCriterion[];
  taskTotal: number;
  workItemTotal: number;
  /** For momentum freshness. Omit to skip staleness (treat any outcome evidence as current). */
  now?: Date;
}

/**
 * Placeholder momentum window. Per HUB-PRODUCT.md there is no universal age threshold — the real
 * answer is the objective's own evidence cadence, which we don't model yet. Until then this is a
 * conservative default and the language always speaks to the evidence *date*, not "N days".
 */
const MOMENTUM_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function plural(n: number, s: string): string {
  return `${n} ${s}${n === 1 ? '' : 's'}`;
}

function summarize(met: number, waived: number, total: number): string {
  if (total === 0) return 'No success conditions defined yet.';
  let s = `${met} of ${plural(total, 'condition')} met`;
  if (waived > 0) s += ` · ${waived} waived`;
  return s;
}

function workLine(taskTotal: number, workItemTotal: number): string {
  if (taskTotal + workItemTotal === 0) return 'No work recorded yet.';
  const parts: string[] = [];
  if (taskTotal > 0) parts.push(plural(taskTotal, 'AI task'));
  if (workItemTotal > 0) parts.push(plural(workItemTotal, 'Work Item'));
  return `${parts.join(' · ')} — effort toward this objective. Their effect on a specific success condition has not been established.`;
}

function reason(
  met: number,
  waived: number,
  total: number,
  taskTotal: number,
  workItemTotal: number,
  kind: 'advancing' | 'progressed' | 'ready' | 'effort',
): Reasoning {
  return {
    businessImpact:
      'This objective represents an intended outcome. Progress means the outcome is closer — not that more work was done.',
    evidence: `${summarize(met, waived, total)}. Work recorded: ${taskTotal} AI task(s), ${workItemTotal} Work Item(s).`,
    reasoning:
      kind === 'advancing'
        ? 'At least one success condition has recent recorded evidence — that is outcome movement, not just completed activity.'
        : kind === 'progressed'
          ? 'Success conditions are met, but the newest outcome evidence is old — enough to establish progress, not enough to judge current momentum.'
          : kind === 'ready'
            ? 'Every success condition is met or explicitly waived, so the completion gate is satisfied.'
            : 'Completed work is evidence of effort; none of it is yet tied to a satisfied success condition.',
    confidence:
      kind === 'effort'
        ? 'Low — there is no outcome evidence to assess against.'
        : kind === 'progressed'
          ? 'Confident on progress; current momentum is unconfirmed because the evidence is stale.'
          : 'Based only on recorded criterion evidence; progress is not inferred from task volume.',
    whatWouldChange:
      'Marking a success condition met (with its evidence), or new outcome evidence arriving, would change this read.',
  };
}

/** Newest verifiedAt among met criteria, or null. */
function latestMetEvidence(criteria: SuccessCriterion[]): string | null {
  let latest: string | null = null;
  for (const c of criteria) {
    if (c.status === 'met' && c.verifiedAt && (latest === null || c.verifiedAt > latest)) {
      latest = c.verifiedAt;
    }
  }
  return latest;
}

export function assessObjective(input: AssessInput): Assessment {
  const { status, criteria, taskTotal, workItemTotal, now } = input;
  const met = criteria.filter((c) => c.status === 'met').length;
  const waived = criteria.filter((c) => c.status === 'waived').length;
  const total = criteria.length;
  const activity = taskTotal + workItemTotal;
  const outcomeSummary = summarize(met, waived, total);
  const work = workLine(taskTotal, workItemTotal);

  if (status === 'draft') {
    return {
      state: 'draft',
      headline:
        total === 0
          ? 'Draft — not yet active. It needs at least one agreed success condition before it starts.'
          : 'Draft — not yet active. Success conditions are defined; activate it when the plan is ready.',
      outcomeSummary,
      confidence: null,
      work,
      reasoning: null,
    };
  }
  if (status === 'cancelled') {
    return {
      state: 'cancelled',
      headline: 'Cancelled — see the closure record for why.',
      outcomeSummary,
      confidence: null,
      work,
      reasoning: null,
    };
  }
  if (status === 'completed') {
    const headline =
      waived > 0
        ? `Completed with ${plural(met, 'condition')} met and ${waived} formally waived.`
        : `Completed — all ${plural(total, 'condition')} met on recorded evidence.`;
    return { state: 'completed', headline, outcomeSummary, confidence: null, work, reasoning: null };
  }

  // active
  const satisfied = met + waived;
  if (total > 0 && satisfied === total) {
    return {
      state: 'ready-to-close',
      headline: waived > 0 ? 'Every condition is met or waived — ready for you to close.' : 'Every condition is met — ready for you to close.',
      outcomeSummary,
      confidence: null,
      work,
      reasoning: reason(met, waived, total, taskTotal, workItemTotal, 'ready'),
    };
  }
  if (met > 0) {
    const latest = latestMetEvidence(criteria);
    const stale = now != null && latest != null && now.getTime() - new Date(latest).getTime() > MOMENTUM_WINDOW_MS;
    if (stale) {
      return {
        state: 'progressed',
        headline: `${met} of ${plural(total, 'condition')} met, but the most recent outcome evidence is from ${latest!.slice(0, 10)} — not enough recent change to assess current momentum confidently.`,
        outcomeSummary,
        confidence: 'Confident on progress; current momentum is unconfirmed — the evidence is stale.',
        work,
        reasoning: reason(met, waived, total, taskTotal, workItemTotal, 'progressed'),
      };
    }
    return {
      state: 'advancing',
      headline: `Advancing on evidence — ${met} of ${plural(total, 'condition')} met.`,
      outcomeSummary,
      confidence: null,
      work,
      reasoning: reason(met, waived, total, taskTotal, workItemTotal, 'advancing'),
    };
  }
  if (activity > 0) {
    return {
      state: 'effort-only',
      headline:
        'I can confirm substantial effort, but not outcome progress — none of the success conditions have evidence yet, so there isn’t enough to assess momentum confidently.',
      outcomeSummary,
      confidence: 'Low — there is no outcome evidence to assess against.',
      work,
      reasoning: reason(met, waived, total, taskTotal, workItemTotal, 'effort'),
    };
  }
  return {
    state: 'insufficient',
    headline: 'There isn’t enough current evidence to assess momentum yet — no outcome evidence and no work recorded.',
    outcomeSummary,
    confidence: 'Insufficient evidence to judge.',
    work,
    reasoning: null,
  };
}

/**
 * Provenance wording for a criterion status. Human attestation is "Confirmed by …" — the person
 * asserted it; the Hub does not claim to have independently verified it. Only a linked/usage/
 * integration source earns "Verified from …". Freshness is the evidence date when known.
 */
export function describeEvidence(c: SuccessCriterion, verifierName?: string | null): string | null {
  if (c.status === 'unmet') return null;
  const on = c.verifiedAt ? ` on ${c.verifiedAt.slice(0, 10)}` : '';
  const who = verifierName ? ` by ${verifierName}` : '';
  if (c.status === 'waived') return `Waived${who}${on}`;
  if (c.source === 'manual') return `Confirmed${who}${on}`; // human attestation, not independent verification
  if (c.source === 'usage') return `Verified from usage data${on}`;
  return `Verified from ${c.source.replace('integration:', '')}${on}`;
}
