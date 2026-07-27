import { describe, expect, it } from 'vitest';
import { assessKnowledge, type KnowledgeAssessment } from '@/domain/knowledge/assess';
import { type KnowledgeProvenanceAssessment } from '@/domain/knowledge/knowledge';
import {
  describeKnowledgeForConversation,
  renderAiQualification,
  renderHistoricalAudit,
  renderOperatorEvidence,
  renderOperatorSummary,
  type KnowledgeConversationInput,
} from '@/domain/knowledge/conversation';

/**
 * The conversation layer TRANSLATES the trust model — it must add no trust logic. These pure tests fix
 * the representative states and the honesty guarantees: denied content never reaches an AI consumer,
 * epistemic basis never overrides a gate, "supplied" is never "used", and no Decision link is inferred.
 */

const NOW = new Date('2026-07-26T00:00:00Z');
const future = new Date('2026-07-31T00:00:00Z');
const past = new Date('2026-06-30T00:00:00Z');

function assess(over: Partial<Parameters<typeof assessKnowledge>[0]> = {}): KnowledgeAssessment {
  return assessKnowledge({
    status: 'active',
    epistemicBasis: 'observed',
    verification: 'unverified',
    asOf: null,
    verifiedAt: null,
    reviewAfter: null,
    expiresAt: null,
    scopeKind: 'workspace',
    scopeTaskId: null,
    scopeObjectiveId: null,
    scopeTaskStatus: null,
    scopeObjectiveStatus: null,
    disclosure: 'workspace_internal',
    disclosurePermitted: true,
    intendedUse: 'current_operational_fact',
    now: NOW,
    ...over,
  });
}

/** The historical/audit assessment — same inputs, historical intended use (its own real assessment). */
function assessHistorical(over: Partial<Parameters<typeof assessKnowledge>[0]> = {}): KnowledgeAssessment {
  return assess({ intendedUse: 'historical_analysis', ...over });
}

function prov(over: Partial<KnowledgeProvenanceAssessment> = {}): KnowledgeProvenanceAssessment {
  return {
    state: 'no_source',
    resolutions: [],
    hasSupportJudgment: false,
    supportJudgmentId: null,
    reliedOnSourceIds: [],
    reliedBroken: false,
    brokenForCurrentUse: false,
    ...over,
  };
}

function input(over: Partial<KnowledgeConversationInput> = {}): KnowledgeConversationInput {
  return {
    item: { title: 'A claim', body: 'short body', epistemicBasis: 'observed', verification: 'unverified', scopeKind: 'workspace', disclosure: 'workspace_internal', status: 'active' },
    currentAssessment: assess(),
    historicalAssessment: assessHistorical(),
    provenance: prov(),
    verificationEventCount: 0,
    disclosureDecision: { permitted: true, reason: null },
    applicationCount: 0,
    ...over,
  };
}

