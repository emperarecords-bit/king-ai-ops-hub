import {
  type KnowledgeDisclosure,
  type KnowledgeEpistemicBasis,
  type KnowledgeScopeKind,
  type KnowledgeStatus,
  type KnowledgeVerification,
} from '@/types/domain';

/**
 * The ONE shared Knowledge trust assessment. Selection, prompt rendering, and the future Portfolio /
 * Detail all consume this — a record cannot be trusted in inspection, stale in rendering, and freely
 * usable in selection at once. It derives usability from persisted facts (lifecycle, verification,
 * freshness timestamps, scope target lifecycle, disclosure) plus the consumer's access + intended use.
 * It does NOT do relevance — the selector adds consumer-specific relevance on top.
 */

/** How the consumer intends to use the record — different uses tolerate different freshness/dispute. */
export type KnowledgeUseIntent = 'current_operational_fact' | 'historical_analysis' | 'reference' | 'objective_planning';

export type FreshnessState = 'current' | 'review_due' | 'stale' | 'historical' | 'unknown';
export type UseState = 'usable' | 'usable_with_qualification' | 'withheld';

export interface KnowledgeAssessment {
  lifecycle: KnowledgeStatus;
  epistemicBasis: KnowledgeEpistemicBasis;
  verification: KnowledgeVerification;
  freshness: FreshnessState;
  scopeValid: boolean;
  disclosureDecision: 'permitted' | 'withheld';
  useState: UseState;
  /** Machine reasons (for tests and the Portfolio Needs-review lens). */
  reasons: string[];
  /** Bracket-label parts the prompt prepends so the model uses the record responsibly. */
  qualifications: string[];
}

const TERMINAL_TASK = new Set(['completed', 'cancelled']);
const CLOSED_OBJECTIVE = new Set(['completed', 'cancelled']);

const SCOPE_LABEL: Record<KnowledgeScopeKind, string> = { task: 'task scope', objective: 'objective scope', workspace: 'workspace scope' };
const FRESH_LABEL: Record<FreshnessState, string> = { current: 'current', review_due: 'review due', stale: 'stale', historical: 'historical', unknown: 'freshness unknown' };

