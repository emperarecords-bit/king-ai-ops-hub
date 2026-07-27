import {
  type KnowledgeDisclosure,
  type KnowledgeEpistemicBasis,
  type KnowledgeScopeKind,
  type KnowledgeStatus,
  type KnowledgeVerification,
} from '@/types/domain';
import { type FreshnessState, type KnowledgeAssessment, type UseState } from '@/domain/knowledge/assess';
import { type KnowledgeProvenanceAssessment } from '@/domain/knowledge/knowledge';

/**
 * The operating-partner CONVERSATION — the voice of the trust model, not new trust logic. It translates
 * the already-computed assessments (assessKnowledge / assessKnowledgeProvenance / disclosure decision /
 * applications) into accurate, proportionate language. Two layers:
 *
 *   Layer 1 — describeKnowledgeForConversation(): a PURE structured descriptor. It makes ALL eleven
 *   reasoning answers available; it invents no confidence, re-resolves nothing, infers no Decision
 *   relationship, and calls an application "supplied", never "used" or "influenced".
 *
 *   Layer 2 — renderers per audience + depth. The AI-consumer renderer emits NOTHING for a record the
 *   consumer may not receive (not even that it exists) — denial is checked before any content is read,
 *   so denied content is absent, not redacted after the fact.
 *
 * The eleven answers are AVAILABLE, not mandatory: a renderer shows only what the consequence, the
 * uncertainty, and the operator's question warrant.
 */

export type KnowledgeConversationCategory =
  | 'restricted_withheld'
  | 'ai_extracted_draft'
  | 'disputed'
  | 'stale_historical'
  | 'review_due'
  | 'superseded_correction'
  | 'source_supported'
  | 'document_summary'
  | 'inference'
  | 'human_assertion'
  | 'observation'
  | 'withheld_other';

export interface ConversationSourceEvidence {
  label: string;
  versionHash: string | null;
  outcome: string;
  relied: boolean;
}

export type OperatorVisibility = 'full' | 'metadata_only' | 'withholding_only' | 'none';

export interface KnowledgeConversationDescriptor {
  /** Null when the viewer may not see the record's content (e.g. a restricted record + unauthorized
   *  operator). The sensitive fields are ABSENT here, not stripped by a downstream renderer. */
  claim: { title: string; body: string } | null;
  /** 'single' when the caller guarantees one bounded claim; 'possibly_multiple' otherwise (heuristic —
   *  a conversational verdict must NOT imply uniform trust across claims the model has not separated). */
  claimGranularity: 'single' | 'possibly_multiple';
  category: KnowledgeConversationCategory;
  formation: { epistemicBasis: KnowledgeEpistemicBasis; phrase: string };
  verification: { state: KnowledgeVerification; events: number; phrase: string };
  provenance: { state: KnowledgeProvenanceAssessment['state']; reliedInspectable: boolean; phrase: string };
  freshness: { state: FreshnessState; asOf: string | null; phrase: string };
  scope: { kind: KnowledgeScopeKind; valid: boolean; phrase: string };
  relevance: { reason: string | null };
  disclosure: { permitted: boolean; reason: string | null };
  currentUseVerdict: { state: UseState; phrase: string };
  historicalUseVerdict: { state: UseState; phrase: string };
  applications: { count: number; phrase: string };
  /** No Decision↔Knowledge relationship is recorded yet — never inferred from shared subject/run/text. */
  decisionRelationship: { recorded: false; phrase: string };
  limitations: string[];
  /** Deep evidence — surfaced by the operator evidence renderer, not routine conversation. */
  availableEvidence: { sources: ConversationSourceEvidence[]; supportJudgmentId: string | null };
  visibility: { operator: OperatorVisibility; aiConsumer: 'permitted' | 'denied' };
}

