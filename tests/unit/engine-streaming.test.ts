import { describe, expect, it } from 'vitest';
import { AmbiguousProviderOutcomeSignal, executeRun, type RunSink, type StepRecord } from '@/orchestration/engine';
import { type StepKind } from '@/types/domain';
import { type FakeProvider, makeEngineAgent } from '@tests/support/fake-provider';
import { FakeStreamingProvider } from '@tests/support/fake-streaming-provider';

function collectingSink() {
  const steps: StepRecord[] = [];
  const deltas: Array<{ kind: StepKind; text: string }> = [];
  const malformed: string[][] = [];
  const sink: RunSink = {
    onStep: async (r) => {
      steps.push(r);
    },
    onMalformedOutput: async (_n, reasons) => {
      malformed.push([...reasons]);
    },
    onDelta: (kind, text) => {
      deltas.push({ kind, text });
    },
  };
  return { sink, steps, deltas, malformed };
}

const baseInput = (primaryProvider: FakeProvider, reviewerProvider: FakeProvider | null) => ({
  taskInput: 'Do the thing.',
  contextItems: [],
  primary: makeEngineAgent(primaryProvider, 'primary-1'),
  reviewer: reviewerProvider ? makeEngineAgent(reviewerProvider, 'reviewer-1') : null,
  perCallTimeoutMs: 5_000,
  runDeadline: Date.now() + 30_000,
});

describe('engine streaming', () => {
  it('forwards deltas per step and the final response matches the accumulated text', async () => {
    const primary = new FakeStreamingProvider('openai');
    primary.reply('hello streamed world');
    const reviewer = new FakeStreamingProvider('anthropic');
    reviewer.reply('VERDICT: approve\n\nFine.');

    const { sink, steps, deltas } = collectingSink();
    const result = await executeRun(baseInput(primary, reviewer), sink);

    expect(result.ok).toBe(true);
    const primaryDeltas = deltas.filter((d) => d.kind === 'primary');
    expect(primaryDeltas.map((d) => d.text).join('')).toBe('hello streamed world');
    const reviewDeltas = deltas.filter((d) => d.kind === 'review');
    expect(reviewDeltas.length).toBeGreaterThan(0);

    const primaryStep = steps.find((s) => s.kind === 'primary');
    expect(primaryStep?.response?.text).toBe('hello streamed world');
  });

  it('without an onDelta sink, execute() is used and no streaming occurs', async () => {
    const primary = new FakeStreamingProvider('openai');
    primary.reply('plain');
    const { steps } = await (async () => {
      const steps: StepRecord[] = [];
      const sink: RunSink = {
        onStep: async (r) => {
          steps.push(r);
        },
        onMalformedOutput: async () => {},
      };
      await executeRun(baseInput(primary, null), sink);
      return { steps };
    })();
    expect(steps.find((s) => s.kind === 'primary')?.response?.text).toBe('plain');
  });

  it('a retryable error BEFORE any output still retries', async () => {
    const primary = new FakeStreamingProvider('openai');
    primary.fail('rate_limited').reply('recovered');
    const { sink, steps } = collectingSink();

    const result = await executeRun(baseInput(primary, null), sink);
    expect(result.ok).toBe(true);
    expect(steps.find((s) => s.kind === 'primary')?.response?.text).toBe('recovered');
  });

  it('a retryable error MID-STREAM does not retry and escalates as AMBIGUOUS — partial output already reached the observer', async () => {
    const primary = new FakeStreamingProvider('openai');
    primary.failMidStream('rate_limited');
    primary.reply('should never be used');
    const { sink, deltas } = collectingSink();

    // The provider BEGAN responding (partial stream) → a started-remote outcome that is AMBIGUOUS regardless of
    // the error kind: never retried, never a normal failed step. The engine escalates so the run fails closed
    // to reconciliation (the runner maps this to reconciliation_required).
    await expect(executeRun(baseInput(primary, null), sink)).rejects.toBeInstanceOf(AmbiguousProviderOutcomeSignal);
    // The two partial deltas arrived, and no retried duplicate followed them.
    expect(deltas.filter((d) => d.kind === 'primary')).toHaveLength(2);
    // Only the single request was made (no retry).
    expect(primary.requests).toHaveLength(1);
  });
});
