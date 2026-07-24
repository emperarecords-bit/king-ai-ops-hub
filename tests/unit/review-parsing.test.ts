import { describe, expect, it } from 'vitest';
import { parseReviewDetail, stripIssuesBlock } from '@/orchestration/prompts';

const issuesBlock = (json: string) => '```review-issues\n' + json + '\n```';

describe('parseReviewDetail', () => {
  it('parses verdict and a valid issues block', () => {
    const text = `VERDICT: revise\n\nTwo problems.\n\n${issuesBlock(
      JSON.stringify([
        { severity: 'major', summary: 'Off-by-one in pagination', detail: 'limit+1 rows returned' },
        { severity: 'minor', summary: 'Typo in error message' },
      ]),
    )}`;
    const { detail, malformedReasons } = parseReviewDetail(text);
    expect(detail.verdict).toBe('revise');
    expect(detail.issues).toHaveLength(2);
    expect(detail.issues[0]!.severity).toBe('major');
    expect(malformedReasons).toEqual([]);
  });

  it('approve with no block → empty issues, no complaints', () => {
    const { detail, malformedReasons } = parseReviewDetail('VERDICT: approve\n\nAll good.');
    expect(detail.verdict).toBe('approve');
    expect(detail.issues).toEqual([]);
    expect(malformedReasons).toEqual([]);
  });

  it('invalid JSON degrades to zero issues and reports, never throws', () => {
    const text = `VERDICT: revise\n${issuesBlock('[{severity: major}]')}`;
    const { detail, malformedReasons } = parseReviewDetail(text);
    expect(detail.verdict).toBe('revise');
    expect(detail.issues).toEqual([]);
    expect(malformedReasons).toHaveLength(1);
  });

  it('schema-invalid issues degrade to zero issues and report', () => {
    const text = `VERDICT: reject\n${issuesBlock(
      JSON.stringify([{ severity: 'catastrophic', summary: 'nope' }]),
    )}`;
    const { detail, malformedReasons } = parseReviewDetail(text);
    expect(detail.verdict).toBe('reject');
    expect(detail.issues).toEqual([]);
    expect(malformedReasons.length).toBeGreaterThan(0);
  });

  it('missing verdict line defaults to revise (conservative middle)', () => {
    const { detail } = parseReviewDetail('Looks fine I guess.');
    expect(detail.verdict).toBe('revise');
  });

  it('caps issues at 20 via schema rejection', () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      severity: 'minor' as const,
      summary: `issue ${i}`,
    }));
    const { detail, malformedReasons } = parseReviewDetail(
      `VERDICT: revise\n${issuesBlock(JSON.stringify(many))}`,
    );
    expect(detail.issues).toEqual([]);
    expect(malformedReasons.length).toBeGreaterThan(0);
  });
});

describe('stripIssuesBlock', () => {
  it('removes the block for human display', () => {
    const text = `VERDICT: revise\nReasoning here.\n\n${issuesBlock('[]')}`;
    expect(stripIssuesBlock(text)).toBe('VERDICT: revise\nReasoning here.');
  });

  it('leaves text without a block untouched', () => {
    expect(stripIssuesBlock('VERDICT: approve\nFine.')).toBe('VERDICT: approve\nFine.');
  });
});
