import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { DetailKnowledgeRef, DetailLifecycleEvent, DetailRunRef } from '@/domain/documents/detail';
import { AiOperationsSection, HistorySection, KnowledgeSection } from '@/app/p/[projectKey]/documents/[documentId]/detail-view';
import { mayRelease } from '@/app/p/[projectKey]/documents/[documentId]/download/route';

/**
 * Render-level coverage for the read-only Detail UI (P2 blockers 2/3/4). These sections use no client link
 * or DB, so they render to static markup directly and we assert the exact copy the operator sees.
 */

const render = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('Detail view — Knowledge relationship states (Blocker 2)', () => {
  it('renders relied_upon and attached_not_judged with the exact required copy, never inferring supplemental', () => {
    const refs: DetailKnowledgeRef[] = [
      { knowledgeSourceId: 's1', knowledgeItemId: 'i1', knowledgeItemTitle: 'Relied item', knowledgeVersion: 1, role: 'quoted', relationshipState: 'relied_upon', documentVersionId: 'v1', versionHash: 'h', currentlyInspectable: true },
      { knowledgeSourceId: 's2', knowledgeItemId: 'i2', knowledgeItemTitle: 'Attached item', knowledgeVersion: 1, role: 'summarized', relationshipState: 'attached_not_judged', documentVersionId: 'v1', versionHash: 'h', currentlyInspectable: true },
    ];
    const html = render(createElement(KnowledgeSection, { refs }));
    expect(html).toContain('Relied item');
    expect(html).toContain('Relied upon');
    expect(html).toContain('Attached item');
    expect(html).toContain('Attached source; support not judged');
    // The unjudged source is NOT labeled supplemental.
    expect(html).not.toContain('Supplemental');
  });

  it('labels supplemental ONLY when the state is explicitly supplemental (never from absence of reliance)', () => {
    const attached: DetailKnowledgeRef[] = [
      { knowledgeSourceId: 's', knowledgeItemId: 'i', knowledgeItemTitle: 'X', knowledgeVersion: 1, role: 'quoted', relationshipState: 'attached_not_judged', documentVersionId: 'v', versionHash: 'h', currentlyInspectable: false },
    ];
    expect(render(createElement(KnowledgeSection, { refs: attached }))).not.toContain('Supplemental');
  });
});

describe('Detail view — AI execution rendering (Blocker 3)', () => {
  it('renders the recorded primary dispatch provider/model', () => {
    const ops: DetailRunRef[] = [
      { runId: 'r1', runStatus: 'completed', dispatchAt: new Date('2026-07-27T10:00:00Z'), provider: 'anthropic', model: 'claude-dispatch', suppliedVersions: [{ documentVersionId: 'v1', versionHash: 'abc', suppliedChunkCount: 2, dispatchDisclosureSnapshot: 'workspace_internal' }] },
    ];
    const html = render(createElement(AiOperationsSection, { ops }));
    expect(html).toContain('provider: anthropic');
    expect(html).toContain('model: claude-dispatch');
    expect(html).toContain('2 chunks supplied');
    expect(html).not.toContain('Not recorded');
  });

  it('renders "Not recorded" only when immutable execution facts are absent', () => {
    const ops: DetailRunRef[] = [
      { runId: 'r1', runStatus: 'failed', dispatchAt: new Date('2026-07-27T10:00:00Z'), provider: null, model: null, suppliedVersions: [{ documentVersionId: 'v1', versionHash: 'abc', suppliedChunkCount: 1, dispatchDisclosureSnapshot: 'workspace_internal' }] },
    ];
    const html = render(createElement(AiOperationsSection, { ops }));
    expect(html).toContain('provider: Not recorded');
    expect(html).toContain('model: Not recorded');
    expect(html).toContain('(failed)'); // a failed run still shows, with its recorded status
  });
});

describe('Detail download — GET never releases restricted content', () => {
  it('a GET may release only NON-restricted content; a POST (deliberate) may release restricted', () => {
    expect(mayRelease('GET', false)).toBe(true); // non-restricted GET download allowed
    expect(mayRelease('GET', true)).toBe(false); // restricted GET download refused (before any release/audit)
    expect(mayRelease('POST', true)).toBe(true); // restricted release only by the deliberate POST
    expect(mayRelease('POST', false)).toBe(true);
  });
});

describe('Detail view — lifecycle history rendering (Blocker 4)', () => {
  it('renders document-scoped and version-scoped events, attributing version events to the exact version, in given order', () => {
    const events: DetailLifecycleEvent[] = [
      { kind: 'restored', action: 'document.restored', at: new Date('2026-07-27T12:00:00Z'), actorId: 'u', documentVersionId: null, detail: {} },
      { kind: 'index_degraded', action: 'document.version_index_degraded', at: new Date('2026-07-27T11:00:00Z'), actorId: 'u', documentVersionId: 'abcdef1234', detail: {} },
      { kind: 'purged', action: 'document.version_purged', at: new Date('2026-07-27T10:00:00Z'), actorId: 'u', documentVersionId: 'zzz99999', detail: {} },
    ];
    const html = render(createElement(HistorySection, { events }));
    expect(html).toContain('restored'); // document-scoped
    expect(html).toContain('index degraded'); // version-scoped, humanized
    expect(html).toContain('version abcdef12'); // attributed to the exact version (shortId)
    expect(html).toContain('purged');
    // Deterministic order: restored (newest) appears before index degraded before purged.
    expect(html.indexOf('restored')).toBeLessThan(html.indexOf('index degraded'));
    expect(html.indexOf('index degraded')).toBeLessThan(html.indexOf('purged'));
  });

  it('renders content-free events (no source content or raw detail leaks into the summary line)', () => {
    const events: DetailLifecycleEvent[] = [
      { kind: 'restricted_inspected', action: 'document.restricted_inspected', at: new Date('2026-07-27T12:00:00Z'), actorId: 'u', documentVersionId: 'v1', detail: { accessType: 'download' } },
    ];
    const html = render(createElement(HistorySection, { events }));
    expect(html).toContain('restricted inspected');
    expect(html).not.toContain('download'); // technical detail is not dumped into the visible summary
  });
});
