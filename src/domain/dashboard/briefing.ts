import { type ObjectiveListRow } from '@/domain/objectives/objectives';

/**
 * The dashboard briefing — the chief of staff's read of the business, business-first.
 *
 * This module owns the *judgment*: the health verdict and the single standout, with an
 * explanation that obeys the reasoning contract (HUB-PRODUCT.md). It is a pure function so
 * the judgment is testable and honest — it asserts only what the input data supports, and it
 * labels any causal claim as an inference rather than a fact. The exact health algorithm is
 * deliberately simple and conservative for now; it will evolve from real operation.
 */

export type Mood = 'normal' | 'attention' | 'uncertain';

/** The universal reasoning contract (five dimensions). Depth may vary; the shape does not. */
export interface Reasoning {
  /** Grounded in outcomes. Causal claims are labeled as inference, never asserted as fact. */
  businessImpact: string;
  evidence: string;
  reasoning: string;
  confidence: string;
  whatWouldChange: string;
}

export interface Standout {
  objectiveId: string;
  title: string;
  /** What the Hub can plainly observe — no causal leap. */
  surface: string;
  reasoning: Reasoning;
}

export interface Briefing {
  business: string;
  mood: Mood;
  /** The one-line verdict, spoken as the operating partner. */
  verdict: string;
  standout: Standout | null;
  /** Active objectives moving that are not the standout. */
  advancing: number;
  /** Attention-mood reassurance about the rest of the business, or null. */
  reassurance: string | null;
}

export interface BriefingInput {
  business: string;
  objectives: ObjectiveListRow[];
  pendingApprovals: number;
  /** Failed tasks needing a look. */
  failed: number;
}

/**
 * An active objective is "stalled" — the honest, non-crying-wolf version — when every task
 * under it is finished yet the objective isn't closed: work exists, all of it is done, and
 * nothing is moving it toward completion. Brand-new / task-less objectives are never flagged
 * (that was the old at-risk false alarm).
 */
function isStalled(o: ObjectiveListRow): boolean {
  const p = o.progress;
  return o.status === 'active' && p.percent < 100 && p.tasksTotal > 0 && p.tasksCompleted === p.tasksTotal;
}

export function buildBriefing(input: BriefingInput): Briefing {
  const { business, objectives, pendingApprovals, failed } = input;
  const active = objectives.filter((o) => o.status === 'active');
  const stalled = active.filter(isStalled);
  // listObjectives is ordered by priority asc, so the first stalled item is the top priority.
  const top = stalled[0] ?? null;
  const advancing = active.length - stalled.length;

  let mood: Mood;
  if (active.length === 0) mood = 'uncertain';
  else if (top || failed > 0 || pendingApprovals > 0) mood = 'attention';
  else mood = 'normal';

  let verdict: string;
  if (mood === 'normal') {
    verdict = `${business} is operating normally.`;
  } else if (mood === 'uncertain') {
    verdict = `${business} looks steady — but I can't confidently assess where it stands yet.`;
  } else if (top) {
    verdict = `${business} is healthy — but one thing stands out this morning.`;
  } else if (failed > 0 && pendingApprovals > 0) {
    verdict = `${business} is healthy — but a couple of things need you.`;
  } else if (failed > 0) {
    verdict = `${business} is healthy — but some work needs a look.`;
  } else {
    verdict = `${business} is healthy — a few approvals are waiting on you.`;
  }

  let standout: Standout | null = null;
  if (top) {
    const p = top.progress;
    const dept = top.sponsoringDepartment;
    standout = {
      objectiveId: top.id,
      title: top.title,
      surface: `All ${p.tasksTotal} of its tasks are done, but it isn't closed — nothing is moving it forward now.`,
      reasoning: {
        businessImpact: dept
          ? `Likely, not confirmed: this is ${dept}'s objective — while it sits unfinished, that outcome isn't being reached. I can see it's stalled; I can't measure the downstream effect directly.`
          : `Likely, not confirmed: while this sits unfinished, the outcome it represents isn't being reached. I can see it's stalled; I can't measure the downstream effect directly.`,
        evidence: `${p.tasksCompleted} of ${p.tasksTotal} tasks complete · objective at ${p.percent}% · no task currently in motion.`,
        reasoning: `Of the active objectives, it's the one with finished work and no path to closing — the clearest place attention finishes an outcome.`,
        confidence: `High that it's stalled; low on the size of its downstream impact.`,
        whatWouldChange: `A new task that moves it, or closing the objective, drops it from here.`,
      },
    };
  }

  let reassurance: string | null = null;
  if (mood === 'attention' && advancing > 0) {
    reassurance = `Everything else is healthy: ${advancing} other ${advancing === 1 ? 'objective' : 'objectives'} advancing.`;
  }

  return { business, mood, verdict, standout, advancing, reassurance };
}
