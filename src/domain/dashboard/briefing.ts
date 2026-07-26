import { type ObjectiveListRow } from '@/domain/objectives/objectives';
import { assessObjective, type ObjectiveState } from '@/domain/objectives/assess';

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
  /** For momentum freshness in the shared objective assessment. */
  now?: Date;
}

/**
 * Objective judgment comes from the SAME model as the Objectives area (assess.ts) — the operating
 * partner cannot reach incompatible conclusions from the same evidence. The Dashboard shows a
 * concise attention read; Objectives shows the full assessment; the underlying state is identical.
 * The Dashboard flags an objective whose read is "effort-only" (busy but no outcome evidence) or
 * "progressed" (real progress gone stale) — the kinds that hide behind a busy task list.
 */
function needsAttention(state: ObjectiveState): boolean {
  return state === 'effort-only' || state === 'progressed';
}

export function buildBriefing(input: BriefingInput): Briefing {
  const { business, objectives, pendingApprovals, failed, now } = input;
  const active = objectives.filter((o) => o.status === 'active');
  const assessed = active.map((o) => ({
    o,
    a: assessObjective({
      status: o.status,
      criteria: o.successCriteria,
      taskTotal: o.progress.tasksTotal,
      workItemTotal: o.workItemTotal,
      now,
    }),
  }));
  // listObjectives is priority-ordered, so the first flagged objective is the top priority.
  const top = assessed.find((x) => needsAttention(x.a.state)) ?? null;
  const advancing = assessed.filter((x) => x.a.state === 'advancing' || x.a.state === 'ready-to-close').length;

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

  // The standout reuses the shared assessment verbatim — same read, concise depth.
  const standout: Standout | null =
    top && top.a.reasoning
      ? { objectiveId: top.o.id, title: top.o.title, surface: top.a.headline, reasoning: top.a.reasoning }
      : null;

  const reassurance =
    mood === 'attention' && advancing > 0
      ? `Everything else is healthy: ${advancing} other ${advancing === 1 ? 'objective' : 'objectives'} advancing on evidence.`
      : null;

  return { business, mood, verdict, standout, advancing, reassurance };
}
