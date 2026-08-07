import { describe, expect, it } from 'vitest';
import { normalizeHistoricalReviewDetail } from '@/domain/tasks/review-history';

describe('historical review-detail compatibility', () => {
  it('loads records with no review data', () => {
    expect(normalizeHistoricalReviewDetail(null)).toBeNull();
    expect(normalizeHistoricalReviewDetail(undefined)).toBeNull();
  });

  it('loads the original verdict/issues shape', () => {
    expect(normalizeHistoricalReviewDetail({
      verdict: 'revise',
      issues: [{ severity: 'major', summary: 'Legacy finding', detail: 'Historical detail' }],
    })).toEqual({
      verdict: 'revise',
      issues: [{ severity: 'major', summary: 'Legacy finding', detail: 'Historical detail' }],
    });
  });

  it('loads a valid v2 anchored review with provenance intact', () => {
    const value = {
      contractVersion: '2', verdict: 'reject',
      provenance: { reviewerAgentId: 'reviewer-1', provider: 'anthropic', model: 'claude-review' },
      issues: [{
        claimAnchor: 'claim-v1:p1:s1:0123456789ab', severity: 'critical',
        summary: 'Unsupported claim', rationale: 'No evidence supports it.',
      }],
    };
    expect(normalizeHistoricalReviewDetail(value)).toEqual(value);
  });

  it('accepts a partially populated legacy record by defaulting missing issues', () => {
    expect(normalizeHistoricalReviewDetail({ verdict: 'approve' })).toEqual({ verdict: 'approve', issues: [] });
  });

  it('loads new immutable provenance and strips unknown metadata', () => {
    const value = {
      contractVersion: '2', verdict: 'approve', issues: [],
      provenance: {
        reviewerAgentId: 'reviewer-1', reviewerDisplayName: 'Original Name', provider: 'anthropic', model: 'claude-review',
        rubricHash: 'a'.repeat(64), rubricSnapshot: 'Evidence first.', executedAt: '2026-08-07T12:34:56.000Z',
        injected: 'ignored',
      },
    };
    expect(normalizeHistoricalReviewDetail(value)?.provenance).toEqual({
      reviewerAgentId: 'reviewer-1', reviewerDisplayName: 'Original Name', provider: 'anthropic', model: 'claude-review',
      rubricHash: 'a'.repeat(64), rubricSnapshot: 'Evidence first.', executedAt: '2026-08-07T12:34:56.000Z',
    });
  });

  it('fails malformed new provenance safely without crashing historical reads', () => {
    expect(normalizeHistoricalReviewDetail({
      contractVersion: '2', verdict: 'approve', issues: [],
      provenance: { reviewerAgentId: 'r', provider: 'anthropic', model: 'm', rubricHash: 'not-a-hash' },
    })).toBeNull();
  });

  it.each([
    ['unknown verdict', { verdict: 'maybe', issues: [] }],
    ['invalid legacy issue', { verdict: 'revise', issues: [{ severity: 'huge', summary: 'x' }] }],
    ['v2 missing provenance', { contractVersion: '2', verdict: 'approve', issues: [] }],
    ['non-object', 'approve'],
  ])('fails invalid historical data safely: %s', (_name, value) => {
    expect(normalizeHistoricalReviewDetail(value)).toBeNull();
  });
});
