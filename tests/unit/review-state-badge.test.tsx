import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ReviewStateBadge, type ReviewStateRun } from '@/app/p/[projectKey]/tasks/[taskId]/review-state-badge';

/**
 * Answer-routing Phase 1 — the review-state BADGE rendering, verified deterministically (the full-stack
 * Playwright flow lives in tests/e2e/review-mode.spec.ts and runs in CI where auth is configured). Proves each
 * outcome surfaces a clear label, that required_unmet is unmistakable, that a forced override is shown, and
 * that a legacy run (no recorded state) renders nothing rather than fabricating one.
 */

const base: ReviewStateRun = {
  requestedMode: 'reviewed',
  effectiveMode: 'reviewed',
  reviewRequired: true,
  reviewForced: false,
  reviewOutcome: 'reviewed',
};

const render = (run: ReviewStateRun) => renderToStaticMarkup(<ReviewStateBadge run={run} />);

describe('ReviewStateBadge', () => {
  it('reviewed → shows Reviewed, no unreviewed language', () => {
    const html = render(base);
    expect(html).toContain('Reviewed');
    expect(html).not.toContain('UNREVIEWED');
    expect(html).not.toContain('not been reviewed');
  });

  it('omitted (permitted Quick) → shows review-not-required', () => {
    const html = render({ requestedMode: 'quick', effectiveMode: 'quick', reviewRequired: false, reviewForced: false, reviewOutcome: 'omitted' });
    expect(html).toContain('review not required');
  });

  it('required_unmet → unmistakable unreviewed-draft badge + warning', () => {
    const html = render({ requestedMode: 'reviewed', effectiveMode: 'reviewed', reviewRequired: true, reviewForced: false, reviewOutcome: 'required_unmet' });
    expect(html).toContain('Unreviewed draft');
    expect(html).toContain('required review not completed');
    expect(html).toContain('NOT been reviewed');
  });

  it('optional_degraded → distinct from required_unmet (no unreviewed-draft language)', () => {
    const html = render({ requestedMode: 'reviewed', effectiveMode: 'reviewed', reviewRequired: false, reviewForced: false, reviewOutcome: 'optional_degraded' });
    expect(html).toContain('Optional review did not complete');
    expect(html).not.toContain('Unreviewed draft');
  });

  it('forced override → shown explicitly alongside the outcome', () => {
    const html = render({ requestedMode: 'quick', effectiveMode: 'reviewed', reviewRequired: true, reviewForced: true, reviewOutcome: 'reviewed' });
    expect(html).toContain('forced to Reviewed');
  });

  it('legacy run (all null) → renders nothing, never fabricates a state', () => {
    const html = render({ requestedMode: null, effectiveMode: null, reviewRequired: null, reviewForced: null, reviewOutcome: null });
    expect(html).toBe('');
  });
});
