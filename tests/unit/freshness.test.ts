import { describe, expect, it } from 'vitest';
import { compareFreshness, parseEffectiveDate } from '@/domain/context/freshness';

/**
 * Freshness parsing and comparison (O-17). Conservative by design: only
 * explicit labeled dates are parsed; a bare year in prose, a file mtime, or the
 * run clock are never treated as content-effective dates.
 */

describe('parseEffectiveDate — accepts explicit labeled patterns', () => {
  it('Status as of Month D, YYYY', () => {
    expect(parseEffectiveDate('# Report\n\nStatus as of July 23, 2026\n\nBody')).toBe('2026-07-23');
  });
  it('Last updated: ISO', () => {
    expect(parseEffectiveDate('Last updated: 2026-07-23')).toBe('2026-07-23');
  });
  it('Effective date: US slash', () => {
    expect(parseEffectiveDate('Effective date: 07/23/2026')).toBe('2026-07-23');
  });
  it('as of ISO, case-insensitive', () => {
    expect(parseEffectiveDate('AS OF 2026-07-20')).toBe('2026-07-20');
  });
  it('long form without comma', () => {
    expect(parseEffectiveDate('Effective: March 5 2026')).toBe('2026-03-05');
  });
});

describe('parseEffectiveDate — rejects unreliable dates', () => {
  it('a bare year in narrative is not a date', () => {
    expect(parseEffectiveDate('The kingdom fell in 2026 after a long siege.')).toBeNull();
  });
  it('a date with no recognized label is not accepted', () => {
    expect(parseEffectiveDate('Shot on 2026-07-23 at the castle.')).toBeNull();
  });
  it('an out-of-range date is rejected', () => {
    expect(parseEffectiveDate('Effective date: 07/45/2026')).toBeNull();
  });
  it('empty input', () => {
    expect(parseEffectiveDate('')).toBeNull();
  });
  it('a label deep in the body (beyond the header scan) is ignored', () => {
    const long = 'x'.repeat(2100) + '\nLast updated: 2026-07-23';
    expect(parseEffectiveDate(long)).toBeNull();
  });
});

describe('compareFreshness — Hub vs document relation', () => {
  const hub = (d: string) => ({ sourceUpdatedAt: `${d}T00:00:00Z`, confidence: 'high' as const, basis: 'hub' });
  const docEffective = (d: string) => ({ contentEffectiveAt: d, confidence: 'high' as const, basis: 'parsed' });
  const docMtimeOnly = (d: string) => ({ sourceUpdatedAt: `${d}T00:00:00Z`, confidence: 'medium' as const, basis: 'mtime' });

  it('hub_newer when the Hub date is later', () => {
    const c = compareFreshness(hub('2026-07-23'), docEffective('2026-07-20'));
    expect(c.relation).toBe('hub_newer');
    expect(c.explanation).toMatch(/newer than the document/i);
  });

  it('document_newer when the document effective date is later', () => {
    const c = compareFreshness(hub('2026-07-20'), docEffective('2026-07-23'));
    expect(c.relation).toBe('document_newer');
  });

  it('same_date when calendar days match', () => {
    expect(compareFreshness(hub('2026-07-23'), docEffective('2026-07-23')).relation).toBe('same_date');
  });

  it('prefers a parsed effective date over the document mtime', () => {
    // Doc mtime is newer, but its parsed effective date is older → document is
    // effectively older, so Hub is newer.
    const c = compareFreshness(hub('2026-07-22'), {
      ...docMtimeOnly('2026-07-25'),
      contentEffectiveAt: '2026-07-20',
    });
    expect(c.relation).toBe('hub_newer');
  });

  it('not_comparable when the document has only... nothing usable', () => {
    const c = compareFreshness(hub('2026-07-23'), { confidence: 'unknown', basis: 'no date' });
    expect(c.relation).toBe('not_comparable');
    expect(c.explanation).toMatch(/cannot be directly compared/i);
  });

  it('not_comparable when the Hub side has no date', () => {
    expect(compareFreshness(null, docEffective('2026-07-23')).relation).toBe('not_comparable');
  });
});