export interface KnowledgeConversationInput {
  item: {
    title: string;
    body: string;
    epistemicBasis: KnowledgeEpistemicBasis;
    verification: KnowledgeVerification;
    scopeKind: KnowledgeScopeKind;
    disclosure: KnowledgeDisclosure;
    status: KnowledgeStatus;
  };
  /** The shared assessment run for a CURRENT-operational-fact use — the strict baseline verdict. */
  currentAssessment: KnowledgeAssessment;
  /** The shared assessment run INDEPENDENTLY for a historical/audit use (its own disclosure decision for
   *  the historical consumer). Alternative use is established by its own assessment, never inferred from
   *  why current use was refused. */
  historicalAssessment: KnowledgeAssessment;
  provenance: KnowledgeProvenanceAssessment;
  verificationEventCount: number;
  /** The disclosure decision for the CONSUMER this description is for (permitted + why, if withheld). */
  disclosureDecision: { permitted: boolean; reason: string | null };
  /** Whether the human VIEWER may inspect a restricted record's content. False → a restricted record's
   *  content and source metadata are ABSENT from the descriptor (only a bounded withholding reason). */
  operatorAccess?: boolean;
  relevanceReason?: string | null;
  applicationCount: number;
  /** Present when this version was corrected by a later version (superseded). */
  supersededBy?: { version: number } | null;
  /** Present when the record is an AI proposal under review. */
  proposal?: { reviewStatus: string; confidence: string } | null;
  asOf?: Date | null;
  /** True when the caller guarantees the body is one bounded claim (e.g. an extraction proposal). */
  claimIsBounded?: boolean;
}

const EPISTEMIC_PHRASE: Record<KnowledgeEpistemicBasis, string> = {
  observed: 'observed by the system',
  human_asserted: 'asserted by a person',
  extracted: 'extracted from a source document',
  summarized: 'summarized from a source document',
  inferred: 'inferred — a conclusion, not a stated fact',
};

const FRESHNESS_PHRASE: Record<FreshnessState, string> = {
  current: 'current',
  review_due: 'within its validity period, but its scheduled review date has passed',
  stale: 'past its validity — no longer safe as a current fact',
  historical: 'tied to closed work — historical',
  // Reads naturally for authored statements (mission/values/charter) as well as dated facts; the
  // asOf-specific wording ("continuing validity not established") is applied separately when an asOf
  // is present, where it fits.
  unknown: 'no review date recorded',
};

/** ~4kB of prose is unlikely to be one honestly-uniform claim; flag it so a verdict isn't over-applied. */
const MULTI_CLAIM_LENGTH = 1_500;

function deriveCategory(i: KnowledgeConversationInput, freshness: FreshnessState): KnowledgeConversationCategory {
  // Gates first — the FULL assessment decides the tone, never the epistemic basis alone.
  if (!i.disclosureDecision.permitted && i.item.disclosure === 'restricted') return 'restricted_withheld';
  if (i.proposal && i.proposal.reviewStatus === 'pending') return 'ai_extracted_draft';
  if (i.item.verification === 'disputed') return 'disputed';
  if (freshness === 'stale' || freshness === 'historical') return 'stale_historical';
  if (freshness === 'review_due') return 'review_due';
  if (i.supersededBy) return 'superseded_correction';
  if (i.currentAssessment.useState === 'withheld') return 'withheld_other';
  if (i.item.verification === 'source_supported') return 'source_supported';
  if (i.item.epistemicBasis === 'summarized') return 'document_summary';
  if (i.item.epistemicBasis === 'inferred') return 'inference';
  if (i.item.epistemicBasis === 'human_asserted') return 'human_assertion';
  if (i.item.epistemicBasis === 'observed') return 'observation';
  return 'source_supported';
}

function provenancePhrase(p: KnowledgeProvenanceAssessment): string {
  switch (p.state) {
    case 'inspectable_support':
      return 'supported by evidence that is currently inspectable';
    case 'attached_not_reviewed':
      return 'a source is attached but its support has not yet been reviewed';
    case 'partial':
      return p.reliedBroken ? 'a relied-upon source version is currently unavailable' : 'some supplemental sources are currently unavailable';
    case 'broken':
      return 'the cited source version is currently unavailable';
    case 'unsupported':
      return 'the cited source type cannot be resolved';
    case 'no_source':
    default:
      return 'no source is recorded';
  }
}

/**
 * Layer 1 — the pure conversational descriptor. Composes existing assessments; adds no trust logic.
 */
