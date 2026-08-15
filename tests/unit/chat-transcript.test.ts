import { describe, expect, it } from 'vitest';
import { buildChatTaskInput, buildTranscriptWindow } from '@/domain/chat/chat';

/**
 * Employee Chat (EV-004) — the pure transcript machinery. The window is the
 * cost-control: a long-lived thread must never grow the per-message prompt
 * unboundedly, and recency must win over completeness.
 */

const entry = (role: 'owner' | 'employee', content: string) => ({ role, content });

describe('buildTranscriptWindow', () => {
  it('renders roles as Owner/You, oldest first', () => {
    const w = buildTranscriptWindow([entry('owner', 'hi'), entry('employee', 'hello!'), entry('owner', 'status?')]);
    expect(w).toBe('Owner: hi\nYou: hello!\nOwner: status?');
  });

  it('empty thread renders empty', () => {
    expect(buildTranscriptWindow([])).toBe('');
  });

  it('drops OLDEST entries first when over the window, keeping the most recent intact', () => {
    const big = 'x'.repeat(3_000);
    const w = buildTranscriptWindow([
      entry('owner', 'FIRST ' + big),
      entry('employee', 'SECOND ' + big),
      entry('owner', 'THIRD ' + big),
      entry('employee', 'NEWEST reply'),
    ]);
    expect(w).not.toContain('FIRST');
    expect(w).toContain('SECOND');
    expect(w).toContain('THIRD');
    expect(w.endsWith('You: NEWEST reply')).toBe(true);
    expect(w.length).toBeLessThanOrEqual(8_001);
  });

  it('a single over-window entry yields an empty transcript rather than a truncated lie', () => {
    expect(buildTranscriptWindow([entry('owner', 'y'.repeat(9_000))])).toBe('');
  });
});

describe('buildChatTaskInput', () => {
  it('first message has no transcript block', () => {
    const input = buildChatTaskInput('', 'hello there');
    expect(input).toContain('Owner: hello there');
    expect(input).not.toContain('transcript so far');
  });

  it('follow-ups embed the transcript and the new message', () => {
    const input = buildChatTaskInput('Owner: hi\nYou: hello!', 'what is our status?');
    expect(input).toContain('Owner: hi\nYou: hello!');
    expect(input).toContain('Owner: what is our status?');
    expect(input).toContain('transcript so far');
  });
});
