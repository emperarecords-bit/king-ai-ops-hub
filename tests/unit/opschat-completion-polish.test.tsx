import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ExcerptMarkdown, parseExcerptBlocks } from '@/app/ops/excerpt-markdown';
import { clipLabel, cardLabelOf } from '@/domain/opschat/card-state';
import { stripDraftBanner } from '@/domain/opschat/linked-runs';
import { describeLinkedRun, RESULT_EXCERPT_CHARS } from '@/domain/opschat/linked-run-view';
import { isReportedAsCompletion } from '@/domain/opschat/conversation-continuity';
import { UNREVIEWED_DRAFT_BANNER } from '@/orchestration/engine';

/**
 * Hub prod 2026-10-22 — the first real Ops Chat completion reply (v93) worked, but: the draft banner ate the excerpt,
 * the task title was hard-cut ("…updated with you"), the excerpt showed raw markdown, and "finished" was said three
 * times (card line, reply, trailing line).
 */

const REPORT = '### RESEARCH REPORT: Dual FUSION-TEC Punch List (Rev G)\n\n**1. Question**\nProduce a finalized punch list.';

describe('draft banner is stripped before the excerpt is bounded', () => {
  it('removes the banner and the blank line after it; the total shrinks by the same amount', () => {
    const stored = `${UNREVIEWED_DRAFT_BANNER}\n\n${REPORT}`;
    const s = stripDraftBanner(stored, stored.length);
    expect(s.text).toBe(REPORT);
    expect(s.totalChars).toBe(REPORT.length);
  });
  it('leaves a result without the banner (and null) untouched', () => {
    expect(stripDraftBanner(REPORT, 999)).toEqual({ text: REPORT, totalChars: 999 });
    expect(stripDraftBanner(null, 0)).toEqual({ text: null, totalChars: 0 });
  });
  it('the bounded excerpt is then judged against the stripped length', () => {
    const v = describeLinkedRun({
      proposalId: 'p', taskId: 't', job: null, pendingApprovals: 0,
      run: { id: 'r', status: 'completed', reviewOutcome: 'required_unmet', startedAt: null, finishedAt: new Date('2026-10-22T02:00:52Z'), resultChars: REPORT.length + UNREVIEWED_DRAFT_BANNER.length + 2, errorMessage: null, excerpt: REPORT, excerptTotalChars: REPORT.length },
    });
    expect(v.excerpt).toBe(REPORT);
    expect(v.excerptTruncated).toBe(false);
    expect(v.excerpt).not.toContain('UNREVIEWED DRAFT —');
    expect(REPORT.length).toBeLessThan(RESULT_EXCERPT_CHARS);
  });
});

describe('labels are cut at a word boundary with an ellipsis', () => {
  const title = 'Server Cabinet Cooling — Dual FUSION-TEC Punch List & Vendor Quote Prep — updated with your answers';
  it('the prod title now fits whole in a dispatch label', () => {
    expect(cardLabelOf('dispatch_task', { title, agentName: 'Research Analyst' })).toBe(`dispatch "${title}" to Research Analyst`);
  });
  it('a long title is clipped on a word, never mid-word, and marked', () => {
    const long = `${title} ${'and more words '.repeat(10)}`.trim();
    const label = cardLabelOf('dispatch_task', { title: long });
    expect(label.endsWith('…"')).toBe(true);
    expect(label.length).toBeLessThanOrEqual('dispatch ""'.length + 140);
    expect(clipLabel('updated with your answers', 20)).toBe('updated with your…');
    expect(clipLabel('short', 20)).toBe('short');
    expect(clipLabel('Supercalifragilisticexpialidocious', 10)).toBe('Supercali…');
  });
  it('identifiers keep their exact length (never clipped)', () => {
    const id = '68647a45-b5cd-48d3-96a4-36421967183a';
    expect(cardLabelOf('rerun_task', { taskId: id })).toBe(`re-run "${id}"`);
  });
});

describe('ExcerptMarkdown — minimal, safe rendering of untrusted output', () => {
  it('renders headings, bold, lists and quotes instead of raw markdown', () => {
    const html = renderToStaticMarkup(
      <ExcerptMarkdown text={'### Findings\n*   **Sequencing:** Lead-Lag [Source: Owner Decision]\n    *   *Option A:* 36" x 16"\n> note'} />,
    );
    expect(html).toContain('Findings');
    expect(html).not.toContain('###');
    expect(html).toContain('<strong>Sequencing:</strong>');
    expect(html).toContain('<em>Option A:</em>');
    expect(html).toContain('<blockquote');
    expect(html).not.toContain('**');
  });
  it('never renders links, images or HTML — link text only, everything escaped', () => {
    const html = renderToStaticMarkup(
      <ExcerptMarkdown text={'See [the portal](https://evil.example/login) ![x](https://evil.example/i.png)\n<script>alert(1)</script> <a href="https://evil.example">hi</a>'} />,
    );
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toContain('href="'); // only the escaped text `href=&quot;…` may appear
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example/login');
    expect(html).toContain('the portal');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('a fenced block (even one cut off by the excerpt bound) is shown as code', () => {
    const blocks = parseExcerptBlocks('Intro\n```artifact\n{"name": "Punch List"');
    expect(blocks.map((b) => b.kind)).toEqual(['para', 'code']);
  });
});

describe('"finished" is said once', () => {
  it('a card whose run is reported as a completion entry gets only a pointer', () => {
    expect(isReportedAsCompletion({ state: 'draft', runId: 'r', finishedAt: '2026-10-22T02:00:52Z' })).toBe(true);
    expect(isReportedAsCompletion({ state: 'running', runId: 'r', finishedAt: null })).toBe(false);
    expect(isReportedAsCompletion({ state: 'no_run', runId: null, finishedAt: null })).toBe(false);
    expect(isReportedAsCompletion(null)).toBe(false);
  });
});
