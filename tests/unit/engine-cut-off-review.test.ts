import { describe, expect, it } from 'vitest';
import {
  CUT_OFF_REVIEW_MESSAGE,
  CUT_OFF_REVIEW_RETRIED,
  executeRun,
  isCutOffReview,
  reviewRetryOutputTokens,
  type EngineAgent,
  type EngineInput,
  type StepRecord,
} from '@/orchestration/engine';
import { anchorReviewClaims } from '@/orchestration/prompts';
import { summarizeReview } from '@/domain/tasks/review-summary';
import { FakeProvider, makeEngineAgent } from '@tests/support/fake-provider';
import type { AgentRequest, AgentResponse, AIProvider } from '@/types/provider';
import type { MessageRow, RunStepRow } from '@/domain/tasks/tasks';

/**
 * Hub prod 2026-10-22, run 4afba522 (Senior Engineer job): the Principal Reviewer gave a real "revise" verdict, but
 * thinking used its whole 4,096-token output budget — the reply stopped mid-JSON at 737 characters, the parser stored
 * its "reject" fallback, the revision never ran and the answer became an UNREVIEWED DRAFT. Now a cut-off review is
 * retried ONCE with more room (same step, both calls billed), and if it is cut off again the step fails honestly.
 */

const PRIMARY = 'Punch list: use a 36x16 trunk.';
const anchor = anchorReviewClaims(PRIMARY)[0]!.anchor;
const REVISE = `\`\`\`review-result\n${JSON.stringify({ verdict: 'revise', findings: [{ claimAnchor: anchor, severity: 'major', rationale: 'Show the CFM calculation.', requestedRevision: 'Add the CFM math.' }] })}\n\`\`\``;
const CUT = '```review-result\n{"verdict":"revise","findings":[{"claimAnchor":"' + anchor + '","severity":"major","rationale":"The response asserts specific';

/** A scripted reviewer: each reply carries its own stop reason; records every request. */
function scriptedReviewer(replies: Array<{ text: string; stop: string }>): { provider: AIProvider; requests: AgentRequest[] } {
  const requests: AgentRequest[] = [];
  const provider = {
    id: 'anthropic',
    authoritativeNotExecuted: { support: 'unsupported' },
    listModels: () => [],
    execute: async (req: AgentRequest): Promise<AgentResponse> => {
      requests.push(req);
      const r = replies.shift() ?? { text: '', stop: 'end_turn' };
      return { provider: 'anthropic', model: req.model, text: r.text, usage: { inputTokens: 100, outputTokens: req.maxOutputTokens }, stopReason: r.stop, latencyMs: 1 };
    },
  } as unknown as AIProvider;
  return { provider, requests };
}

function run(reviewer: AIProvider, primary: FakeProvider, extra: Partial<EngineInput> = {}) {
  const steps: StepRecord[] = [];
  const malformed: string[][] = [];
  const reviewerAgent: EngineAgent = { ...makeEngineAgent(new FakeProvider('anthropic'), 'reviewer-1'), provider: reviewer, maxOutputTokens: 4096 };
  const input: EngineInput = {
    taskInput: 'Draft the punch list.',
    contextItems: [],
    primary: makeEngineAgent(primary, 'primary-1'),
    reviewer: reviewerAgent,
    perCallTimeoutMs: 5_000,
    runDeadline: Date.now() + 30_000,
    reviewRequired: true,
    ...extra,
  };
  return {
    steps,
    malformed,
    result: executeRun(input, {
      onStep: async (s) => {
        steps.push(s);
      },
      onMalformedOutput: async (_n, reasons) => {
        malformed.push([...reasons]);
      },
    }),
  };
}

