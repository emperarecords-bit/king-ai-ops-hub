import { type ObjectiveStatus, type SuccessCriterion } from '@/types/domain';
import { type Reasoning } from '@/domain/dashboard/briefing';

/**
 * The honest first-version objective assessment (HUB-PRODUCT.md → Objectives).
 *
 * A *semantic model*, not a scoring algorithm. It never produces a percentage: progress is
 * stated as criteria-and-evidence ("2 of 3 conditions met"), momentum is read only from outcome
 * evidence — never task volume — and activity is reported as *effort*, never silently promoted to
 * progress. Where evidence is missing it says so and what's missing. Risk is asserted only from a
 * real signal (none available yet, so v1 never claims "low risk"); confidence appears only when it
 * materially qualifies a claim. Pure and testable.
 */

export type ObjectiveState =
  | 'draft'
  | 'advancing'
  | 'ready-to-close'
  | 'effort-only'
  | 'insufficient'
  | 'completed'
  | 'cancelled';

export interface Assessment {
  state: ObjectiveState;
  /** The Hub's read — one bounded sentence, no forecast, no percentage. */
  headline: string;
  /** Criteria-and-evidence, e.g. "2 of 3 conditions met · 1 waived". Never a percentage. */
  outcomeSummary: string;
  /** Shown only when it materially qualifies the read (incomplete/mixed evidence). */
  confidence: string | null;
  /** Human + AI work, reported together as effort. */
  work: string;
  /** The five-dimension reasoning contract, behind "How I reached this". */
  reasoning: Reasoning | null;
}

export interface AssessInput {
  status: ObjectiveStatus;
  criteria: SuccessCriterion[];
  taskTotal: number;
  workItemTotal: number;
}

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
  kind: 'advancing' | 'ready' | 'effort',
): Reasoning {
  return {
    businessImpact:
      'This objective represents an intended outcome. Progress means the outcome is closer — not that more work was done.',
    evidence: `${summarize(met, waived, total)}. Work recorded: ${taskTotal} AI task(s), ${workItemTotal} Work Item(s).`,
    reasoning:
      kind === 'advancing'
        ? 'At least one success condition has recorded evidence — that is outcome movement, not just completed activity.'
        : kind === 'ready'
          ? 'Every success condition is met or explicitly waived, so the completion gate is satisfied.'
          : 'Completed work is evidence of effort; none of it is yet tied to a satisfied success condition.',
    confidence:
      kind === 'effort'
        ? 'Low — there is no outcome evidence to assess against.'
        : 'Based only on recorded criterion evidence; progress is not inferred from task volume.',
    whatWouldChange:
      'Marking a success condition met (with its evidence), or new outcome evidence arriving, would change this read.',
  };
}

export function assessObjective(input: AssessInput): Assessment {
  const { status, criteria, taskTotal, workItemTotal } = input;
  const met = criteria.filter((c) => c.status === 'met').length;
  const waived = criteria.filter((c) => c.status === 'waived').length;
  const total = criteria.length;
  const activity = taskTotal + workItemTotal;
  const outcomeSummary = summarize(met, waived, total);
  const work = workLine(taskTotal, workItemTotal);

  if (status === 'draft') {
    return {
      state: 'draft',
      headline: 'Not yet active — it needs at least one agreed success condition before it starts.',
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
