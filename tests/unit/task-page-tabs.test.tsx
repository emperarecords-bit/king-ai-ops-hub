import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseTaskTab, TaskTabNav, taskTabHref } from '@/app/p/[projectKey]/tasks/[taskId]/task-tabs';
import { summarizeReview } from '@/domain/tasks/review-summary';
import { EMPTY_REVIEW_MESSAGE } from '@/orchestration/engine';
import type { MessageRow, RunStepRow } from '@/domain/tasks/tasks';

/**
 * Owner feedback 2026-10-22 on the task page: "confusing… jumbled". One answer, shown once (Answer tab); what the
 * review actually was (Review tab); the steps, context and raw conversation (How it was made).
 */

const now = new Date('2026-10-22T02:00:00.000Z');
const step = (id: string, kind: RunStepRow['kind'], over: Partial<RunStepRow> = {}): RunStepRow => ({
  id,
  stepNumber: kind === 'primary' ? 1 : kind === 'review' ? 2 : 3,
  kind,
  provider: kind === 'review' ? 'anthropic' : 'google',
  model: 'm',
  verdict: null,
  verdictDetail: null,
  succeeded: true,
  errorMessage: null,
  latencyMs: 10,
  effectivePromptHash: null,
  ...over,
});
const msg = (stepId: string, content: string, role: MessageRow['role'] = 'reviewer'): MessageRow => ({
  id: `m-${stepId}`, runStepId: stepId, role, provider: 'anthropic', model: 'm', content, createdAt: now,
});
const v2 = (verdict: 'approve' | 'revise' | 'reject', issues: NonNullable<RunStepRow['verdictDetail']>['issues'] = []) =>
  ({ contractVersion: '2' as const, verdict, issues });
const finding = { severity: 'major' as const, summary: 'x', claimAnchor: 'claim-v1:a', rationale: 'Missing CFM calc.' };
const block = (verdict: string) => `\`\`\`review-result\n{"verdict":"${verdict}","findings":[]}\n\`\`\``;

describe('task tabs', () => {
  it('parses the tab param, defaulting to Answer', () => {
    expect(parseTaskTab(undefined)).toBe('answer');
    expect(parseTaskTab('review')).toBe('review');
    expect(parseTaskTab('how')).toBe('how');
    expect(parseTaskTab('../../etc')).toBe('answer');
  });
  it('links each tab; Answer is the bare task path', () => {
    expect(taskTabHref('/p/hvac/tasks/t1', 'answer')).toBe('/p/hvac/tasks/t1');
    expect(taskTabHref('/p/hvac/tasks/t1', 'review')).toBe('/p/hvac/tasks/t1?tab=review');
    const html = renderToStaticMarkup(<TaskTabNav basePath="/p/hvac/tasks/t1" active="review" reviewNote="No review — reviewer replied empty" />);
    expect(html).toContain('Answer');
    expect(html).toContain('How it was made');
    expect(html).toMatch(/aria-current="page"[^>]*>Review/);
    expect(html).toContain('No review — reviewer replied empty');
  });
});

describe('summarizeReview', () => {
  it('no review step', () => {
    expect(summarizeReview([step('p', 'primary')], []).state).toBe('none');
  });
  it('new runs: an empty reply recorded as a failed step', () => {
    const s = summarizeReview([step('p', 'primary'), step('r', 'review', { succeeded: false, errorMessage: EMPTY_REVIEW_MESSAGE })], []);
    expect(s).toMatchObject({ state: 'empty', substantive: false });
  });
  it('historical runs: the "reject" fallback over an empty or unreadable reply is NOT a rejection', () => {
    const r = step('r', 'review', { verdict: 'reject', verdictDetail: v2('reject') });
    expect(summarizeReview([step('p', 'primary'), r], [msg('r', '')]).state).toBe('empty');
    expect(summarizeReview([step('p', 'primary'), r], [msg('r', 'Looks fine to me overall.')]).state).toBe('unreadable');
  });
  it('a real reject, with or without findings', () => {
    const withFindings = step('r', 'review', { verdict: 'reject', verdictDetail: v2('reject', [finding]) });
    expect(summarizeReview([withFindings], [msg('r', block('reject'))])).toMatchObject({ state: 'rejected', substantive: true });
    const bare = step('r', 'review', { verdict: 'reject', verdictDetail: v2('reject') });
    expect(summarizeReview([bare], [msg('r', block('reject'))]).headline).toContain('without giving specific findings');
  });
  it('approve / revised / changes requested without a revision / provider failure', () => {
    const ap = step('r', 'review', { verdict: 'approve', verdictDetail: v2('approve') });
    expect(summarizeReview([ap], [msg('r', block('approve'))]).state).toBe('approved');
    const rv = step('r', 'review', { verdict: 'revise', verdictDetail: v2('revise', [finding]) });
    expect(summarizeReview([rv, step('v', 'revision')], [msg('r', block('revise'))]).state).toBe('revised');
    expect(summarizeReview([rv], [msg('r', block('revise'))]).state).toBe('changes_requested');
    const failed = step('r', 'review', { succeeded: false, errorMessage: 'fake auth' });
    expect(summarizeReview([failed], [])).toMatchObject({ state: 'failed', substantive: false });
    expect(summarizeReview([failed], []).headline).toContain('fake auth');
  });
});
