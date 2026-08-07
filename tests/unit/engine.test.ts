import { describe, expect, it } from 'vitest';
import {
  AmbiguousProviderOutcomeSignal,
  consolidate,
  executeRun,
  MAX_RETRIES_PER_CALL,
  MAX_STEPS,
  type StepRecord,
} from '@/orchestration/engine';
import { FakeProvider, makeEngineAgent } from '@tests/support/fake-provider';

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

function input(primary: FakeProvider, reviewer: FakeProvider | null) {
  return {
    taskInput: 'Write a haiku about databases.',
    contextItems: [{ title: 'Charter', content: 'This project loves Postgres.' }],
    primary: makeEngineAgent(primary, 'primary-1'),
    reviewer: reviewer ? makeEngineAgent(reviewer, 'reviewer-1') : null,
    perCallTimeoutMs: 5_000,
    runDeadline: Date.now() + 30_000,
  };
}

describe('executeRun — state machine shape', () => {
  it('review disabled: primary then consolidate, 2 steps', async () => {
    const primary = new FakeProvider('openai');
    primary.reply('The haiku.');
    const { steps, sink } = collectingSink();

    const result = await executeRun(input(primary, null), sink);

    expect(result.ok).toBe(true);
    expect(steps.map((s) => s.kind)).toEqual(['primary', 'consolidate']);
    expect(result.consolidated).toContain('The haiku.');
    expect(primary.requests).toHaveLength(1);
  });

  it('approve verdict: no revision — 3 steps', async () => {
    const primary = new FakeProvider('openai');
    const reviewer = new FakeProvider('anthropic');
    primary.reply('Draft.');
    reviewer.reply('VERDICT: approve\nSolid.');
    const { steps, sink } = collectingSink();

    const result = await executeRun(input(primary, reviewer), sink);

    expect(steps.map((s) => s.kind)).toEqual(['primary', 'review', 'consolidate']);
    expect(result.consolidated).toContain('Draft.');
    expect(result.consolidated).toContain('approve');
    expect(primary.requests).toHaveLength(1); // no revision call
  });

  it('revise verdict: exactly one revision — 4 steps, never more', async () => {
    const primary = new FakeProvider('openai');
    const reviewer = new FakeProvider('anthropic');
    primary.reply('Draft.').reply('Revised draft.');
    // Reviewer demands revision — and would demand it forever if asked again.
    reviewer.reply('VERDICT: revise\nFix the syllables.');
    const { steps, sink } = collectingSink();

    const result = await executeRun(input(primary, reviewer), sink);

    expect(steps.map((s) => s.kind)).toEqual(['primary', 'review', 'revision', 'consolidate']);
    expect(steps.length).toBeLessThanOrEqual(MAX_STEPS);
    expect(result.consolidated).toContain('Revised draft.');
    // The reviewer is consulted exactly once — no re-review loop exists.
    expect(reviewer.requests).toHaveLength(1);
    expect(primary.requests).toHaveLength(2);
  });

  it('reject verdict: no revision, result flagged', async () => {
    const primary = new FakeProvider('openai');
    const reviewer = new FakeProvider('anthropic');
    primary.reply('Bad draft.');
    reviewer.reply('VERDICT: reject\nFundamentally wrong.');
    const { steps, sink } = collectingSink();

    const result = await executeRun(input(primary, reviewer), sink);

    expect(steps.map((s) => s.kind)).toEqual(['primary', 'review', 'consolidate']);
    expect(result.consolidated).toContain('caution');
  });
});

describe('executeRun — failure handling', () => {
  it('primary failure fails the run and records the step', async () => {
    const primary = new FakeProvider('openai');
    primary.fail('auth');
    const { steps, sink } = collectingSink();

    const result = await executeRun(input(primary, null), sink);

    expect(result.ok).toBe(false);
    expect(result.failureReason).toContain('Primary model call failed');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.succeeded).toBe(false);
  });

  it('retries retryable errors, then succeeds', async () => {
    const primary = new FakeProvider('openai');
    primary.fail('rate_limited').reply('Recovered.');
    const { sink } = collectingSink();

    const result = await executeRun(input(primary, null), sink);

    expect(result.ok).toBe(true);
    expect(primary.requests).toHaveLength(2);
  });

  it('does not retry non-retryable errors', async () => {
    const primary = new FakeProvider('openai');
    primary.fail('invalid_request').reply('Should never be reached.');
    const { sink } = collectingSink();

    const result = await executeRun(input(primary, null), sink);

    expect(result.ok).toBe(false);
    expect(primary.requests).toHaveLength(1);
  });

  it('review failure degrades gracefully: primary result still delivered', async () => {
    const primary = new FakeProvider('openai');
    const reviewer = new FakeProvider('anthropic');
    primary.reply('Primary result.');
    reviewer.fail('auth');
    const { steps, sink } = collectingSink();

    const result = await executeRun(input(primary, reviewer), sink);

    expect(result.ok).toBe(true);
    expect(result.consolidated).toContain('Primary result.');
    expect(steps.find((s) => s.kind === 'review')!.succeeded).toBe(false);
    // No revision without a successful review.
    expect(steps.map((s) => s.kind)).toEqual(['primary', 'review', 'consolidate']);
  });

  it('a KNOWN revision failure (pre-processing rejection) falls back to the primary text', async () => {
    const primary = new FakeProvider('openai');
    const reviewer = new FakeProvider('anthropic');
    // The revision call is cleanly REJECTED before the model ran (invalid_request = provably not executed):
    // a KNOWN failure, so the engine degrades to the primary text (an AMBIGUOUS failure would escalate).
    primary.reply('Original.').fail('invalid_request');
    reviewer.reply('VERDICT: revise\nDo better.');
    const { sink } = collectingSink();

    const result = await executeRun(input(primary, reviewer), sink);

    expect(result.ok).toBe(true);
    expect(result.consolidated).toContain('Original.');
  });
});

