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
      provenance: { reviewerAgentId: 'reviewer-1', provider: 'anthropic' as const, model: 'claude-review' },
      issues: [{ severity: 'major' as const, summary: 'Unsupported claim', claimAnchor: 'claim-v1:p1:s1:0123456789ab', rationale: 'Evidence is absent.', requestedRevision: 'Qualify the claim.' }],
    };
    const html = renderToStaticMarkup(<ReviewComparison
      reviewerName="Risk Reviewer"
      steps={[step('p', 'primary'), step('r', 'review', detail), step('v', 'revision')]}
      messages={[message('m1', 'p', 'Primary claim.', 'assistant'), message('m2', 'r', 'Review.', 'reviewer'), message('m3', 'v', 'Qualified claim.', 'assistant')]}
    />);
    expect(html).toContain('Primary claim.');
    expect(html).toContain('Risk Reviewer');
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
      messages={[message('m1', 'p', '<script>alert(1)</script> long text', 'assistant')]}
    />);
    expect(html).toContain('Legacy finding — no claim anchor');
    expect(html).toContain('Not recorded for this historical run.');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('renders nothing when the run has no review step', () => {
    expect(renderToStaticMarkup(<ReviewComparison reviewerName={null} steps={[step('p', 'primary')]} messages={[]} />)).toBe('');
  });
});
