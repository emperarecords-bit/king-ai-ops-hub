import { describe, expect, it } from 'vitest';
import { executeRun, type RunSink, type StepRecord } from '@/orchestration/engine';
import { FakeProvider, makeEngineAgent } from '@tests/support/fake-provider';
import { GOLDEN_TRANSCRIPTS, type ScriptedReply } from '@tests/golden/transcripts';

/**
 * Replays every golden transcript through the engine and pins:
 *  - the exact step sequence (the state machine's observable behavior)
 *  - verdict + structured issue extraction
 *  - action extraction and malformed-output reporting
 *  - the consolidated output, byte-for-byte, via snapshot
 *
 * If a change here is intentional, updating the snapshot is the reviewable
 * record of that decision. If it is not intentional, this suite is the alarm.
 */

function script(provider: FakeProvider, replies: readonly ScriptedReply[]): void {
  for (const r of replies) {
    if (typeof r === 'string') provider.reply(r);
    else provider.fail(r.fail);
  }
}

describe('golden transcripts', () => {
  for (const t of GOLDEN_TRANSCRIPTS) {
    it(t.name, async () => {
      const primary = new FakeProvider('openai');
      script(primary, t.primary);
      const reviewer = new FakeProvider('anthropic');
      if (t.reviewer) script(reviewer, t.reviewer);

      const steps: StepRecord[] = [];
      let malformedReports = 0;
      const sink: RunSink = {
        onStep: async (r) => {
          steps.push(r);
        },
        onMalformedOutput: async () => {
          malformedReports += 1;
        },
      };

      const result = await executeRun(
        {
          taskInput: t.taskInput,
          contextItems: [],
          primary: makeEngineAgent(primary, 'primary-1'),
          reviewer: t.reviewer ? makeEngineAgent(reviewer, 'reviewer-1') : null,
          perCallTimeoutMs: 5_000,
          runDeadline: Date.now() + 60_000,
        },
        sink,
      );

      expect(result.ok, 'run ok').toBe(t.expect.ok);
      expect(steps.map((s) => s.kind), 'step sequence').toEqual(t.expect.stepKinds);

      const reviewStep = steps.find((s) => s.kind === 'review') ?? null;
      expect(reviewStep?.verdict ?? null, 'verdict').toBe(t.expect.verdict);
      expect(
        reviewStep?.verdictDetail ? reviewStep.verdictDetail.issues.length : null,
        'issue count',
      ).toBe(t.expect.issueCount);

      expect(result.proposedActions, 'proposed actions').toHaveLength(t.expect.proposedActions);
      expect(malformedReports, 'malformed reports').toBe(t.expect.malformedReports);

      for (const needle of t.expect.consolidatedContains) {
        expect(result.consolidated, `consolidated contains "${needle}"`).toContain(needle);
      }
      for (const needle of t.expect.consolidatedOmits) {
        expect(result.consolidated, `consolidated omits "${needle}"`).not.toContain(needle);
      }

      // The byte-for-byte pin. A diff here is a behavior change by definition.
      await expect(result.consolidated).toMatchFileSnapshot(
        `../golden/__snapshots__/${t.name}.golden.txt`,
      );
    });
  }
});