describe('callWithRetry — ambiguous vs known provider-outcome classification', () => {
  it('an AMBIGUOUS timeout is NEVER retried and escalates as a reliability signal (call count stays 1)', async () => {
    const primary = new FakeProvider('openai');
    // timeout = the request was transmitted but the outcome is unknown (may have executed + charged).
    primary.fail('timeout').reply('should never be reached');
    const { sink } = collectingSink();

    await expect(executeRun(input(primary, null), sink)).rejects.toBeInstanceOf(AmbiguousProviderOutcomeSignal);
    expect(primary.requests).toHaveLength(1); // no in-process retry of an ambiguous outcome
  });

  it('an AMBIGUOUS generic 5xx (overloaded, no explicit not_executed) escalates and is not retried', async () => {
    const primary = new FakeProvider('openai');
    // The fake maps overloaded → remoteOutcome 'unknown' (a generic 5xx may post-date execution).
    primary.fail('overloaded').reply('should never be reached');
    const { sink } = collectingSink();

    await expect(executeRun(input(primary, null), sink)).rejects.toBeInstanceOf(AmbiguousProviderOutcomeSignal);
    expect(primary.requests).toHaveLength(1);
  });

  it('a KNOWN retryable rejection (rate_limited) retries within bounds, then recovers', async () => {
    const primary = new FakeProvider('openai');
    primary.fail('rate_limited').reply('recovered');
    const { sink } = collectingSink();

    const result = await executeRun(input(primary, null), sink);
    expect(result.ok).toBe(true);
    expect(result.consolidated).toContain('recovered');
    expect(primary.requests).toHaveLength(2); // one retry, bounded
  });

  it('an unsupported not_executed claim fails closed to reconciliation and is never retried', async () => {
    const primary = new FakeProvider('openai').withoutAuthoritativeNotExecutedProof();
    primary.fail('rate_limited').reply('duplicate effect if reached');
    const { sink } = collectingSink();

    await expect(executeRun(input(primary, null), sink)).rejects.toBeInstanceOf(AmbiguousProviderOutcomeSignal);
    expect(primary.requests).toHaveLength(1);
  });

  it('a KNOWN retryable rejection that exhausts the bounded retries becomes a normal failed step (not reconciliation)', async () => {
    const primary = new FakeProvider('openai');
    for (let i = 0; i <= MAX_RETRIES_PER_CALL; i += 1) primary.fail('rate_limited');
    const { sink } = collectingSink();

    // A KNOWN not-executed failure never escalates to the ambiguous signal — it degrades to a failed step.
    const result = await executeRun(input(primary, null), sink);
    expect(result.ok).toBe(false);
    expect(primary.requests).toHaveLength(MAX_RETRIES_PER_CALL + 1); // bounded, not unbounded
  });
});

describe('executeRun — untrusted content handling', () => {
  it('wraps context and task in untrusted delimiters', async () => {
    const primary = new FakeProvider('openai');
    primary.reply('done');
    const { sink } = collectingSink();

    await executeRun(input(primary, null), sink);

    const sent = primary.requests[0]!.turns[0]!.content;
    expect(sent).toContain('<untrusted-context>');
    expect(sent).toContain('This project loves Postgres.');
    expect(sent).toContain('Write a haiku about databases.');
  });

  it('extracts valid proposed actions into pending proposals', async () => {
    const primary = new FakeProvider('openai');
    primary.reply(
      'Done.\n```proposed-actions\n[{"type":"git_commit","summary":"Commit it","payload":{}}]\n```',
    );
    const { sink } = collectingSink();

    const result = await executeRun(input(primary, null), sink);

    expect(result.proposedActions).toHaveLength(1);
    expect(result.proposedActions[0]!.type).toBe('git_commit');
    // The action block is stripped from what the user reads.
    expect(result.consolidated).not.toContain('proposed-actions');
  });

  it('reports malformed action output instead of failing the run', async () => {
    const primary = new FakeProvider('openai');
    primary.reply('Done.\n```proposed-actions\n[{"type":"rm_rf_root","summary":"x","payload":{}}]\n```');
    const { malformed, sink } = collectingSink();

    const result = await executeRun(input(primary, null), sink);

    expect(result.ok).toBe(true);
    expect(result.proposedActions).toHaveLength(0);
    expect(malformed).toHaveLength(1);
  });

  it('takes actions from the final (revised) text only — a rejected draft cannot smuggle actions', async () => {
    const primary = new FakeProvider('openai');
    const reviewer = new FakeProvider('anthropic');
    primary
      .reply('Draft.\n```proposed-actions\n[{"type":"destructive","summary":"Drop it all","payload":{}}]\n```')
      .reply('Revised, no actions needed.');
    reviewer.reply('VERDICT: revise\nThe proposed action is dangerous and unnecessary.');
    const { sink } = collectingSink();

    const result = await executeRun(input(primary, reviewer), sink);

    expect(result.proposedActions).toHaveLength(0);
  });
});

describe('consolidate', () => {
  it('is deterministic', () => {
    const args = {
      primaryText: 'A',
      reviewText: 'VERDICT: approve\nGood.',
      verdict: 'approve' as const,
      revisionText: null,
    };
    expect(consolidate(args)).toBe(consolidate(args));
  });

  it('prefers the revision when present', () => {
    expect(
      consolidate({ primaryText: 'A', reviewText: 'r', verdict: 'revise', revisionText: 'B' }),
    ).toContain('B');
  });
});
