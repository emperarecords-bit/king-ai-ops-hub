import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { prettyJson, splitResult } from '@/domain/tasks/result-view';
import { SafeMarkdown } from '@/components/safe-markdown';
import { ReviewStateBadge } from '@/app/p/[projectKey]/tasks/[taskId]/review-state-badge';
import { UNREVIEWED_DRAFT_BANNER } from '@/orchestration/engine';

/**
 * Hub prod 2026-10-22 — the server-cooling task's Answer tab (v95): the result was raw markdown in a monospace box,
 * the unreviewed warning appeared three times (badge, review line, in-text banner), and the punch list deliverable
 * was a raw ```artifact JSON blob. Display only — the stored result is unchanged.
 */

const ARTIFACT = {
  name: 'Dual FUSION-TEC Punch List (Rev G)',
  kind: 'markdown',
  content: '# Punch List: Dual FUSION-TEC Server Cooling (L-Formation)\n\n## 1. Structural Requirements\n- **Wall Design:** Freestanding.',
};
const REPORT = '### RESEARCH REPORT: Dual FUSION-TEC Server Cooling Punch List (Rev G)\n\n**1. Question**\nProduce a finalized punch list.';
const STORED = `${UNREVIEWED_DRAFT_BANNER}\n\n${REPORT}\n\n\`\`\`artifact\n${JSON.stringify(ARTIFACT)}\n\`\`\``;

describe('splitResult', () => {
  it('prod shape: banner hidden (the badge says it), the artifact lifted out as a titled document', () => {
    const v = splitResult(STORED, { hideDraftBanner: true });
    expect(v.bannerHidden).toBe(true);
    expect(v.body).toBe(REPORT);
    expect(v.documents).toEqual([ARTIFACT]);
  });
  it('keeps the banner when the page is NOT showing the unmet-review badge', () => {
    const v = splitResult(STORED, { hideDraftBanner: false });
    expect(v.body.startsWith(UNREVIEWED_DRAFT_BANNER)).toBe(true);
    expect(v.bannerHidden).toBe(false);
  });
  it('a malformed artifact block stays in the text (never silently dropped)', () => {
    const bad = `${REPORT}\n\n\`\`\`artifact\n{"name": "x", "kind": "pdf", "content": "y"}\n\`\`\``;
    const v = splitResult(bad, { hideDraftBanner: true });
    expect(v.documents).toEqual([]);
    expect(v.body).toContain('```artifact');
  });
  it('several documents, in order; text between them kept', () => {
    const two = `Intro.\n\n\`\`\`artifact\n${JSON.stringify({ ...ARTIFACT, name: 'A' })}\n\`\`\`\n\nMiddle.\n\n\`\`\`artifact\n${JSON.stringify({ ...ARTIFACT, name: 'B', kind: 'json', content: '{"a":1}' })}\n\`\`\``;
    const v = splitResult(two, { hideDraftBanner: false });
    expect(v.documents.map((d) => d.name)).toEqual(['A', 'B']);
    expect(v.body).toBe('Intro.\n\nMiddle.');
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyJson('not json')).toBe('not json');
  });
});

describe('Answer tab rendering', () => {
  it('the result renders as formatted text, not raw markdown', () => {
    const html = renderToStaticMarkup(<SafeMarkdown text={REPORT} />);
    expect(html).not.toContain('###');
    expect(html).not.toContain('**');
    expect(html).toContain('<strong>1. Question</strong>');
  });
  it('the unreviewed warning is stated once, specifically, with a link to the Review tab', () => {
    const html = renderToStaticMarkup(
      <ReviewStateBadge
        run={{ requestedMode: 'reviewed', effectiveMode: 'reviewed', reviewRequired: true, reviewForced: false, reviewOutcome: 'required_unmet' }}
        detail={<>This answer has NOT been reviewed — No review — reviewer replied empty. <a href="?tab=review">What happened in the review</a></>}
      />,
    );
    expect(html).toContain('Unreviewed draft');
    expect(html).toContain('reviewer replied empty');
    expect(html).not.toContain('reviewer unavailable, failed, timed out'); // the generic blurb is replaced
  });
});
