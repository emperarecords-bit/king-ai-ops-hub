import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewComparison } from '@/app/p/[projectKey]/tasks/[taskId]/review-comparison';
import type { MessageRow, RunStepRow } from '@/domain/tasks/tasks';

const now = new Date('2026-08-07T12:00:00.000Z');
const step = (id: string, kind: RunStepRow['kind'], detail: RunStepRow['verdictDetail'] = null): RunStepRow => ({
  id, stepNumber: kind === 'primary' ? 1 : kind === 'review' ? 2 : 3, kind,
  provider: kind === 'review' ? 'anthropic' : 'openai', model: kind === 'review' ? 'claude-review' : 'gpt-primary',
  verdict: detail?.verdict ?? null, verdictDetail: detail, succeeded: true, errorMessage: null,
  latencyMs: 10, effectivePromptHash: null,
});
const message = (id: string, runStepId: string, content: string, role: MessageRow['role']): MessageRow => ({
  id, runStepId, content, role, provider: role === 'reviewer' ? 'anthropic' : 'openai',
  model: role === 'reviewer' ? 'claude-review' : 'gpt-primary', createdAt: now,
});

describe('ReviewComparison', () => {
  it('renders primary, trusted reviewer provenance, anchored findings, revision, and timestamp', () => {
    const detail = {
      contractVersion: '2' as const, verdict: 'revise' as const,
      provenance: {
        reviewerAgentId: 'reviewer-1', reviewerDisplayName: 'Original Reviewer', provider: 'anthropic' as const, model: 'claude-review',
        rubricHash: 'a'.repeat(64), rubricSnapshot: 'Require evidence.', executedAt: '2026-08-07T11:59:00.000Z',
      },
      issues: [{ severity: 'major' as const, summary: 'Unsupported claim', claimAnchor: 'claim-v1:p1:s1:0123456789ab', rationale: 'Evidence is absent.', requestedRevision: 'Qualify the claim.' }],
    };
    const html = renderToStaticMarkup(<ReviewComparison
      reviewerName="Risk Reviewer"
      steps={[step('p', 'primary'), step('r', 'review', detail), step('v', 'revision')]}
      messages={[message('m1', 'p', 'Primary claim.', 'assistant'), message('m2', 'r', 'Review.', 'reviewer'), message('m3', 'v', 'Qualified claim.', 'assistant')]}
    />);
    expect(html).toContain('Primary claim.');
    expect(html).toContain('Original Reviewer');
    expect(html).not.toContain('Risk Reviewer');
    expect(html).toContain('Require evidence.');
    expect(html).toContain('2026-08-07T11:59:00.000Z');
    expect(html).toContain('claim-v1:p1:s1:0123456789ab');
    expect(html).toContain('Evidence is absent.');
    expect(html).toContain('Qualify the claim.');
    expect(html).toContain('Qualified claim.');
    expect(html).toContain('2026-08-07 12:00 UTC');
    expect(html).not.toContain('dangerouslySetInnerHTML');
  });

  it('renders legacy and partially populated records without inventing anchors or revision content', () => {
    const legacy = { verdict: 'reject' as const, issues: [{ severity: 'critical' as const, summary: 'Legacy issue' }] };
    const html = renderToStaticMarkup(<ReviewComparison
      reviewerName={null}
      steps={[step('p', 'primary'), step('r', 'review', legacy)]}
      messages={[message('m1', 'p', 'Primary text.', 'assistant'), message('m2', 'r', '<script>alert(1)</script> long text', 'reviewer')]}
    />);
    expect(html).toContain('Legacy finding — no claim anchor');
    expect(html).toContain('Rejected by reviewer');
    expect(html).toContain('Legacy record');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    // No revision → the original is the Answer tab's result; it is NOT repeated here.
    expect(html).not.toContain('Primary text.');
    expect(html).not.toContain('Revised response');
  });

  it('an EMPTY reviewer reply recorded as "reject" (prod run 2db706f8) says no review happened — not a rejection', () => {
    const fallback = { contractVersion: '2' as const, verdict: 'reject' as const, issues: [] };
    const html = renderToStaticMarkup(<ReviewComparison
      reviewerName={null}
      steps={[step('p', 'primary'), step('r', 'review', fallback)]}
      messages={[message('m1', 'p', 'Punch list.', 'assistant'), message('m2', 'r', '', 'reviewer')]}
    />);
    expect(html).toContain('No review — reviewer replied empty');
    expect(html).toContain('not a real rejection');
    expect(html).not.toContain('Rejected by reviewer');
    expect(html).not.toContain('No specific findings');
    expect(html).not.toContain('Findings');
  });

  it('says plainly when the run had no review step', () => {
    expect(renderToStaticMarkup(<ReviewComparison reviewerName={null} steps={[step('p', 'primary')]} messages={[]} />)).toContain('No reviewer looked at this answer.');
  });
});
