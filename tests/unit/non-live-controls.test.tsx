import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ClassificationChip, NonLiveControls } from '@/app/p/[projectKey]/non-live-controls';

/**
 * HUB-009 Gate 3B — real component render tests for the shared visibility control + classification chip.
 * These render the actual components (not just helpers) and assert the emitted markup.
 */

describe('ClassificationChip', () => {
  it('labels demo and seed rows and renders nothing for live', () => {
    expect(renderToStaticMarkup(<ClassificationChip classification="demo" />)).toContain('Demo');
    expect(renderToStaticMarkup(<ClassificationChip classification="seed" />)).toContain('Seed');
    expect(renderToStaticMarkup(<ClassificationChip classification="live" />)).toBe('');
  });
});

describe('NonLiveControls', () => {
  const base = { pathname: '/p/x/work', searchParams: { tab: 'active' } as Record<string, string | string[] | undefined> };

  it('default (live-only): shows "Show demo/seed data" preserving other params, and the exclusion note', () => {
    const html = renderToStaticMarkup(
      <NonLiveControls {...base} includeNonLive={false} excluded={{ demo: 3, seed: 2, total: 5 }} />,
    );
    expect(html).toContain('Show demo/seed data');
    expect(html).toContain('includeNonLive=1');
    expect(html).toContain('tab=active'); // unrelated param preserved in the toggle link
    expect(html).toContain('3 demo + 2 seed records excluded');
    expect(html).not.toContain('Hide demo/seed data');
  });

  it('no exclusion note is rendered when nothing was excluded', () => {
    const html = renderToStaticMarkup(<NonLiveControls {...base} includeNonLive={false} excluded={{ demo: 0, seed: 0, total: 0 }} />);
    expect(html).not.toContain('excluded');
    expect(html).toContain('Show demo/seed data');
  });

  it('enabled: shows "Hide" whose link drops includeNonLive but keeps other params; no note', () => {
    const html = renderToStaticMarkup(
      <NonLiveControls pathname="/p/x/work" searchParams={{ includeNonLive: '1', tab: 'active' }} includeNonLive={true} excluded={{ demo: 3, seed: 0, total: 3 }} />,
    );
    expect(html).toContain('Hide demo/seed data');
    expect(html).toContain('tab=active');
    expect(html).not.toContain('includeNonLive=1'); // the hide link removes it
    expect(html).not.toContain('records excluded'); // no note while showing
  });
});
