import { describe, expect, it } from 'vitest';
import { anchorReviewClaims, canonicalClaimAnchor, CLAIM_ANCHOR_PREFIX, parseReviewDetail } from '@/orchestration/prompts';

/**
 * Hub prod 2026-10-23, run ef83a6aa (server-cooling job on Senior Engineer): the reviewer returned a complete "revise"
 * verdict with real findings, but wrote its anchors as "p12:s4:87db81aa5063" — dropping the "claim-v1:" prefix. One
 * unknown anchor invalidates the whole review, so it was stored as the fallback "reject" with no findings, the
 * revision never ran, and the answer became an UNREVIEWED DRAFT. A prefix-less anchor is now accepted ONLY when it
 * matches a real claim exactly (same paragraph, sentence and content hash) once the prefix is added.
 */

const primary = 'Revenue is $42,000. Growth cannot be assessed without a comparison period.';
const claims = anchorReviewClaims(primary);
const provenance = { reviewerAgentId: 'reviewer-1', provider: 'anthropic' as const, model: 'review-model' };
const block = (value: unknown) => `\`\`\`review-result\n${JSON.stringify(value)}\n\`\`\``;
const finding = (claimAnchor: string) => ({
  claimAnchor,
  severity: 'major',
  rationale: 'Specify the exact model sized to the 20 kW load.',
  requestedRevision: 'Name the exact FUSION-TEC model number.',
});
const bare = (anchor: string) => anchor.slice(CLAIM_ANCHOR_PREFIX.length);

describe('review anchors missing the "claim-v1:" prefix', () => {
  it('a real "revise" with prefix-less anchors is accepted, stored with the canonical anchor', () => {
    const parsed = parseReviewDetail(block({ verdict: 'revise', findings: [finding(bare(claims[1]!.anchor))] }), primary, provenance);
    expect(parsed.malformedReasons).toEqual([]);
    expect(parsed.detail.verdict).toBe('revise');
    expect(parsed.detail.issues.map((i) => i.claimAnchor)).toEqual([claims[1]!.anchor]);
  });

  it('mixed prefixed + prefix-less anchors both resolve', () => {
    const parsed = parseReviewDetail(
      block({ verdict: 'revise', findings: [finding(claims[0]!.anchor), finding(bare(claims[1]!.anchor))] }),
      primary,
      provenance,
    );
    expect(parsed.malformedReasons).toEqual([]);
    expect(parsed.detail.issues.map((i) => i.claimAnchor)).toEqual([claims[0]!.anchor, claims[1]!.anchor]);
  });

  it('nothing looser: a wrong hash, wrong position or invented anchor is still refused', () => {
    const [p, s] = bare(claims[0]!.anchor).split(':');
    for (const bad of [`${p}:${s}:000000000000`, 'p9:s9:' + bare(claims[0]!.anchor).split(':')[2], 'invented', `CLAIM-V1:${bare(claims[0]!.anchor)}`]) {
      const parsed = parseReviewDetail(block({ verdict: 'revise', findings: [finding(bad)] }), primary, provenance);
      expect(parsed.detail.verdict, bad).toBe('reject');
      expect(parsed.malformedReasons[0], bad).toContain('unknown claim anchor');
    }
  });

  it('the same claim named twice (once with, once without the prefix) is still a duplicate', () => {
    const parsed = parseReviewDetail(
      block({ verdict: 'revise', findings: [finding(claims[0]!.anchor), finding(bare(claims[0]!.anchor))] }),
      primary,
      provenance,
    );
    expect(parsed.malformedReasons[0]).toContain('duplicate claim anchor');
  });

  it('canonicalClaimAnchor: exact first, then prefix + text, else null', () => {
    const known = new Set(claims.map((c) => c.anchor));
    expect(canonicalClaimAnchor(claims[0]!.anchor, known)).toBe(claims[0]!.anchor);
    expect(canonicalClaimAnchor(` ${bare(claims[0]!.anchor)} `, known)).toBe(claims[0]!.anchor);
    expect(canonicalClaimAnchor('p1:s1:ffffffffffff', known)).toBeNull();
  });
});