describe('knowledge conversation descriptor', () => {
  it('reuses the shared assessment verdict rather than recomputing it', () => {
    const a = assess({ expiresAt: future });
    const d = describeKnowledgeForConversation(input({ currentAssessment: a }));
    expect(d.currentUseVerdict.state).toBe(a.useState);
    expect(d.freshness.state).toBe(a.freshness);
  });

  it('a restricted, denied record yields NO AI-facing description (not even that it exists)', () => {
    const d = describeKnowledgeForConversation(
      input({
        item: { title: 'Secret margin', body: 'x', epistemicBasis: 'observed', verification: 'unverified', scopeKind: 'workspace', disclosure: 'restricted', status: 'active' },
        currentAssessment: assess({ disclosure: 'restricted', disclosurePermitted: false }),
        disclosureDecision: { permitted: false, reason: 'one consuming execution identity had no valid grant' },
      }),
    );
    expect(d.visibility.aiConsumer).toBe('denied');
    expect(d.category).toBe('restricted_withheld');
    const ai = renderAiQualification(d);
    expect(ai).toBeNull();
    // An authorized operator MAY receive a bounded withholding reason.
    const op = renderOperatorEvidence(d);
    expect(op).toContain('withheld');
    expect(op).toContain('no valid grant');
  });

  it('epistemic basis alone does not override a stale gate — an observed record can still be withheld', () => {
    const d = describeKnowledgeForConversation(
      input({
        item: { title: 'Old rate', body: 'x', epistemicBasis: 'observed', verification: 'unverified', scopeKind: 'workspace', disclosure: 'workspace_internal', status: 'active' },
        currentAssessment: assess({ epistemicBasis: 'observed', expiresAt: past }),
        historicalAssessment: assessHistorical({ epistemicBasis: 'observed', expiresAt: past }),
      }),
    );
    expect(d.category).toBe('stale_historical');
    expect(d.currentUseVerdict.state).toBe('withheld');
    expect(d.historicalUseVerdict.state).toBe('usable_with_qualification'); // its OWN historical assessment, not inferred
  });

  it('an asOf date without a validity window is described historically, not as current', () => {
    const d = describeKnowledgeForConversation(
      input({
        currentAssessment: assess({ asOf: new Date('2026-07-01T00:00:00Z') }),
        asOf: new Date('2026-07-01T00:00:00Z'),
      }),
    );
    expect(d.freshness.state).toBe('unknown');
    expect(d.freshness.phrase).toMatch(/continuing validity has not been established/);
    expect(d.currentUseVerdict.state).toBe('usable_with_qualification');
  });

  it('source-supported verification and current inspectability are reported separately', () => {
    const d = describeKnowledgeForConversation(
      input({
        item: { title: 'Priced fact', body: 'x', epistemicBasis: 'extracted', verification: 'source_supported', scopeKind: 'workspace', disclosure: 'workspace_internal', status: 'active' },
        currentAssessment: assess({ epistemicBasis: 'extracted', verification: 'source_supported', expiresAt: future, provenanceBroken: true }),
        provenance: prov({ state: 'broken', hasSupportJudgment: true, reliedBroken: true, brokenForCurrentUse: true }),
        verificationEventCount: 1,
      }),
    );
    expect(d.verification.state).toBe('source_supported'); // the historical judgment stands
    expect(d.provenance.reliedInspectable).toBe(false); // but its evidence isn't inspectable now
  });

  it('technical evidence appears only in the deep view, not the routine summary', () => {
    const d = describeKnowledgeForConversation(
      input({ provenance: prov({ state: 'inspectable_support', hasSupportJudgment: true, resolutions: [{ sourceId: 's1', label: 'Pricing.md', outcome: 'resolved', relied: true }] }) }),
    );
    expect(renderOperatorSummary(d)).not.toContain('Pricing.md');
    expect(renderOperatorEvidence(d)).toContain('Pricing.md');
  });

  it('application language says SUPPLIED, never used or influenced', () => {
    const d = describeKnowledgeForConversation(input({ applicationCount: 3 }));
    expect(d.applications.phrase).toBe('supplied to 3 AI operations');
    expect(d.applications.phrase).not.toMatch(/used|influenced/);
  });

  it('never infers a Decision relationship', () => {
    const d = describeKnowledgeForConversation(input());
    expect(d.decisionRelationship.recorded).toBe(false);
    expect(d.decisionRelationship.phrase).toMatch(/No authoritative Decision relationship is recorded/);
  });

  it('superseded records render differently in current vs historical mode', () => {
    const d = describeKnowledgeForConversation(input({ supersededBy: { version: 1 }, item: { title: 'Runtime 24m', body: 'x', epistemicBasis: 'observed', verification: 'human_confirmed', scopeKind: 'workspace', disclosure: 'workspace_internal', status: 'active' } }));
    expect(d.category).toBe('superseded_correction');
    const historical = renderHistoricalAudit(d);
    expect(historical).toMatch(/corrected by a later version/);
    expect(renderOperatorSummary(d)).not.toMatch(/corrected by a later version/); // current mode stays clean
  });

  it('flags a long free-text body as possibly-multiple-claim rather than one verdict', () => {
    const longBody = 'claim one. '.repeat(200); // > 1500 chars
    const d = describeKnowledgeForConversation(input({ item: { title: 'Big note', body: longBody, epistemicBasis: 'human_asserted', verification: 'unverified', scopeKind: 'workspace', disclosure: 'workspace_internal', status: 'active' } }));
    expect(d.claimGranularity).toBe('possibly_multiple');
    expect(d.limitations.join(' ')).toMatch(/multiple claims/);
  });

  it('a bounded extraction claim is treated as single even when long', () => {
    const longBody = 'one bounded claim '.repeat(200);
    const d = describeKnowledgeForConversation(input({ claimIsBounded: true, item: { title: 'Bounded', body: longBody, epistemicBasis: 'extracted', verification: 'unverified', scopeKind: 'workspace', disclosure: 'workspace_internal', status: 'active' } }));
    expect(d.claimGranularity).toBe('single');
  });

  it('an AI-extracted draft is described as proposed/quarantined and never supplied to a consumer', () => {
    const d = describeKnowledgeForConversation(
      input({
        item: { title: 'Proposed fact', body: 'x', epistemicBasis: 'extracted', verification: 'unverified', scopeKind: 'task', disclosure: 'workspace_internal', status: 'draft' },
        currentAssessment: assess({ status: 'draft', epistemicBasis: 'extracted', scopeKind: 'task', scopeTaskId: 't1' }),
        proposal: { reviewStatus: 'pending', confidence: 'low' },
      }),
    );
    expect(d.category).toBe('ai_extracted_draft');
    expect(d.currentUseVerdict.state).toBe('withheld'); // a draft is not usable
    expect(renderAiQualification(d)).toBeNull(); // never enters a prompt
  });

  it('a human assertion is not dressed as verified or source-backed', () => {
    const d = describeKnowledgeForConversation(input({ item: { title: 'Contractors prefer monthly', body: 'x', epistemicBasis: 'human_asserted', verification: 'unverified', scopeKind: 'workspace', disclosure: 'workspace_internal', status: 'active' } }));
    expect(d.category).toBe('human_assertion');
    expect(d.formation.phrase).toMatch(/asserted by a person/);
    expect(d.verification.phrase).toMatch(/not independently verified/);
  });

  it('a permitted record produces a proportionate AI qualification with claim text', () => {
    const d = describeKnowledgeForConversation(
      input({
        item: { title: 'Pilot is six weeks', body: 'The standard pilot runs six weeks.', epistemicBasis: 'extracted', verification: 'source_supported', scopeKind: 'workspace', disclosure: 'workspace_internal', status: 'active' },
        currentAssessment: assess({ epistemicBasis: 'extracted', verification: 'source_supported', expiresAt: future }),
        provenance: prov({ state: 'inspectable_support', hasSupportJudgment: true }),
      }),
    );
    const ai = renderAiQualification(d);
    expect(ai).not.toBeNull();
    expect(ai!).toContain('Pilot is six weeks');
    expect(ai!).toContain('source-supported'); // verification phrase carried into the bracket
  });
});