export function assessKnowledge(i: {
  status: KnowledgeStatus;
  epistemicBasis: KnowledgeEpistemicBasis;
  verification: KnowledgeVerification;
  asOf: Date | null;
  verifiedAt: Date | null;
  reviewAfter: Date | null;
  expiresAt: Date | null;
  scopeKind: KnowledgeScopeKind;
  scopeTaskId: string | null;
  scopeObjectiveId: string | null;
  scopeTaskStatus: string | null;
  scopeObjectiveStatus: string | null;
  disclosure: KnowledgeDisclosure;
  /** Whether an explicit grant permits this restricted item for the current consumer (v1: false). */
  disclosurePermitted: boolean;
  /** Current provenance is broken (a claimed source can't be inspected at its cited version). The
   *  caller computes this from resolution; default false. Only bites for source-dependent records. */
  provenanceBroken?: boolean;
  intendedUse: KnowledgeUseIntent;
  now: Date;
}): KnowledgeAssessment {
  // A record is source-dependent when its trust rests on a source: extracted/summarized/inferred, or
  // an explicit source-supported judgment. Broken provenance only limits reliance on those.
  const sourceDependent =
    i.epistemicBasis === 'extracted' || i.epistemicBasis === 'summarized' || i.epistemicBasis === 'inferred' || i.verification === 'source_supported';
  const provenanceBroken = i.provenanceBroken === true && sourceDependent;
  const reasons: string[] = [];

  // Freshness (deterministic, from explicit timestamps — never from updatedAt).
  const scopeClosed =
    (i.scopeKind === 'task' && i.scopeTaskStatus != null && TERMINAL_TASK.has(i.scopeTaskStatus)) ||
    (i.scopeKind === 'objective' && i.scopeObjectiveStatus != null && CLOSED_OBJECTIVE.has(i.scopeObjectiveStatus));
  // Freshness comes ONLY from explicit validity facts, never the age of a database row, and NEVER
  // from `asOf` alone. `asOf` is when the claim described reality (historical position) — it does not
  // establish continuing validity. Only an explicit validity WINDOW still open — a future `expiresAt`
  // (valid through that instant) or a future `reviewAfter` (validity granted until review) — makes a
  // record "current". A `verifiedAt` records when verification happened, not currency. Instants are
  // compared absolutely (timezone-independent) at the exact boundary (<= now = passed).
  const nowT = i.now.getTime();
  let freshness: FreshnessState;
  if (i.expiresAt && i.expiresAt.getTime() <= nowT) freshness = 'stale';
  else if (scopeClosed) freshness = 'historical';
  else if (i.reviewAfter && i.reviewAfter.getTime() <= nowT) freshness = 'review_due';
  else if ((i.expiresAt && i.expiresAt.getTime() > nowT) || (i.reviewAfter && i.reviewAfter.getTime() > nowT)) freshness = 'current';
  else freshness = 'unknown'; // includes asOf-only: known as of that time, current status not established

  const scopeValid =
    i.scopeKind === 'workspace' || (i.scopeKind === 'task' ? i.scopeTaskId != null : i.scopeObjectiveId != null);

  const disclosureDecision: 'permitted' | 'withheld' =
    i.disclosure === 'restricted' && !i.disclosurePermitted ? 'withheld' : 'permitted';

  // The as-of date is historical position, shown as a qualification — and, when nothing else
  // establishes currency, stated plainly as "current status not established".
  const asOfStr = i.asOf ? `as of ${i.asOf.toISOString().slice(0, 10)}` : null;
  const freshLabel =
    freshness === 'unknown' && asOfStr
      ? `${asOfStr}; current status not established`
      : asOfStr
        ? `${FRESH_LABEL[freshness]} · ${asOfStr}`
        : FRESH_LABEL[freshness];
  const qualifications = [i.epistemicBasis, i.verification, freshLabel, SCOPE_LABEL[i.scopeKind]];

  // Hard gates → withheld (order matters: lifecycle, disclosure, scope validity come first).
  let useState: UseState = 'usable';
  const forCurrentFact = i.intendedUse === 'current_operational_fact';

  if (i.status !== 'active') {
    useState = 'withheld';
    reasons.push(i.status); // draft | archived
  } else if (disclosureDecision === 'withheld') {
    useState = 'withheld';
    reasons.push('restricted_without_grant');
  } else if (!scopeValid) {
    useState = 'withheld';
    reasons.push('invalid_scope');
  } else if (provenanceBroken && forCurrentFact) {
    // A source-dependent claim whose cited evidence can't be inspected is not settled current fact.
    useState = 'withheld';
    reasons.push('broken_provenance');
  } else if (freshness === 'stale' && forCurrentFact) {
    useState = 'withheld';
    reasons.push('expired_for_current_fact');
  } else if (freshness === 'historical' && forCurrentFact) {
    useState = 'withheld';
    reasons.push('scope_closed_for_current_work');
  } else if (i.verification === 'disputed' && forCurrentFact) {
    useState = 'withheld';
    reasons.push('disputed_for_current_fact');
  } else {
    // Soft concerns → usable, but qualified.
    if (provenanceBroken) { useState = 'usable_with_qualification'; reasons.push('broken_provenance'); } // historical/reference use, with a qualification
    if (i.verification === 'disputed') { useState = 'usable_with_qualification'; reasons.push('disputed'); }
    if (freshness === 'stale' || freshness === 'historical') { useState = 'usable_with_qualification'; reasons.push('stale_historical'); }
    if (freshness === 'review_due') { useState = 'usable_with_qualification'; reasons.push('review_due'); }
    if (freshness === 'unknown' || i.verification === 'unverified') { useState = 'usable_with_qualification'; reasons.push('unverified_or_unknown'); }
  }

  return {
    lifecycle: i.status,
    epistemicBasis: i.epistemicBasis,
    verification: i.verification,
    freshness,
    scopeValid,
    disclosureDecision,
    useState,
    reasons,
    qualifications,
  };
}

/** The bracket qualification line the prompt prepends to a supplied record. */
export function qualificationLabel(a: KnowledgeAssessment): string {
  return `[${a.qualifications.join(' · ')}]`;
}
