import transcripts from '@tests/fixtures/review-transcripts.json';
import { describe, expect, it } from 'vitest';
import { executeRun, type EngineInput, type StepRecord } from '@/orchestration/engine';
import type { ReviewVerdict, StepKind } from '@/types/domain';
import { FakeProvider } from '@tests/support/fake-provider';
import { anchorReviewClaims } from '@/orchestration/prompts';

interface GoldenTranscript {
  name: string;
  primary: string;
  review: string;
  revision?: string;
  expectedVerdict: ReviewVerdict;
  expectedKinds: StepKind[];
  expectedIssues: number;
}

function input(primary: FakeProvider, reviewer: FakeProvider): EngineInput {
  return {
    taskInput: 'Assess the supplied business statement.',
    contextItems: [],
    primary: {
      agentId: 'primary-agent', provider: primary, model: 'golden-primary',
      systemPrompt: 'Answer using supplied evidence.', temperature: 0, maxOutputTokens: 500,
    },
    reviewer: {
      agentId: 'reviewer-agent', provider: reviewer, model: 'golden-reviewer',
      systemPrompt: 'Review evidence and safety.', temperature: 0, maxOutputTokens: 500,
    },
    perCallTimeoutMs: 1_000,
    runDeadline: Date.now() + 30_000,
  };
}

describe('golden cross-provider review transcripts', () => {
  for (const transcript of transcripts as GoldenTranscript[]) {
    it(transcript.name, async () => {
      const primary = new FakeProvider('openai').reply(transcript.primary);
      if (transcript.revision) primary.reply(transcript.revision);
      const anchor = anchorReviewClaims(transcript.primary)[0]!.anchor;
      const reviewer = new FakeProvider('anthropic').reply(transcript.review.replaceAll('$CLAIM_1', anchor));
      const recorded: StepRecord[] = [];

      const result = await executeRun(input(primary, reviewer), {
        onStep: async (step) => { recorded.push(step); },
        onMalformedOutput: async () => undefined,
      });

      const review = recorded.find((step) => step.kind === 'review');
      expect(result.ok).toBe(true);
      expect(recorded.map((step) => step.kind)).toEqual(transcript.expectedKinds);
      expect(review?.verdict).toBe(transcript.expectedVerdict);
      expect(review?.verdictDetail?.issues).toHaveLength(transcript.expectedIssues);
      expect(reviewer.requests).toHaveLength(1);
      expect(primary.requests).toHaveLength(transcript.expectedVerdict === 'revise' ? 2 : 1);
      expect(result.consolidated).toMatchSnapshot();
    });
  }
});
