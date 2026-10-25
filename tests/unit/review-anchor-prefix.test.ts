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

/**
 * Hub prod 2026-10-23, run b0827cc9 (Server Cabinet Cooling on Senior Engineer): the reviewer cited
 * "[claim-v1:p8:s3:b1362c51e5ae]" — a real claim, copied with the display brackets from the "[anchor] text" listing.
 * The whole review was voided the same way. One pair of surrounding brackets is now dropped before matching.
 */
describe('review anchors copied with the display brackets', () => {
  const known = new Set(claims.map((c) => c.anchor));

  it('bracketed exact anchor → accepted, canonical anchor stored', () => {
    expect(canonicalClaimAnchor(`[${claims[1]!.anchor}]`, known)).toBe(claims[1]!.anchor);
    expect(canonicalClaimAnchor(` [ ${claims[1]!.anchor} ] `, known)).toBe(claims[1]!.anchor);
    const parsed = parseReviewDetail(block({ verdict: 'revise', findings: [finding(`[${claims[1]!.anchor}]`)] }), primary, provenance);
    expect(parsed.malformedReasons).toEqual([]);
    expect(parsed.detail.verdict).toBe('revise');
    expect(parsed.detail.issues.map((i) => i.claimAnchor)).toEqual([claims[1]!.anchor]);
  });

  it('bracketed + missing prefix → accepted', () => {
    expect(canonicalClaimAnchor(`[${bare(claims[0]!.anchor)}]`, known)).toBe(claims[0]!.anchor);
    const parsed = parseReviewDetail(block({ verdict: 'reject', findings: [finding(`[${bare(claims[0]!.anchor)}]`)] }), primary, provenance);
    expect(parsed.malformedReasons).toEqual([]);
    expect(parsed.detail.issues.map((i) => i.claimAnchor)).toEqual([claims[0]!.anchor]);
  });

  it('bracketed + wrong hash or wrong position → refused', () => {
    const [p, s, hash] = bare(claims[0]!.anchor).split(':');
    for (const bad of [`[${CLAIM_ANCHOR_PREFIX}${p}:${s}:000000000000]`, `[${p}:${s}:000000000000]`, `[${CLAIM_ANCHOR_PREFIX}p9:s9:${hash}]`]) {
      expect(canonicalClaimAnchor(bad, known), bad).toBeNull();
      const parsed = parseReviewDetail(block({ verdict: 'revise', findings: [finding(bad)] }), primary, provenance);
      expect(parsed.detail.verdict, bad).toBe('reject');
      expect(parsed.malformedReasons[0], bad).toContain('unknown claim anchor');
    }
  });

  it('only ONE surrounding pair: double, unbalanced or other brackets are refused', () => {
    const a = claims[0]!.anchor;
    for (const bad of [`[[${a}]]`, `[${a}`, `${a}]`, `(${a})`, `{${a}}`, '[]']) {
      expect(canonicalClaimAnchor(bad, known), bad).toBeNull();
    }
  });

  it('a bracketed and a plain citation of the same claim are still a duplicate', () => {
    const parsed = parseReviewDetail(
      block({ verdict: 'revise', findings: [finding(claims[0]!.anchor), finding(`[${claims[0]!.anchor}]`)] }),
      primary,
      provenance,
    );
    expect(parsed.malformedReasons[0]).toContain('duplicate claim anchor');
  });

  it('a hash-less position anchor ("claim-v1:p1:s2") is still refused, bracketed or not', () => {
    const [p, s] = bare(claims[1]!.anchor).split(':');
    for (const bad of [`${CLAIM_ANCHOR_PREFIX}${p}:${s}`, `[${CLAIM_ANCHOR_PREFIX}${p}:${s}]`, `${p}:${s}`]) {
      expect(canonicalClaimAnchor(bad, known), bad).toBeNull();
    }
  });
});