export function describeKnowledgeForConversation(i: KnowledgeConversationInput): KnowledgeConversationDescriptor {
  const freshness = i.currentAssessment.freshness;
  const asOf = i.asOf ? i.asOf.toISOString().slice(0, 10) : null;
  const category = deriveCategory(i, freshness);
  const aiConsumer = !i.disclosureDecision.permitted && i.item.disclosure === 'restricted' ? 'denied' : 'permitted';

  // AUDIENCE-SPECIFIC DATA VISIBILITY comes FIRST. If the human viewer may not inspect a restricted
  // record, its content and source metadata are ABSENT from the descriptor — only a bounded withholding
  // reason survives. We construct the redacted descriptor directly, never a full one that a renderer
  // must later strip.
  const operatorAccess = i.operatorAccess ?? true;
  if (i.item.disclosure === 'restricted' && !operatorAccess) {
    return {
      claim: null,
      claimGranularity: 'single',
      category: 'restricted_withheld',
      formation: { epistemicBasis: i.item.epistemicBasis, phrase: '' },
      verification: { state: i.item.verification, events: 0, phrase: '' },
      provenance: { state: 'no_source', reliedInspectable: false, phrase: '' },
      freshness: { state: 'unknown', asOf: null, phrase: '' },
      scope: { kind: i.item.scopeKind, valid: i.currentAssessment.scopeValid, phrase: '' },
      relevance: { reason: null },
      disclosure: { permitted: false, reason: i.disclosureDecision.reason },
      currentUseVerdict: { state: 'withheld', phrase: 'withheld from this viewer' },
      historicalUseVerdict: { state: 'withheld', phrase: 'withheld from this viewer' },
      applications: { count: 0, phrase: '' },
      decisionRelationship: { recorded: false, phrase: 'No authoritative Decision relationship is recorded.' },
      limitations: [],
      availableEvidence: { sources: [], supportJudgmentId: null },
      visibility: { operator: 'withholding_only', aiConsumer: 'denied' },
    };
  }

  // Historical use is its OWN assessment — never inferred from why current use was refused.
  const currentState = i.currentAssessment.useState;
  const historicalState: UseState = i.historicalAssessment.useState;

  const freshnessPhrase = asOf && freshness === 'unknown' ? `observed as of ${asOf}; continuing validity has not been established` : asOf ? `${FRESHNESS_PHRASE[freshness]} · as of ${asOf}` : FRESHNESS_PHRASE[freshness];

  const limitations: string[] = [];
  const bounded = i.claimIsBounded === true || i.item.body.length <= MULTI_CLAIM_LENGTH;
  if (!bounded) limitations.push('This record contains multiple claims that may require separate trust assessments — revise or split before relying on it as one fact.');
  if (i.provenance.reliedBroken) limitations.push('Relied-upon evidence cannot currently be inspected at its cited version.');
  if (i.item.verification === 'disputed') limitations.push('This claim is disputed and not established as authoritative for current use.');
  if (freshness === 'unknown' && !asOf) limitations.push('No validity window is recorded.');

  return {
    claim: { title: i.item.title, body: i.item.body },
    claimGranularity: bounded ? 'single' : 'possibly_multiple',
    category,
    formation: { epistemicBasis: i.item.epistemicBasis, phrase: EPISTEMIC_PHRASE[i.item.epistemicBasis] },
    verification: {
      state: i.item.verification,
      events: i.verificationEventCount,
      phrase:
        i.item.verification === 'source_supported'
          ? 'separately judged source-supported'
          : i.item.verification === 'human_confirmed'
            ? 'human-confirmed'
            : i.item.verification === 'disputed'
              ? 'disputed'
              : i.item.verification === 'system_verified'
                ? 'system-verified by a deterministic check'
                : 'not independently verified',
    },
    provenance: { state: i.provenance.state, reliedInspectable: i.provenance.hasSupportJudgment && !i.provenance.reliedBroken, phrase: provenancePhrase(i.provenance) },
    freshness: { state: freshness, asOf, phrase: freshnessPhrase },
    scope: {
      kind: i.item.scopeKind,
      valid: i.currentAssessment.scopeValid,
      phrase: i.item.scopeKind === 'workspace' ? 'applies workspace-wide' : `applies to a specific ${i.item.scopeKind}`,
    },
    relevance: { reason: i.relevanceReason ?? null },
    disclosure: { permitted: i.disclosureDecision.permitted, reason: i.disclosureDecision.reason },
    currentUseVerdict: {
      state: currentState,
      phrase:
        currentState === 'usable'
          ? 'safe to rely on as a current fact'
          : currentState === 'usable_with_qualification'
            ? 'usable for current work only with its stated qualification'
            : 'not safe to use as a current fact',
    },
    historicalUseVerdict: {
      state: historicalState,
      phrase:
        historicalState === 'withheld'
          ? 'not available even for historical analysis'
          : historicalState === 'usable'
            ? 'available for historical analysis'
            : 'available for historical analysis, with its qualification',
    },
    // FACTUAL application language — the trail proves the record was SUPPLIED, not that it was used,
    // referenced, or that it changed any result.
    applications: {
      count: i.applicationCount,
      phrase: i.applicationCount === 0 ? 'has not been supplied to any AI operation' : `supplied to ${i.applicationCount} AI operation${i.applicationCount === 1 ? '' : 's'}`,
    },
    decisionRelationship: { recorded: false, phrase: 'No authoritative Decision relationship is recorded.' },
    limitations,
    availableEvidence: {
      sources: i.provenance.resolutions.map((r) => ({ label: r.label, versionHash: null, outcome: r.outcome, relied: r.relied })),
      supportJudgmentId: i.provenance.supportJudgmentId,
    },
    visibility: { operator: 'full', aiConsumer },
  };
}

