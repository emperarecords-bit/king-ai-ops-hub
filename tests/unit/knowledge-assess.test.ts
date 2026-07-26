import { describe, expect, it } from 'vitest';
import { assessKnowledge } from '@/domain/knowledge/assess';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const base = {
  status: 'active' as const,
  epistemicBasis: 'human_asserted' as const,
  verification: 'unverified' as const,
  asOf: null as Date | null,
  verifiedAt: null as Date | null,
  reviewAfter: null as Date | null,
  expiresAt: null as Date | null,
  scopeKind: 'workspace' as const,
  scopeTaskId: null as string | null,
  scopeObjectiveId: null as string | null,
  scopeTaskStatus: null as string | null,
  scopeObjectiveStatus: null as string | null,
  disclosure: 'workspace_internal' as const,
  disclosurePermitted: true,
  intendedUse: 'current_operational_fact' as const,
  now: NOW,
};

describe('assessKnowledge — one shared trust assessment', () => {
  it('activation does not create verification — an active manual assertion is unverified and only qualified', () => {
    const a = assessKnowledge(base);
    expect(a.verification).toBe('unverified');
    expect(a.useState).toBe('usable_with_qualification');
    expect(a.reasons).toContain('unverified_or_unknown');
  });

  it('a human-confirmed, current, workspace record is cleanly usable', () => {
    const a = assessKnowledge({ ...base, verification: 'human_confirmed', verifiedAt: new Date('2026-07-25'), asOf: new Date('2026-07-25') });
    expect(a.freshness).toBe('current');
    expect(a.useState).toBe('usable');
  });

  it('expired knowledge is withheld from current-fact use but qualified for historical analysis', () => {
    const expired = { ...base, expiresAt: new Date('2020-01-01') };
    expect(assessKnowledge(expired).useState).toBe('withheld');
    expect(assessKnowledge(expired).reasons).toContain('expired_for_current_fact');
    const hist = assessKnowledge({ ...expired, intendedUse: 'historical_analysis' });
    expect(hist.useState).toBe('usable_with_qualification');
  });

  it('closed-scope knowledge does not enter unrelated current operational work', () => {
    const a = assessKnowledge({ ...base, scopeKind: 'task', scopeTaskId: 't1', scopeTaskStatus: 'completed' });
    expect(a.freshness).toBe('historical');
    expect(a.useState).toBe('withheld');
    expect(a.reasons).toContain('scope_closed_for_current_work');
  });

  it('disputed is withheld as settled current fact but may be qualified for reference/comparison', () => {
    expect(assessKnowledge({ ...base, verification: 'disputed' }).useState).toBe('withheld');
    const ref = assessKnowledge({ ...base, verification: 'disputed', intendedUse: 'reference' });
    expect(ref.useState).toBe('usable_with_qualification');
    expect(ref.reasons).toContain('disputed');
  });

  it('restricted knowledge is withheld without a grant', () => {
    const a = assessKnowledge({ ...base, disclosure: 'restricted', disclosurePermitted: false });
    expect(a.disclosureDecision).toBe('withheld');
    expect(a.useState).toBe('withheld');
    expect(a.reasons).toContain('restricted_without_grant');
    // With a grant it is not withheld on disclosure grounds.
    expect(assessKnowledge({ ...base, disclosure: 'restricted', disclosurePermitted: true }).disclosureDecision).toBe('permitted');
  });

  it('a missing scope target is invalid scope; drafts/archived are withheld', () => {
    expect(assessKnowledge({ ...base, scopeKind: 'task', scopeTaskId: null }).reasons).toContain('invalid_scope');
    expect(assessKnowledge({ ...base, status: 'draft' }).useState).toBe('withheld');
    expect(assessKnowledge({ ...base, status: 'archived' }).useState).toBe('withheld');
  });

  it('review-due knowledge is supplied only with a qualification', () => {
    const a = assessKnowledge({ ...base, verification: 'human_confirmed', asOf: new Date('2026-01-01'), reviewAfter: new Date('2026-06-01') });
    expect(a.freshness).toBe('review_due');
    expect(a.useState).toBe('usable_with_qualification');
    expect(a.reasons).toContain('review_due');
  });

  it('freshness comes from explicit facts, not row age — verifiedAt alone is not "current"', () => {
    // Verified last week but with NO as-of date → freshness unknown, not current.
    expect(assessKnowledge({ ...base, verifiedAt: new Date('2026-07-20') }).freshness).toBe('unknown');
    // An as-of date is the basis for currency.
    expect(assessKnowledge({ ...base, asOf: new Date('2026-07-20') }).freshness).toBe('current');
    // No temporal evidence at all → unknown.
    expect(assessKnowledge(base).freshness).toBe('unknown');
  });

  it('boundary timestamps are inclusive and compared as absolute instants (timezone-independent)', () => {
    // Exactly at the boundary counts as passed.
    expect(assessKnowledge({ ...base, expiresAt: new Date(NOW.getTime()) }).freshness).toBe('stale');
    expect(assessKnowledge({ ...base, asOf: new Date('2026-01-01'), reviewAfter: new Date(NOW.getTime()) }).freshness).toBe('review_due');
    // One millisecond in the future is not yet expired.
    expect(assessKnowledge({ ...base, asOf: new Date('2026-07-01'), expiresAt: new Date(NOW.getTime() + 1) }).freshness).toBe('current');
    // Same instant expressed in a different timezone offset must behave identically.
    const sameInstantOtherTz = new Date('2026-07-26T00:00:00.000Z'); // == NOW
    expect(assessKnowledge({ ...base, expiresAt: sameInstantOtherTz }).freshness).toBe('stale');
  });
});