describe('correction 1 — historical use is a SEPARATE assessment, not inferred', () => {
  it('a draft is unavailable in BOTH modes (structural gate)', () => {
    const d = describeKnowledgeForConversation(
      input({
        item: { title: 'Draft', body: 'x', epistemicBasis: 'human_asserted', verification: 'unverified', scopeKind: 'workspace', disclosure: 'workspace_internal', status: 'draft' },
        currentAssessment: assess({ status: 'draft' }),
        historicalAssessment: assessHistorical({ status: 'draft' }),
      }),
    );
    expect(d.currentUseVerdict.state).toBe('withheld');
    expect(d.historicalUseVerdict.state).toBe('withheld'); // NOT rescued for history
  });

  it('restricted-without-grant is unavailable historically too (its own historical assessment denies it)', () => {
    const d = describeKnowledgeForConversation(
      input({
        item: { title: 'R', body: 'x', epistemicBasis: 'observed', verification: 'unverified', scopeKind: 'workspace', disclosure: 'restricted', status: 'active' },
        currentAssessment: assess({ disclosure: 'restricted', disclosurePermitted: false }),
        historicalAssessment: assessHistorical({ disclosure: 'restricted', disclosurePermitted: false }),
        disclosureDecision: { permitted: false, reason: 'no grant for the historical consumer either' },
      }),
    );
    expect(d.currentUseVerdict.state).toBe('withheld');
    expect(d.historicalUseVerdict.state).toBe('withheld'); // disclosure denies both uses
  });

  it('current and historical verdicts each match their own underlying assessment', () => {
    const cur = assess({ expiresAt: past }); // stale → withheld for current
    const hist = assessHistorical({ expiresAt: past }); // stale → qualified for history
    const d = describeKnowledgeForConversation(input({ currentAssessment: cur, historicalAssessment: hist }));
    expect(d.currentUseVerdict.state).toBe(cur.useState);
    expect(d.historicalUseVerdict.state).toBe(hist.useState);
    expect(cur.useState).not.toBe(hist.useState); // they genuinely differ, from two real assessments
  });
});

describe('correction 2 — audience-specific data visibility precedes rendering', () => {
  const restrictedInput = (operatorAccess: boolean) =>
    input({
      item: { title: 'Secret pricing', body: 'confidential margin 42%', epistemicBasis: 'observed', verification: 'unverified', scopeKind: 'workspace', disclosure: 'restricted', status: 'active' },
      currentAssessment: assess({ disclosure: 'restricted', disclosurePermitted: false }),
      historicalAssessment: assessHistorical({ disclosure: 'restricted', disclosurePermitted: false }),
      disclosureDecision: { permitted: false, reason: 'viewer lacks restricted access' },
      operatorAccess,
      provenance: prov({ state: 'inspectable_support', hasSupportJudgment: true, resolutions: [{ sourceId: 's', label: 'Secret-source.md', outcome: 'resolved', relied: true }] }),
    });

  it('an authorized operator may inspect the permitted claim and evidence', () => {
    const d = describeKnowledgeForConversation(restrictedInput(true));
    expect(d.visibility.operator).toBe('full');
    expect(d.claim).not.toBeNull();
    expect(renderOperatorEvidence(d)).toContain('Secret pricing');
  });

  it('an UNAUTHORIZED operator receives only the withholding reason — content + source metadata are ABSENT', () => {
    const d = describeKnowledgeForConversation(restrictedInput(false));
    expect(d.visibility.operator).toBe('withholding_only');
    expect(d.claim).toBeNull(); // no title, no body
    expect(d.availableEvidence.sources).toHaveLength(0); // no source labels
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain('Secret pricing');
    expect(serialized).not.toContain('confidential margin');
    expect(serialized).not.toContain('Secret-source.md');
    // The renderer cannot bypass the visibility state to reveal evidence.
    const op = renderOperatorEvidence(d);
    expect(op).toContain('viewer lacks restricted access');
    expect(op).not.toContain('Secret');
    // AI-facing stays null regardless.
    expect(renderAiQualification(d)).toBeNull();
  });
});