// ---------------------------------------------------------------------------
// Layer 2 — audience-specific renderers (depth scales with consequence/question)
// ---------------------------------------------------------------------------

/** A record the viewer may only be told was withheld — never its content. */
function withholdingLine(d: KnowledgeConversationDescriptor): string {
  return `Withheld — ${d.disclosure.reason ?? 'not permitted for this viewer'}`;
}

/** Routine operator answer: the claim, its key qualification, its effective date. Not an 11-field dump. */
export function renderOperatorSummary(d: KnowledgeConversationDescriptor): string {
  if (d.visibility.operator !== 'full' || d.claim === null) return withholdingLine(d);
  const parts = [d.claim.title.trim()];
  if (d.currentUseVerdict.state !== 'usable') parts.push(`(${d.currentUseVerdict.phrase})`);
  if (d.freshness.asOf) parts.push(`as of ${d.freshness.asOf}`);
  else if (d.freshness.state !== 'current') parts.push(d.freshness.phrase);
  return parts.join(' — ');
}

/** Detailed operator evidence view: the full reasoning + deep provenance (progressive disclosure). */
export function renderOperatorEvidence(d: KnowledgeConversationDescriptor): string {
  if (d.visibility.operator !== 'full' || d.claim === null) return withholdingLine(d);
  const lines = [
    `Claim: ${d.claim.title}`,
    `Formation: ${d.formation.phrase}.`,
    `Verification: ${d.verification.phrase} (${d.verification.events} event${d.verification.events === 1 ? '' : 's'}).`,
    `Provenance: ${d.provenance.phrase}.`,
    `Freshness: ${d.freshness.phrase}.`,
    `Scope: ${d.scope.phrase}.`,
    `Current use: ${d.currentUseVerdict.phrase}. Historical use: ${d.historicalUseVerdict.phrase}.`,
    `Disclosure: ${d.disclosure.permitted ? 'permitted to this consumer' : `withheld — ${d.disclosure.reason ?? 'not permitted'}`}.`,
    `Applications: ${d.applications.phrase}.`,
    d.decisionRelationship.phrase,
  ];
  if (d.availableEvidence.sources.length > 0) {
    lines.push('Evidence:');
    for (const s of d.availableEvidence.sources) lines.push(`  - ${s.label}${s.relied ? ' (relied upon)' : ''}: ${s.outcome}`);
  }
  if (d.limitations.length > 0) lines.push(`Limitations: ${d.limitations.join(' ')}`);
  return lines.join('\n');
}

/**
 * The ONLY AI-consumer-facing text. Denial is checked FIRST: a record this consumer may not receive
 * yields null — no title, subject, source, reason, or even acknowledgement that a record exists. In the
 * live path the selector already excludes denied records, so this is defence in depth.
 */
export function renderAiQualification(d: KnowledgeConversationDescriptor): string | null {
  if (d.visibility.aiConsumer === 'denied' || d.claim === null) return null;
  if (d.currentUseVerdict.state === 'withheld') return null; // not supplied for use
  const quals: string[] = [d.formation.phrase, d.verification.phrase, d.freshness.phrase];
  if (d.provenance.state !== 'inspectable_support' && d.provenance.state !== 'no_source') quals.push(d.provenance.phrase);
  const bracket = `[${quals.join(' · ')}]`;
  return `${bracket}\n${d.claim.title}\n${d.claim.body}`;
}

/**
 * Historical / audit mode for a superseded (or historical) record — speaks the PAST honestly instead of
 * pretending it is current. Distinct from operational mode, which speaks only the current version.
 */
export function renderHistoricalAudit(d: KnowledgeConversationDescriptor): string {
  if (d.visibility.operator !== 'full' || d.claim === null) return withholdingLine(d);
  const lines = [`Historical record: ${d.claim.title}`, `Formation: ${d.formation.phrase}.`, `Freshness: ${d.freshness.phrase}.`];
  if (d.category === 'superseded_correction') lines.push('This version was corrected by a later version.');
  lines.push(`Historical use: ${d.historicalUseVerdict.phrase}.`, `Applications: ${d.applications.phrase}.`);
  return lines.join('\n');
}
