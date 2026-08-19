import { describe, expect, it } from 'vitest';
import {
  HQ_QUESTIONS_BLOCK_OPEN,
  HQ_QUESTION_RULES,
  MAX_HQ_QUESTIONS_PER_RUN,
  extractHqQuestions,
  extractOwnerQuestions,
} from '@/orchestration/questions-block';

/** Ask-HQ — extraction hygiene and audience separation from owner questions. */

const block = (json: string) => `Cycle done.\n${HQ_QUESTIONS_BLOCK_OPEN}\n${json}\n\`\`\`\n`;

describe('ask-hq extraction', () => {
  it('extracts valid questions, last block wins, cap enforced', () => {
    const text =
      block('["Old question that is long enough?"]') +
      block('["Does Kingdom Core have spare render capacity this week for our test batch?", "What is AccurateBids launch status?", "A third question that exceeds the cap entirely?"]');
    const r = extractHqQuestions(text);
    expect(r.questions).toHaveLength(MAX_HQ_QUESTIONS_PER_RUN);
    expect(r.questions[0]).toContain('render capacity');
    expect(r.rejected.some((x) => x.includes('only the first'))).toBe(true);
  });

  it('malformed blocks are reported, never repaired', () => {
    expect(extractHqQuestions(block('not json')).questions).toHaveLength(0);
    expect(extractHqQuestions(block('{"a":1}')).questions).toHaveLength(0);
    expect(extractHqQuestions(block('["short"]')).questions).toHaveLength(0);
    expect(extractHqQuestions(`${HQ_QUESTIONS_BLOCK_OPEN}\n["never closed`).rejected[0]).toMatch(/Unterminated/);
    expect(extractHqQuestions('no block at all').questions).toHaveLength(0);
  });

  it('hq and owner fences never bleed into each other', () => {
    const text =
      'Report.\n```owner-questions\n["What budget do you want for the launch event, owner?"]\n```\n' +
      block('["Which sister business already solved OAuth token refresh?"]');
    expect(extractOwnerQuestions(text).questions[0]).toContain('budget');
    expect(extractHqQuestions(text).questions[0]).toContain('OAuth');
  });

  it('the GM rules route audiences explicitly', () => {
    expect(HQ_QUESTION_RULES).toContain('Chief of Staff');
    expect(HQ_QUESTION_RULES).toContain(HQ_QUESTIONS_BLOCK_OPEN);
    expect(HQ_QUESTION_RULES).toContain('ONLY the owner');
  });
});