describe('cut-off review', () => {
  it('is retried once with more output room; the real verdict then drives the revision; both calls billed', async () => {
    const primary = new FakeProvider('google');
    primary.reply(PRIMARY).reply('Punch list with the CFM math.');
    const { provider, requests } = scriptedReviewer([{ text: CUT, stop: 'max_tokens' }, { text: REVISE, stop: 'end_turn' }]);
    const r = run(provider, primary);
    const result = await r.result;

    expect(requests.map((q) => q.maxOutputTokens)).toEqual([4096, 16_384]);
    expect(r.malformed).toEqual([[CUT_OFF_REVIEW_RETRIED]]);
    const review = r.steps.find((s) => s.kind === 'review')!;
    expect(review.succeeded).toBe(true);
    expect(review.verdict).toBe('revise');
    expect(review.response!.usage.outputTokens).toBe(4096 + 16_384);
    expect(r.steps.map((s) => s.kind)).toEqual(['primary', 'review', 'revision', 'consolidate']);
    expect(result.reviewOutcome).toBe('reviewed');
  });

  it('cut off twice → a FAILED review step with an honest message (never "reject"), UNREVIEWED DRAFT', async () => {
    const primary = new FakeProvider('google');
    primary.reply(PRIMARY);
    const { provider, requests } = scriptedReviewer([{ text: CUT, stop: 'max_tokens' }, { text: CUT, stop: 'max_tokens' }]);
    const r = run(provider, primary);
    const result = await r.result;

    expect(requests).toHaveLength(2);
    const review = r.steps.find((s) => s.kind === 'review')!;
    expect(review.succeeded).toBe(false);
    expect(review.verdict).toBeNull();
    expect(review.errorMessage).toBe(CUT_OFF_REVIEW_MESSAGE);
    expect(result.reviewOutcome).toBe('required_unmet');
  });

  it('a complete verdict is never retried, even if the provider reports the limit', async () => {
    const primary = new FakeProvider('google');
    primary.reply(PRIMARY).reply('Revised.');
    const { provider, requests } = scriptedReviewer([{ text: REVISE, stop: 'max_tokens' }]);
    const r = run(provider, primary);
    await r.result;
    expect(requests).toHaveLength(1);
  });

  it('resume: a cut-off review checkpoint replays as the failed review — no provider call', async () => {
    const primary = new FakeProvider('google');
    const { provider, requests } = scriptedReviewer([]);
    const r = run(provider, primary, {
      resume: {
        loadCheckpoint: async (n) =>
          n === 1
            ? { provider: 'google', model: 'm', text: PRIMARY, inputTokens: 1, outputTokens: 1 }
            : n === 2
              ? { provider: 'anthropic', model: 'm', text: CUT, inputTokens: 1, outputTokens: 1 }
              : null,
        loadConclusiveFailure: async () => null,
        guardDispatch: async () => {},
      },
    });
    const result = await r.result;
    expect(requests).toHaveLength(0);
    expect(r.steps.find((s) => s.kind === 'review')!.errorMessage).toBe(CUT_OFF_REVIEW_MESSAGE);
    expect(result.reviewOutcome).toBe('required_unmet');
  });

  it('retry budget: double the cap, at least 16,384, at most 32,768', () => {
    expect(reviewRetryOutputTokens(1024)).toBe(16_384);
    expect(reviewRetryOutputTokens(4096)).toBe(16_384);
    expect(reviewRetryOutputTokens(16_384)).toBe(32_768);
    expect(reviewRetryOutputTokens(30_000)).toBe(32_768);
  });

  it('isCutOffReview: limit without a complete block, or an opened-never-closed block', () => {
    const r = (text: string, stopReason: string) => ({ provider: 'anthropic' as const, model: 'm', text, usage: { inputTokens: 0, outputTokens: 0 }, stopReason, latencyMs: 0 });
    expect(isCutOffReview(r(CUT, 'max_tokens'))).toBe(true);
    expect(isCutOffReview(r(CUT, 'stop'))).toBe(true); // replay / history: no stop reason, block never closed
    expect(isCutOffReview(r('Looks fine overall.', 'length'))).toBe(true);
    expect(isCutOffReview(r(REVISE, 'max_tokens'))).toBe(false);
    expect(isCutOffReview(r('Looks fine overall.', 'stop'))).toBe(false);
  });
});

describe('Review tab says "cut off", not "reject"', () => {
  const now = new Date('2026-10-22T12:13:00Z');
  const step = (over: Partial<RunStepRow>): RunStepRow => ({
    id: 'r', stepNumber: 2, kind: 'review', provider: 'anthropic', model: 'claude-sonnet-5', verdict: null, verdictDetail: null,
    succeeded: true, errorMessage: null, latencyMs: 45_216, effectivePromptHash: null, ...over,
  });
  const msg = (content: string): MessageRow => ({ id: 'm', runStepId: 'r', role: 'reviewer', provider: 'anthropic', model: 'claude-sonnet-5', content, createdAt: now });

  it('new runs: the failed step', () => {
    expect(summarizeReview([step({ succeeded: false, errorMessage: CUT_OFF_REVIEW_MESSAGE })], []).state).toBe('cut_off');
  });
  it('prod run 4afba522 as stored (fallback "reject", block opened and never closed)', () => {
    const s = summarizeReview([step({ verdict: 'reject', verdictDetail: { contractVersion: '2', verdict: 'reject', issues: [] } })], [msg(CUT)]);
    expect(s).toMatchObject({ state: 'cut_off', substantive: false });
    expect(s.headline).toContain('not a rejection');
  });
});
