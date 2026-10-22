import { describe, expect, it } from 'vitest';
import {
  combineResponses,
  EMPTY_REVIEW_MESSAGE,
  EMPTY_REVIEW_RETRIED,
  EMPTY_REVIEW_RETRY_FAILED,
  executeRun,
  MAX_STEPS,
  type EngineInput,
  type StepRecord,
} from '@/orchestration/engine';
import { FakeProvider, makeEngineAgent } from '@tests/support/fake-provider';

/**
 * Hub prod 2026-10-22, run 2db706f8: the required reviewer returned an EMPTY reply (0 characters after 46s). It
 * was parsed as a malformed "reject" with no findings, so the task page said "reject · No claim findings were
 * raised". Now an empty reply is retried ONCE inside the same step (billed for both calls, still ≤ MAX_STEPS),
 * and if it is empty again the review step is recorded as FAILED with an honest message — never a "reject".
 */

const APPROVE = '```review-result\n{"verdict":"approve","findings":[]}\n```';

function collectingSink() {
  const steps: StepRecord[] = [];
  const malformed: string[][] = [];
  return {
    steps,
    malformed,
    sink: {
      onStep: async (s: StepRecord) => {
        steps.push(s);
      },
      onMalformedOutput: async (_n: number, reasons: readonly string[]) => {
        malformed.push([...reasons]);
      },
    },
  };
}

function input(primary: FakeProvider, reviewer: FakeProvider, extra: Partial<EngineInput> = {}): EngineInput {
  return {
    taskInput: 'Draft the punch list.',
    contextItems: [],
    primary: makeEngineAgent(primary, 'primary-1'),
    reviewer: makeEngineAgent(reviewer, 'reviewer-1'),
    perCallTimeoutMs: 5_000,
    runDeadline: Date.now() + 30_000,
    reviewRequired: true,
    ...extra,
  };
}

describe('empty reviewer reply', () => {
  it('is retried once; a real verdict on the retry is a normal review, billed for BOTH calls in one step', async () => {
    const primary = new FakeProvider('google');
    const reviewer = new FakeProvider('anthropic');
    primary.reply('Punch list.');
    reviewer.reply('   \n').reply(APPROVE);
    const { steps, malformed, sink } = collectingSink();

    const result = await executeRun(input(primary, reviewer), sink);

    expect(reviewer.requests).toHaveLength(2);
    expect(steps.map((s) => s.kind)).toEqual(['primary', 'review', 'consolidate']);
    expect(steps.length).toBeLessThanOrEqual(MAX_STEPS);
    const review = steps.find((s) => s.kind === 'review')!;
    expect(review.succeeded).toBe(true);
    expect(review.verdict).toBe('approve');
    expect(review.response!.usage).toEqual({ inputTokens: 200, outputTokens: 100 }); // both calls billed
    expect(malformed).toEqual([[EMPTY_REVIEW_RETRIED]]);
    expect(result.reviewOutcome).toBe('reviewed');
  });

  it('empty twice → a FAILED review step (no "reject" verdict), billed, and an honest UNREVIEWED DRAFT', async () => {
    const primary = new FakeProvider('google');
    const reviewer = new FakeProvider('anthropic');
    primary.reply('Punch list.');
    reviewer.reply('').reply('');
    const { steps, sink } = collectingSink();

    const result = await executeRun(input(primary, reviewer), sink);

    expect(reviewer.requests).toHaveLength(2); // exactly one retry, never a loop
    const review = steps.find((s) => s.kind === 'review')!;
    expect(review.succeeded).toBe(false);
    expect(review.verdict).toBeNull();
    expect(review.verdictDetail).toBeNull();
    expect(review.errorMessage).toBe(EMPTY_REVIEW_MESSAGE);
    expect(review.response!.usage).toEqual({ inputTokens: 200, outputTokens: 100 });
    expect(steps.map((s) => s.kind)).toEqual(['primary', 'review', 'consolidate']); // no revision
    expect(result.reviewOutcome).toBe('required_unmet');
    expect(result.consolidated).toContain('UNREVIEWED DRAFT');
    expect(result.consolidated).toContain('Punch list.');
  });

  it('empty, then the retry fails cleanly → failed step that still carries (bills) the first call', async () => {
    const primary = new FakeProvider('google');
    const reviewer = new FakeProvider('anthropic');
    primary.reply('Punch list.');
    reviewer.reply('').fail('auth');
    const { steps, sink } = collectingSink();

    const result = await executeRun(input(primary, reviewer), sink);

    const review = steps.find((s) => s.kind === 'review')!;
    expect(review.succeeded).toBe(false);
    expect(review.errorMessage!.startsWith(EMPTY_REVIEW_RETRY_FAILED)).toBe(true);
    expect(review.response!.usage).toEqual({ inputTokens: 100, outputTokens: 50 });
    expect(result.reviewOutcome).toBe('required_unmet');
  });

  it('a non-empty reply is never retried', async () => {
    const primary = new FakeProvider('google');
    const reviewer = new FakeProvider('anthropic');
    primary.reply('Punch list.');
    reviewer.reply(APPROVE);
    const { sink, malformed } = collectingSink();

    await executeRun(input(primary, reviewer), sink);

    expect(reviewer.requests).toHaveLength(1);
    expect(malformed).toEqual([]);
  });

  it('resume: an EMPTY review checkpoint is replayed as the failed review — no provider call, no retry', async () => {
    const primary = new FakeProvider('google');
    const reviewer = new FakeProvider('anthropic');
    const dispatched: number[] = [];
    const { steps, sink } = collectingSink();

    const result = await executeRun(
      input(primary, reviewer, {
        resume: {
          loadCheckpoint: async (n) =>
            n === 1
              ? { provider: 'google', model: 'fake-model', text: 'Punch list.', inputTokens: 1, outputTokens: 1 }
              : n === 2
                ? { provider: 'anthropic', model: 'fake-model', text: '', inputTokens: 1, outputTokens: 1 }
                : null,
          loadConclusiveFailure: async () => null,
          guardDispatch: async (n) => {
            dispatched.push(n);
          },
        },
      }),
      sink,
    );

    expect(primary.requests).toHaveLength(0);
    expect(reviewer.requests).toHaveLength(0);
    expect(dispatched).toEqual([]);
    expect(steps.find((s) => s.kind === 'review')!.succeeded).toBe(false);
    expect(result.reviewOutcome).toBe('required_unmet');
  });

  it('combineResponses keeps the second text and sums usage + latency', () => {
    const a = { provider: 'anthropic' as const, model: 'm', text: '', usage: { inputTokens: 10, outputTokens: 0 }, stopReason: 'stop', latencyMs: 46_000 };
    const b = { ...a, text: 'ok', usage: { inputTokens: 12, outputTokens: 30 }, latencyMs: 2_000 };
    expect(combineResponses(a, b)).toEqual({ ...b, usage: { inputTokens: 22, outputTokens: 30 }, latencyMs: 48_000 });
  });
});
