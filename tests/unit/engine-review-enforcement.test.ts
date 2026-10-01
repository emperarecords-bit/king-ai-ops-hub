import { describe, expect, it } from 'vitest';
import {
  consolidate,
  executeRun,
  UNREVIEWED_DRAFT_BANNER,
  type EngineInput,
  type StepRecord,
} from '@/orchestration/engine';
import { FakeProvider, makeEngineAgent } from '@tests/support/fake-provider';
import { anchorReviewClaims } from '@/orchestration/prompts';

/**
 * Answer-routing Phase 1 — engine-level review-outcome enforcement. Proves the engine derives the correct
 * review_outcome and that a REQUIRED-but-unmet review produces an UNREVIEWED DRAFT banner, while an OPTIONAL
 * review failure degrades WITHOUT the required-unmet banner (clearly distinguished). Fake providers only — no
 * network, no spend.
 */

function reviewResult(verdict: 'approve' | 'revise' | 'reject', primaryText: string) {
  const findings =
    verdict === 'approve'
      ? []
      : [
          {
            claimAnchor: anchorReviewClaims(primaryText)[0]!.anchor,
            severity: verdict === 'reject' ? 'critical' : 'major',
            rationale: 'A finding.',
            ...(verdict === 'revise' ? { requestedRevision: 'Fix it.' } : {}),
          },
        ];
  return `\`\`\`review-result\n${JSON.stringify({ verdict, findings })}\n\`\`\``;
}

function collectingSink() {
  const steps: StepRecord[] = [];
  return {
    steps,
    sink: {
      onStep: async (s: StepRecord) => {
        steps.push(s);
      },
      onMalformedOutput: async () => {},
    },
  };
}

function input(
  primary: FakeProvider,
  reviewer: FakeProvider | null,
  reviewRequired: boolean,
): EngineInput {
  return {
    taskInput: 'Explain the plan.',
    contextItems: [{ title: 'Charter', content: 'Context.' }],
    primary: makeEngineAgent(primary, 'primary-1'),
    reviewer: reviewer ? makeEngineAgent(reviewer, 'reviewer-1') : null,
    reviewRequired,
    perCallTimeoutMs: 5_000,
    runDeadline: Date.now() + 30_000,
  };
}

describe('executeRun — review outcome (answer-routing Phase 1)', () => {
  it('Quick permitted (no reviewer, not required) → omitted; no banner', async () => {
    const primary = new FakeProvider('openai').reply('The answer.');
    const { sink } = collectingSink();
    const result = await executeRun(input(primary, null, false), sink);
    expect(result.reviewOutcome).toBe('omitted');
    expect(result.consolidated).toContain('The answer.');
    expect(result.consolidated).not.toContain('UNREVIEWED DRAFT');
  });

  it('Reviewed, reviewer approves → reviewed', async () => {
    const primary = new FakeProvider('openai').reply('Draft.');
    const reviewer = new FakeProvider('anthropic').reply(reviewResult('approve', 'Draft.'));
    const { sink } = collectingSink();
    const result = await executeRun(input(primary, reviewer, false), sink);
    expect(result.reviewOutcome).toBe('reviewed');
    expect(result.consolidated).not.toContain('UNREVIEWED DRAFT');
  });

  it('Reviewed, reviewer REJECTS (well-formed negative verdict) → reviewed (met, not unmet)', async () => {
    const primary = new FakeProvider('openai').reply('Draft.');
    const reviewer = new FakeProvider('anthropic').reply(reviewResult('reject', 'Draft.'));
    const { sink } = collectingSink();
    const result = await executeRun(input(primary, reviewer, true), sink);
    expect(result.reviewOutcome).toBe('reviewed');
    expect(result.consolidated).not.toContain('UNREVIEWED DRAFT');
  });

  it('REQUIRED + reviewer absent → required_unmet + unreviewed-draft banner', async () => {
    const primary = new FakeProvider('openai').reply('The draft.');
    const { sink } = collectingSink();
    const result = await executeRun(input(primary, null, true), sink);
    expect(result.reviewOutcome).toBe('required_unmet');
    expect(result.consolidated).toContain('UNREVIEWED DRAFT');
    expect(result.consolidated).toContain('The draft.');
  });

  it('REQUIRED + reviewer FAILS → required_unmet + banner (primary preserved)', async () => {
    const primary = new FakeProvider('openai').reply('The draft.');
    const reviewer = new FakeProvider('anthropic').fail('auth');
    const { sink, steps } = collectingSink();
    const result = await executeRun(input(primary, reviewer, true), sink);
    expect(result.reviewOutcome).toBe('required_unmet');
    expect(result.consolidated).toContain('UNREVIEWED DRAFT');
    expect(result.consolidated).toContain('The draft.');
    // The review step is recorded as a failure, not omitted silently.
    expect(steps.find((s) => s.kind === 'review')?.succeeded).toBe(false);
  });

  it('REQUIRED + reviewer returns INVALID result → required_unmet (invalid ≠ reviewed)', async () => {
    const primary = new FakeProvider('openai').reply('The draft.');
    const reviewer = new FakeProvider('anthropic').reply('no review-result block here');
    const { sink } = collectingSink();
    const result = await executeRun(input(primary, reviewer, true), sink);
    expect(result.reviewOutcome).toBe('required_unmet');
    expect(result.consolidated).toContain('UNREVIEWED DRAFT');
  });

  it('OPTIONAL review failure → optional_degraded, clearly distinguished (NO required banner)', async () => {
    const primary = new FakeProvider('openai').reply('The draft.');
    const reviewer = new FakeProvider('anthropic').fail('auth');
    const { sink } = collectingSink();
    const result = await executeRun(input(primary, reviewer, false), sink);
    expect(result.reviewOutcome).toBe('optional_degraded');
    expect(result.consolidated).not.toContain('UNREVIEWED DRAFT');
    expect(result.consolidated).toContain('The draft.');
  });
});

describe('consolidate — banner only on required_unmet (backward compatible otherwise)', () => {
  it('omitting reviewOutcome preserves prior output exactly (no banner, no notes)', () => {
    const out = consolidate({ primaryText: 'Body.', reviewText: null, verdict: null, revisionText: null });
    expect(out).toBe('Body.');
  });

  it('required_unmet prepends the banner and drops any revision/summary', () => {
    const out = consolidate({
      primaryText: 'Primary body.',
      reviewText: '```review-result\n{"verdict":"reject","findings":[]}\n```',
      verdict: 'reject',
      revisionText: 'A revision that must NOT be shown.',
      reviewOutcome: 'required_unmet',
    });
    expect(out.startsWith(UNREVIEWED_DRAFT_BANNER)).toBe(true);
    expect(out).toContain('Primary body.');
    expect(out).not.toContain('A revision that must NOT be shown.');
    expect(out).not.toContain('Review summary');
  });
});
