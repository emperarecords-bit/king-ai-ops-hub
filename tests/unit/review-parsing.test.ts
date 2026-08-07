import { describe, expect, it } from 'vitest';
import { anchorReviewClaims, parseReviewDetail, stripIssuesBlock } from '@/orchestration/prompts';

const primary = 'Revenue is $42,000. Growth cannot be assessed without a comparison period.';
const claims = anchorReviewClaims(primary);
const provenance = { reviewerAgentId: 'reviewer-1', provider: 'anthropic' as const, model: 'review-model' };
const block = (value: unknown) => `\`\`\`review-result\n${JSON.stringify(value)}\n\`\`\``;
const finding = (anchor = claims[0]!.anchor) => ({
  claimAnchor: anchor,
  severity: 'major',
  rationale: 'The claim lacks supporting evidence.',
  requestedRevision: 'Limit the statement to supported evidence.',
});

describe('claim anchors', () => {
  it('are deterministic and combine structural position with a content digest', () => {
    expect(anchorReviewClaims(primary)).toEqual(claims);
    expect(claims.map((claim) => claim.anchor)).toEqual([
      expect.stringMatching(/^claim-v1:p1:s1:[0-9a-f]{12}$/),
      expect.stringMatching(/^claim-v1:p1:s2:[0-9a-f]{12}$/),
    ]);
  });
});

describe('strict review-result parsing', () => {
  it('accepts a fully valid approval with trusted provenance', () => {
    const parsed = parseReviewDetail(`Prose before.\n${block({ verdict: 'approve', findings: [] })}\nProse after.`, primary, provenance);
    expect(parsed.malformedReasons).toEqual([]);
    expect(parsed.detail).toMatchObject({ contractVersion: '2', verdict: 'approve', issues: [], provenance });
  });

  it.each(['revise', 'reject'] as const)('accepts a valid %s with per-claim severity and rationale', (verdict) => {
    const value = { verdict, findings: [verdict === 'reject' ? { ...finding(), requestedRevision: undefined } : finding()] };
    const parsed = parseReviewDetail(block(value), primary, provenance);
    expect(parsed.malformedReasons).toEqual([]);
    expect(parsed.detail.issues[0]).toMatchObject({ claimAnchor: claims[0]!.anchor, severity: 'major' });
  });

  it('accepts multiple distinct claim findings', () => {
    const parsed = parseReviewDetail(block({ verdict: 'revise', findings: [finding(claims[0]!.anchor), finding(claims[1]!.anchor)] }), primary, provenance);
    expect(parsed.detail.issues).toHaveLength(2);
    expect(parsed.malformedReasons).toEqual([]);
  });

  it.each([
    ['duplicate anchors', { verdict: 'revise', findings: [finding(), finding()] }],
    ['unknown anchor', { verdict: 'revise', findings: [finding('claim-v1:p99:s99:000000000000')] }],
    ['malformed severity', { verdict: 'revise', findings: [{ ...finding(), severity: 'catastrophic' }] }],
    ['malformed verdict', { verdict: 'maybe', findings: [] }],
  ])('fails closed for %s', (_name, value) => {
    const parsed = parseReviewDetail(block(value), primary, provenance);
    expect(parsed.detail.verdict).toBe('reject');
    expect(parsed.detail.issues).toEqual([]);
    expect(parsed.malformedReasons.length).toBeGreaterThan(0);
  });

  it('fails closed when trusted provenance is missing', () => {
    const parsed = parseReviewDetail(block({ verdict: 'approve', findings: [] }), primary);
    expect(parsed.detail.verdict).toBe('reject');
    expect(parsed.malformedReasons).toContain('trusted reviewer provenance is missing');
  });

  it('rejects a hallucinated claim and a truncated provider result', () => {
    expect(parseReviewDetail(block({ verdict: 'reject', findings: [finding('invented')] }), primary, provenance).malformedReasons[0]).toContain('unknown claim');
    expect(parseReviewDetail('```review-result\n{"verdict":"approve"', primary, provenance).detail.verdict).toBe('reject');
  });

  it('never coerces missing or malformed structured output into approval', () => {
    expect(parseReviewDetail('VERDICT: approve\nLooks good.', primary, provenance).detail.verdict).toBe('reject');
  });
});

describe('stripIssuesBlock', () => {
  it('removes current and legacy structured blocks for human display', () => {
    expect(stripIssuesBlock(`Reasoning\n${block({ verdict: 'approve', findings: [] })}`)).toBe('Reasoning');
    expect(stripIssuesBlock('Reasoning\n```review-issues\n[]\n```')).toBe('Reasoning');
  });
});
