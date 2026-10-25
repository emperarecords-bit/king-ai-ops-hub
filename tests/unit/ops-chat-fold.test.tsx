import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LONG_REPLY_CHARS, startsCollapsed, stepsLine, summarizeSteps } from '@/app/ops/ops-chat-fold';
import { FoldableReply, StepsLine } from '@/app/ops/ops-chat-client';

// Owner request 2026-10-25 (layout part 3): fold tool steps into one line and collapse long answers.
const LABELS = { web_search: 'searching the web', list_tasks: 'listing tasks' };

describe('tool steps → one line', () => {
  it('groups by tool in first-use order and counts repeats', () => {
    const steps = [{ name: 'web_search' }, { name: 'list_tasks' }, { name: 'web_search' }, { name: 'mystery' }];
    expect(summarizeSteps(steps, LABELS)).toEqual([
      { label: 'searching the web', count: 2 },
      { label: 'listing tasks', count: 1 },
      { label: 'looking that up', count: 1 },
    ]);
    expect(stepsLine(steps, LABELS)).toBe('4 steps: searching the web ×2 · listing tasks · looking that up');
    expect(stepsLine([{ name: 'list_tasks' }], LABELS)).toBe('1 step: listing tasks');
    expect(stepsLine([], LABELS)).toBe('');
  });

  it('renders as a collapsed <details> with every step listed inside', () => {
    const html = renderToStaticMarkup(<StepsLine steps={[{ name: 'web_search' }, { name: 'web_search' }]} />);
    expect(html).toContain('<details data-testid="reply-steps"');
    expect(html).not.toContain('<details data-testid="reply-steps" open');
    expect(html).toContain('2 steps: searching the web ×2');
    expect((html.match(/<li>/g) ?? []).length).toBe(2);
  });
});

describe('long answers', () => {
  const long = 'x'.repeat(LONG_REPLY_CHARS + 1);

  it('only a finished reply over the limit starts collapsed', () => {
    expect(startsCollapsed(long, false)).toBe(true);
    expect(startsCollapsed(long, true)).toBe(false); // never while streaming
    expect(startsCollapsed('x'.repeat(LONG_REPLY_CHARS), false)).toBe(false);
  });

  it('a long finished reply renders collapsed with "Show full answer"; a short one renders in full', () => {
    const html = renderToStaticMarkup(<FoldableReply text={long} streaming={false} />);
    expect(html).toContain('data-testid="reply-collapsed"');
    expect(html).toContain('Show full answer (3k characters)');
    const short = renderToStaticMarkup(<FoldableReply text="A short **bold** answer." streaming={false} />);
    expect(short).not.toContain('reply-collapsed');
    expect(short).not.toContain('Show full answer');
    expect(short).toContain('<strong>bold</strong>');
  });

  it('the reply that is still streaming is never collapsed', () => {
    const html = renderToStaticMarkup(<FoldableReply text={long} streaming />);
    expect(html).not.toContain('reply-collapsed');
    expect(html).not.toContain('Show full answer');
  });
});
