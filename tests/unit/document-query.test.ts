import { describe, expect, it } from 'vitest';
import { expandDocumentQuery } from '@/domain/documents/documents';

/**
 * Query expansion (D-020 retrieval fix). The bug: a task brief was fed to
 * websearch_to_tsquery, which ANDs every term, so "Review Episode 1 for
 * continuity" required review+episode+1+continuity in ONE chunk and matched
 * nothing. These tests pin the normalization that makes the episode forms
 * equivalent and the OR behavior that restores recall.
 */

function tokens(text: string): Set<string> {
  return new Set(expandDocumentQuery(text).tsquery.split(' | ').filter(Boolean));
}

describe('expandDocumentQuery — episode normalization', () => {
  const forms = [
    'Episode 1',
    'Episode One',
    'Ep 1',
    'ep1',
    'E01',
    'S01E01',
    'Season 1 Episode 1',
  ];

  it('every episode form yields the S01E01 filename pattern', () => {
    for (const f of forms) {
      const { episodePatterns } = expandDocumentQuery(`Review ${f} for continuity.`);
      expect(episodePatterns, f).toContain('%S01E01%');
    }
  });

  it('every episode form yields the s01e01 lexeme for content matching', () => {
    for (const f of forms) {
      expect(tokens(`Review ${f} for continuity.`), f).toContain('s01e01');
    }
  });

  it('the query is OR-joined, not AND', () => {
    const { tsquery } = expandDocumentQuery('Review Episode 1 for continuity.');
    expect(tsquery).toContain(' | ');
    expect(tsquery).not.toContain(' & ');
  });

  it('keeps the instruction words too, so they still contribute to rank', () => {
    const t = tokens('Review Episode 1 for continuity.');
    expect(t).toContain('review');
    expect(t).toContain('continuity');
    expect(t).toContain('episode');
    expect(t).toContain('1');
  });
});

describe('expandDocumentQuery — seasons and multiples', () => {
  it('distinguishes seasons: S02E05 → %S02E05%', () => {
    const { episodePatterns } = expandDocumentQuery('Compare S02E05 with the outline');
    expect(episodePatterns).toContain('%S02E05%');
  });

  it('a bare episode number assumes season 1', () => {
    expect(expandDocumentQuery('draft episode 7').episodePatterns).toContain('%S01E07%');
  });

  it('handles two episodes in one brief', () => {
    const { episodePatterns } = expandDocumentQuery('continuity between Episode 1 and Episode 2');
    expect(episodePatterns).toContain('%S01E01%');
    expect(episodePatterns).toContain('%S01E02%');
  });

  it('word-number seasons work: Season Two Episode Three', () => {
    expect(expandDocumentQuery('Season Two Episode Three').episodePatterns).toContain('%S02E03%');
  });
});

describe('expandDocumentQuery — non-episode and edge cases', () => {
  it('a normal query has no episode patterns but still expands to tokens', () => {
    const q = expandDocumentQuery('what is our refund policy after 14 days');
    expect(q.episodePatterns).toEqual([]);
    expect(q.tsquery).toContain('refund');
    expect(q.tsquery).toContain('14');
  });

  it('empty input yields an empty query (retrieval short-circuits)', () => {
    expect(expandDocumentQuery('   ').tsquery).toBe('');
    expect(expandDocumentQuery('   ').episodePatterns).toEqual([]);
  });

  it('only lexeme-safe tokens are emitted (no tsquery syntax chars)', () => {
    const { tsquery } = expandDocumentQuery('review: "Episode 1" — (continuity?) & stuff!');
    for (const tok of tsquery.split(' | ')) {
      expect(tok).toMatch(/^[a-z0-9]+$/);
    }
  });
});
